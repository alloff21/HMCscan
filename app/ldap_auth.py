"""Active Directory sign-in over LDAP(S).

Flow: bind with the service account, find the user, read the groups the user is in
(nested groups included), check the password with a bind as the user, and map the
groups to a HMCscan role.
"""
from __future__ import annotations

import ssl
from dataclasses import dataclass

from ldap3 import Connection, Server, ServerPool, Tls, FIRST
from ldap3.core.exceptions import LDAPException
from ldap3.utils.conv import escape_filter_chars

from .security import Vault

ROLE_RANK = {"viewer": 1, "admin": 2}
NESTED_MEMBER = "1.2.840.113556.1.4.1941"  # LDAP_MATCHING_RULE_IN_CHAIN

DEFAULT_AD = {
    "enabled": False, "domain": "", "servers": "", "base_dn": "", "bind_dn": "", "bind_password_enc": "",
    "user_filter": "(sAMAccountName={login})", "tls_mode": "verify", "ca_pem": "", "groups": [],
}


class ADError(Exception):
    pass


@dataclass
class ADUser:
    login: str
    dn: str
    name: str
    groups: list[str]
    role: str | None
    via_group: str


def _pool(cfg: dict) -> ServerPool:
    urls = [u.strip() for u in cfg["servers"].replace(";", ",").split(",") if u.strip()]
    if not urls:
        raise ADError("Не указаны контроллеры домена")
    tls = None
    if cfg.get("tls_mode") == "none":
        tls = Tls(validate=ssl.CERT_NONE)
    elif cfg.get("tls_mode") == "ca" and cfg.get("ca_pem", "").strip():
        tls = Tls(validate=ssl.CERT_REQUIRED, ca_certs_data=cfg["ca_pem"])
    else:
        tls = Tls(validate=ssl.CERT_REQUIRED)
    servers = [Server(u, use_ssl=u.lower().startswith("ldaps://"), tls=tls, connect_timeout=8) for u in urls]
    return ServerPool(servers, FIRST, active=1, exhaust=True)


def map_role(groups: list[str], mapping: list[dict]) -> tuple[str | None, str]:
    lower = {g.lower() for g in groups}
    best, via = None, ""
    for m in mapping:
        dn = (m.get("dn") or "").strip()
        if dn and dn.lower() in lower and ROLE_RANK.get(m.get("role"), 0) > ROLE_RANK.get(best, 0):
            best, via = m["role"], dn.split(",")[0].removeprefix("CN=").removeprefix("cn=")
    return best, via


def authenticate(cfg: dict, vault: Vault, login: str, password: str) -> ADUser:
    if not password:
        raise ADError("Пустой пароль")  # an empty password would be an anonymous bind
    login = login.split("\\")[-1].split("@")[0].strip()
    pool = _pool(cfg)
    bind_pw = vault.decrypt(cfg["bind_password_enc"]) if cfg.get("bind_password_enc") else ""
    try:
        svc = Connection(pool, user=cfg["bind_dn"], password=bind_pw, auto_bind=True, receive_timeout=15)
    except LDAPException as e:
        raise ADError(f"Сервисная учётка не смогла войти в AD: {e}") from e
    try:
        flt = cfg["user_filter"].replace("{login}", escape_filter_chars(login))
        svc.search(cfg["base_dn"], flt, attributes=["displayName", "memberOf", "userAccountControl"], size_limit=2)
        if len(svc.entries) != 1:
            raise ADError("Пользователь не найден в AD")
        entry = svc.entries[0]
        dn = entry.entry_dn
        name = str(entry.displayName) if "displayName" in entry and entry.displayName.value else login
        svc.search(cfg["base_dn"], f"(member:{NESTED_MEMBER}:={escape_filter_chars(dn)})", attributes=[])
        groups = [e.entry_dn for e in svc.entries]
        if not groups and "memberOf" in entry:
            groups = list(entry.memberOf.values)
    except LDAPException as e:
        raise ADError(f"Ошибка поиска в AD: {e}") from e
    finally:
        svc.unbind()
    try:
        user_conn = Connection(pool, user=dn, password=password, auto_bind=True, receive_timeout=15)
        user_conn.unbind()
    except LDAPException as e:
        raise ADError("Неверный пароль или учётная запись заблокирована") from e
    role, via = map_role(groups, cfg.get("groups", []))
    return ADUser(login=login, dn=dn, name=name, groups=groups, role=role, via_group=via)


def lookup(cfg: dict, vault: Vault, login: str) -> ADUser:
    """Check settings without the user's password: find the user and their role."""
    login = login.split("\\")[-1].split("@")[0].strip()
    pool = _pool(cfg)
    bind_pw = vault.decrypt(cfg["bind_password_enc"]) if cfg.get("bind_password_enc") else ""
    try:
        svc = Connection(pool, user=cfg["bind_dn"], password=bind_pw, auto_bind=True, receive_timeout=15)
    except LDAPException as e:
        raise ADError(f"Сервисная учётка не смогла войти в AD: {e}") from e
    try:
        svc.search(cfg["base_dn"], cfg["user_filter"].replace("{login}", escape_filter_chars(login)),
                   attributes=["displayName"], size_limit=2)
        if len(svc.entries) != 1:
            raise ADError("Пользователь не найден в AD")
        entry = svc.entries[0]
        dn = entry.entry_dn
        name = str(entry.displayName) if entry.displayName.value else login
        svc.search(cfg["base_dn"], f"(member:{NESTED_MEMBER}:={escape_filter_chars(dn)})", attributes=[])
        groups = [e.entry_dn for e in svc.entries]
    except LDAPException as e:
        raise ADError(f"Ошибка поиска в AD: {e}") from e
    finally:
        svc.unbind()
    role, via = map_role(groups, cfg.get("groups", []))
    return ADUser(login=login, dn=dn, name=name, groups=groups, role=role, via_group=via)
