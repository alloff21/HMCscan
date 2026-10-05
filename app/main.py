"""HMCscan web application: REST API under /api and the single-page UI under /."""
from __future__ import annotations

import csv
import io
import logging
import secrets
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.concurrency import run_in_threadpool
from starlette.middleware.sessions import SessionMiddleware

from . import config, inventory
from .db import DB
from .hmc_client import HMCError
from .ldap_auth import DEFAULT_AD, ADError, authenticate as ad_authenticate, lookup as ad_lookup
from .poller import Poller, collect, now_iso
from .security import Vault, hash_password, load_secret, verify_password

log = logging.getLogger("hmcscan")
STATIC = Path(__file__).parent / "static"
VERSION = "1.0.0"


# ---------- request models ----------

class LoginIn(BaseModel):
    login: str = Field(min_length=1, max_length=128)
    password: str = Field(max_length=256)
    source: Literal["ad", "local"] = "ad"


class DCIn(BaseModel):
    code: str = Field(min_length=1, max_length=32)
    name: str = Field(min_length=1, max_length=128)
    address: str = Field(default="", max_length=256)

    @field_validator("code", "name", "address")
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()


class HMCIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    host: str = Field(min_length=1, max_length=255)
    port: int = Field(default=12443, ge=1, le=65535)
    dc_id: int | None = None
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(default="", max_length=256)  # empty on update = keep the stored one
    tls_mode: Literal["verify", "ca", "none"] = "verify"
    ca_pem: str = Field(default="", max_length=65536)
    interval_min: int = Field(default=15, ge=1, le=1440)
    enabled: bool = True

    @field_validator("name", "host", "username")
    @classmethod
    def strip(cls, v: str) -> str:
        return v.strip()


class HMCTestIn(HMCIn):
    id: int | None = None
    name: str = "test"
    dc_id: int | None = None


class UserIn(BaseModel):
    login: str = Field(min_length=1, max_length=128)
    name: str = Field(default="", max_length=128)
    role: Literal["admin", "viewer"] = "viewer"
    password: str = Field(default="", max_length=256)
    enabled: bool = True
    role_locked: bool = False


class GroupMap(BaseModel):
    dn: str = Field(min_length=3, max_length=512)
    role: Literal["admin", "viewer"]


class ADIn(BaseModel):
    enabled: bool = False
    domain: str = Field(default="", max_length=64)
    servers: str = Field(default="", max_length=1024)
    base_dn: str = Field(default="", max_length=512)
    bind_dn: str = Field(default="", max_length=512)
    bind_password: str = Field(default="", max_length=256)  # empty = keep
    user_filter: str = Field(default="(sAMAccountName={login})", max_length=512)
    tls_mode: Literal["verify", "ca", "none"] = "verify"
    ca_pem: str = Field(default="", max_length=65536)
    groups: list[GroupMap] = []


class ADTestIn(BaseModel):
    login: str = Field(min_length=1, max_length=128)
    password: str = Field(default="", max_length=256)


# ---------- app factory ----------

def create_app(data_dir: Path | None = None, start_poller: bool = True) -> FastAPI:
    data_dir = Path(data_dir or config.DATA_DIR)
    data_dir.mkdir(parents=True, exist_ok=True)
    db = DB(data_dir / "hmcscan.db")
    secret = load_secret(data_dir, config.SECRET_KEY)
    vault = Vault(secret)
    _bootstrap(db, vault)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.poller = Poller(db, vault)
        if start_poller:
            app.state.poller.start()
        yield
        await app.state.poller.stop()

    app = FastAPI(title="HMCscan", version=VERSION, lifespan=lifespan, docs_url=None, redoc_url=None)
    app.add_middleware(SessionMiddleware, secret_key=secret, session_cookie="hmcscan",
                       max_age=config.SESSION_HOURS * 3600, same_site="strict", https_only=config.TLS)
    app.state.db, app.state.vault = db, vault
    failures: dict[str, list[float]] = {}

    # ----- auth helpers -----
    def current_user(request: Request) -> dict:
        uid = request.session.get("uid")
        user = db.one("SELECT id, login, name, source, role, enabled FROM users WHERE id=?", uid) if uid else None
        if not user or not user["enabled"]:
            request.session.clear()
            raise HTTPException(401, "Требуется вход")
        return user

    def admin(user: dict = Depends(current_user)) -> dict:
        if user["role"] != "admin":
            raise HTTPException(403, "Нужна роль «Администратор»")
        return user

    def throttle(key: str) -> None:
        now = time.monotonic()
        recent = [t for t in failures.get(key, []) if now - t < 300]
        failures[key] = recent
        if len(recent) >= 5:
            raise HTTPException(429, "Слишком много неудачных попыток. Подождите 5 минут.")

    @app.middleware("http")
    async def no_cache_api(request: Request, call_next):
        resp = await call_next(request)
        if request.url.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        return resp

    # ----- auth -----
    @app.get("/healthz", include_in_schema=False)
    def healthz():
        return {"ok": True, "version": VERSION}

    @app.get("/api/auth/config")
    def auth_config():
        ad = db.get_setting("ad", DEFAULT_AD)
        return {"ad_enabled": bool(ad.get("enabled")), "domain": ad.get("domain", ""), "version": VERSION, "demo": config.DEMO}

    @app.post("/api/auth/login")
    async def login(body: LoginIn, request: Request):
        key = f"{request.client.host if request.client else '-'}|{body.login.lower()}"
        throttle(key)
        user = None
        if body.source == "local":
            row = db.one("SELECT * FROM users WHERE login=? AND source='local'", body.login.strip())
            if row and row["pw_hash"] and verify_password(body.password, row["pw_hash"]):
                user = row
        else:
            ad = db.get_setting("ad", DEFAULT_AD)
            if not ad.get("enabled"):
                raise HTTPException(400, "Вход через Active Directory выключен")
            try:
                adu = await run_in_threadpool(ad_authenticate, ad, vault, body.login, body.password)
            except ADError as e:
                failures.setdefault(key, []).append(time.monotonic())
                log.info("AD: вход %s отклонён: %s", body.login, e)
                raise HTTPException(401, "Неверный логин или пароль") from None
            row = db.one("SELECT * FROM users WHERE login=?", adu.login)
            if row and row["source"] == "local":
                raise HTTPException(409, "Есть локальная учётка с тем же логином. Войдите как локальный пользователь.")
            role = row["role"] if row and row["role_locked"] else adu.role
            if not role:
                raise HTTPException(403, "Нет доступа: учётная запись не входит ни в одну группу AD, которой разрешён вход")
            if row:
                db.run("UPDATE users SET name=?, role=?, via_group=? WHERE id=?", adu.name, role,
                       adu.via_group if not row["role_locked"] else row["via_group"], row["id"])
            else:
                db.run("INSERT INTO users(login,name,source,role,via_group) VALUES(?,?,?,?,?)",
                       adu.login, adu.name, "ad", role, adu.via_group)
            user = db.one("SELECT * FROM users WHERE login=?", adu.login)
        if not user:
            failures.setdefault(key, []).append(time.monotonic())
            raise HTTPException(401, "Неверный логин или пароль")
        if not user["enabled"]:
            raise HTTPException(403, "Учётная запись заблокирована администратором")
        failures.pop(key, None)
        db.run("UPDATE users SET last_login=? WHERE id=?", now_iso(), user["id"])
        request.session.clear()
        request.session["uid"] = user["id"]
        return {"login": user["login"], "name": user["name"], "role": user["role"], "source": user["source"]}

    @app.post("/api/auth/logout")
    def logout(request: Request):
        request.session.clear()
        return {"ok": True}

    @app.get("/api/auth/me")
    def me(user: dict = Depends(current_user)):
        return user

    # ----- inventory -----
    @app.get("/api/overview")
    def get_overview(request: Request, _: dict = Depends(current_user)):
        data = inventory.overview(inventory.load(db))
        poller: Poller = request.app.state.poller
        for h in data["hmcs"]:
            h["polling"] = poller.is_running(h["id"])
        return data

    @app.get("/api/hmcs/{hmc_id}/servers")
    def get_hmc_servers(hmc_id: int, _: dict = Depends(current_user)):
        data = inventory.hmc_servers(inventory.load(db), hmc_id)
        if data is None:
            raise HTTPException(404, "HMC не найдена")
        return data

    @app.get("/api/servers/{key}")
    def get_server(key: str, _: dict = Depends(current_user)):
        data = inventory.server_detail(inventory.load(db), key)
        if data is None:
            raise HTTPException(404, "Сервер не найден")
        return data

    @app.get("/api/lpars")
    def get_lpars(_: dict = Depends(current_user)):
        inv = inventory.load(db)
        return {"dcs": inv.dcs, "hmcs": [{"id": h["id"], "name": h["name"]} for h in inv.hmcs],
                "lpars": inventory.all_lpars(inv)}

    @app.get("/api/export/lpars.csv")
    def export_csv(_: dict = Depends(current_user)):
        rows = inventory.all_lpars(inventory.load(db))
        buf = io.StringIO()
        w = csv.writer(buf, delimiter=";")
        w.writerow(["LPAR", "ID", "ЦОД", "HMC", "Сервер", "Тип", "ОС", "Состояние", "Режим CPU", "Пул", "Вес",
                    "EC мин", "EC жел", "EC макс", "EC тек", "vCPU мин", "vCPU жел", "vCPU макс", "vCPU тек",
                    "RAM мин ГБ", "RAM жел ГБ", "RAM макс ГБ", "RAM тек ГБ", "AME", "Совместимость", "SRR", "RMC", "RMC IP"])
        dec = lambda v: "" if v is None else str(v).replace(".", ",")
        # values starting with = + - @ would run as formulas in Excel
        safe = lambda v: "'" + v if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v
        for l in rows:
            vp = l["vp"] or {}
            w.writerow(map(safe, [l["name"], l["id"], l["dc"], l["hmc"], l["server"], l["type"], l["os"], l["state"], l["mode"],
                        l["pool"], l["weight"], dec(l["ec"]["min"]), dec(l["ec"]["des"]), dec(l["ec"]["max"]), dec(l["ec"]["cur"]),
                        vp.get("min"), vp.get("des"), vp.get("max"), vp.get("cur"),
                        dec(l["mem"]["min"]), dec(l["mem"]["des"]), dec(l["mem"]["max"]), dec(l["mem"]["cur"]),
                        dec(l["ame"]), l["compat"], l["srr"], l["rmc"], l["rmc_ip"]]))
        name = f"hmcscan-lpars-{time.strftime('%Y%m%d-%H%M')}.csv"
        return Response("﻿" + buf.getvalue(), media_type="text/csv; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{name}"'})

    @app.post("/api/poll")
    async def poll_all(request: Request, _: dict = Depends(admin)):
        return {"started": request.app.state.poller.trigger_all()}

    # ----- admin: datacenters -----
    @app.get("/api/admin/datacenters")
    def list_dcs(_: dict = Depends(admin)):
        return db.all("SELECT d.*, (SELECT COUNT(*) FROM hmcs h WHERE h.dc_id=d.id) AS hmc_count "
                      "FROM datacenters d ORDER BY d.code")

    @app.post("/api/admin/datacenters", status_code=201)
    def create_dc(body: DCIn, _: dict = Depends(admin)):
        if db.one("SELECT 1 FROM datacenters WHERE code=?", body.code):
            raise HTTPException(409, f"ЦОД с кодом {body.code} уже есть")
        return {"id": db.run("INSERT INTO datacenters(code,name,address) VALUES(?,?,?)", body.code, body.name, body.address)}

    @app.put("/api/admin/datacenters/{dc_id}")
    def update_dc(dc_id: int, body: DCIn, _: dict = Depends(admin)):
        if db.one("SELECT 1 FROM datacenters WHERE code=? AND id<>?", body.code, dc_id):
            raise HTTPException(409, f"ЦОД с кодом {body.code} уже есть")
        db.run("UPDATE datacenters SET code=?, name=?, address=? WHERE id=?", body.code, body.name, body.address, dc_id)
        return {"ok": True}

    @app.delete("/api/admin/datacenters/{dc_id}")
    def delete_dc(dc_id: int, _: dict = Depends(admin)):
        n = db.one("SELECT COUNT(*) AS n FROM hmcs WHERE dc_id=?", dc_id)["n"]
        if n:
            raise HTTPException(409, f"К ЦОД привязано HMC: {n}. Сначала перенесите их в другой ЦОД.")
        db.run("DELETE FROM datacenters WHERE id=?", dc_id)
        return {"ok": True}

    # ----- admin: HMC connections -----
    def _check_hmc(body: HMCIn, hmc_id: int | None) -> None:
        if not body.dc_id or not db.one("SELECT 1 FROM datacenters WHERE id=?", body.dc_id):
            raise HTTPException(422, "Укажите ЦОД: без него HMC не попадёт в сводные отчёты")
        if db.one("SELECT 1 FROM hmcs WHERE name=? AND id IS NOT ?", body.name, hmc_id):
            raise HTTPException(409, f"HMC с именем {body.name} уже есть")
        if body.tls_mode == "ca" and "BEGIN CERTIFICATE" not in body.ca_pem:
            raise HTTPException(422, "Для проверки по своему CA вставьте сертификат в формате PEM")

    @app.get("/api/admin/hmcs")
    def list_hmcs(request: Request, _: dict = Depends(admin)):
        rows = db.all("SELECT h.id, h.name, h.host, h.port, h.dc_id, h.username, h.tls_mode, h.ca_pem, h.interval_min, "
                      "h.enabled, s.status, s.error, s.attempted_at, s.polled_at, s.duration_s "
                      "FROM hmcs h LEFT JOIN snapshots s ON s.hmc_id=h.id ORDER BY h.name")
        inv = {h["id"]: h for h in inventory.load(db).hmcs}
        for r in rows:
            r["version"] = inv.get(r["id"], {}).get("version")
            r["status"] = r["status"] or "pending"
            r["polling"] = request.app.state.poller.is_running(r["id"])
        return rows

    @app.post("/api/admin/hmcs", status_code=201)
    async def create_hmc(body: HMCIn, request: Request, _: dict = Depends(admin)):
        _check_hmc(body, None)
        if not body.password:
            raise HTTPException(422, "Укажите пароль пользователя HMC")
        hid = db.run("INSERT INTO hmcs(name,host,port,dc_id,username,password_enc,tls_mode,ca_pem,interval_min,enabled) "
                     "VALUES(?,?,?,?,?,?,?,?,?,?)", body.name, body.host, body.port, body.dc_id, body.username,
                     vault.encrypt(body.password), body.tls_mode, body.ca_pem, body.interval_min, int(body.enabled))
        if body.enabled:
            request.app.state.poller.trigger(hid)
        return {"id": hid}

    @app.put("/api/admin/hmcs/{hmc_id}")
    async def update_hmc(hmc_id: int, body: HMCIn, request: Request, _: dict = Depends(admin)):
        if not db.one("SELECT 1 FROM hmcs WHERE id=?", hmc_id):
            raise HTTPException(404, "HMC не найдена")
        _check_hmc(body, hmc_id)
        db.run("UPDATE hmcs SET name=?, host=?, port=?, dc_id=?, username=?, tls_mode=?, ca_pem=?, interval_min=?, enabled=? "
               "WHERE id=?", body.name, body.host, body.port, body.dc_id, body.username, body.tls_mode, body.ca_pem,
               body.interval_min, int(body.enabled), hmc_id)
        if body.password:
            db.run("UPDATE hmcs SET password_enc=? WHERE id=?", vault.encrypt(body.password), hmc_id)
        if body.enabled:
            request.app.state.poller.trigger(hmc_id)
        return {"ok": True}

    @app.delete("/api/admin/hmcs/{hmc_id}")
    def delete_hmc(hmc_id: int, _: dict = Depends(admin)):
        db.run("DELETE FROM hmcs WHERE id=?", hmc_id)
        return {"ok": True}

    @app.post("/api/admin/hmcs/test")
    async def test_hmc(body: HMCTestIn, _: dict = Depends(admin)):
        password = body.password
        if not password and body.id:
            row = db.one("SELECT password_enc FROM hmcs WHERE id=?", body.id)
            password = vault.decrypt(row["password_enc"]) if row else ""
        if not password:
            raise HTTPException(422, "Укажите пароль для проверки")
        try:
            data = await collect(body.host, body.port, body.username, password, body.tls_mode, body.ca_pem)
        except HMCError as e:
            return JSONResponse({"ok": False, "error": str(e)})
        return {"ok": True, "console": data["console"], "servers": len(data["systems"]),
                "lpars": sum(len(s["lpars"]) for s in data["systems"]), "warnings": data["warnings"],
                "duration_s": data["duration_s"]}

    @app.post("/api/admin/hmcs/{hmc_id}/poll")
    async def poll_one(hmc_id: int, request: Request, _: dict = Depends(admin)):
        return {"started": request.app.state.poller.trigger(hmc_id)}

    # ----- admin: users -----
    def _admins_left(excluding: int) -> int:
        return db.one("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND enabled=1 AND id<>?", excluding)["n"]

    @app.get("/api/admin/users")
    def list_users(_: dict = Depends(admin)):
        return db.all("SELECT id, login, name, source, role, role_locked, enabled, via_group, last_login "
                      "FROM users ORDER BY source DESC, login")

    @app.post("/api/admin/users", status_code=201)
    def create_user(body: UserIn, _: dict = Depends(admin)):
        if db.one("SELECT 1 FROM users WHERE login=?", body.login.strip()):
            raise HTTPException(409, "Пользователь с таким логином уже есть")
        if len(body.password) < 8:
            raise HTTPException(422, "Пароль должен быть не короче 8 символов")
        uid = db.run("INSERT INTO users(login,name,source,role,pw_hash,enabled) VALUES(?,?,?,?,?,?)",
                     body.login.strip(), body.name.strip(), "local", body.role, hash_password(body.password), int(body.enabled))
        return {"id": uid}

    @app.put("/api/admin/users/{uid}")
    def update_user(uid: int, body: UserIn, me_: dict = Depends(admin)):
        row = db.one("SELECT * FROM users WHERE id=?", uid)
        if not row:
            raise HTTPException(404, "Пользователь не найден")
        losing_admin = row["role"] == "admin" and row["enabled"] and (body.role != "admin" or not body.enabled)
        if losing_admin and _admins_left(uid) == 0:
            raise HTTPException(409, "Нельзя убрать последнего администратора")
        db.run("UPDATE users SET name=?, role=?, enabled=?, role_locked=? WHERE id=?",
               body.name.strip(), body.role, int(body.enabled), int(body.role_locked and row["source"] == "ad"), uid)
        if body.password:
            if row["source"] != "local":
                raise HTTPException(422, "Пароль пользователя AD меняется в домене")
            if len(body.password) < 8:
                raise HTTPException(422, "Пароль должен быть не короче 8 символов")
            db.run("UPDATE users SET pw_hash=? WHERE id=?", hash_password(body.password), uid)
        return {"ok": True}

    @app.delete("/api/admin/users/{uid}")
    def delete_user(uid: int, me_: dict = Depends(admin)):
        if uid == me_["id"]:
            raise HTTPException(409, "Нельзя удалить самого себя")
        row = db.one("SELECT * FROM users WHERE id=?", uid)
        if row and row["role"] == "admin" and row["enabled"] and _admins_left(uid) == 0:
            raise HTTPException(409, "Нельзя удалить последнего администратора")
        db.run("DELETE FROM users WHERE id=?", uid)
        return {"ok": True}

    # ----- admin: Active Directory -----
    @app.get("/api/admin/ad")
    def get_ad(_: dict = Depends(admin)):
        ad = DEFAULT_AD | db.get_setting("ad", {})
        out = {k: v for k, v in ad.items() if k != "bind_password_enc"}
        out["has_bind_password"] = bool(ad.get("bind_password_enc"))
        users = db.all("SELECT via_group, COUNT(*) AS n FROM users WHERE source='ad' GROUP BY via_group")
        counts = {u["via_group"].lower(): u["n"] for u in users}
        for g in out["groups"]:
            g["users"] = counts.get(g["dn"].split(",")[0].removeprefix("CN=").removeprefix("cn=").lower(), 0)
        return out

    @app.put("/api/admin/ad")
    def put_ad(body: ADIn, _: dict = Depends(admin)):
        cur = DEFAULT_AD | db.get_setting("ad", {})
        new = body.model_dump(exclude={"bind_password"})
        new["groups"] = [g.model_dump() for g in body.groups]
        new["bind_password_enc"] = vault.encrypt(body.bind_password) if body.bind_password else cur.get("bind_password_enc", "")
        if new["enabled"]:
            missing = [n for k, n in (("servers", "контроллеры домена"), ("base_dn", "Base DN"), ("bind_dn", "сервисная учётка"))
                       if not new[k].strip()]
            if missing:
                raise HTTPException(422, "Заполните: " + ", ".join(missing))
            if "{login}" not in new["user_filter"]:
                raise HTTPException(422, "Фильтр пользователя должен содержать {login}")
        db.set_setting("ad", new)
        return {"ok": True}

    @app.post("/api/admin/ad/test")
    async def test_ad(body: ADTestIn, _: dict = Depends(admin)):
        ad = DEFAULT_AD | db.get_setting("ad", {})
        try:
            if body.password:
                u = await run_in_threadpool(ad_authenticate, ad, vault, body.login, body.password)
            else:
                u = await run_in_threadpool(ad_lookup, ad, vault, body.login)
        except (ADError, ValueError) as e:
            return {"ok": False, "error": str(e)}
        return {"ok": True, "login": u.login, "name": u.name, "dn": u.dn, "groups": u.groups[:50],
                "role": u.role, "via_group": u.via_group, "password_checked": bool(body.password)}

    app.mount("/", StaticFiles(directory=STATIC, html=True), name="ui")
    return app


def _bootstrap(db: DB, vault: Vault) -> None:
    if not db.one("SELECT 1 FROM users LIMIT 1"):
        pw = config.ADMIN_PASSWORD or secrets.token_urlsafe(12)
        db.run("INSERT INTO users(login,name,source,role,pw_hash) VALUES('admin','Встроенный администратор','local','admin',?)",
               hash_password(pw))
        if config.ADMIN_PASSWORD:
            log.warning("Создан пользователь admin с паролем из HMCSCAN_ADMIN_PASSWORD")
        else:
            log.warning("Создан пользователь admin. Пароль: %s  (смените его в разделе «Пользователи»)", pw)
    if config.DEMO and not db.one("SELECT 1 FROM hmcs LIMIT 1"):
        dcs = [("МСК-1", "ЦОД Москва-1", "Москва"), ("МСК-2", "ЦОД Москва-2", "Москва"), ("СПБ-1", "ЦОД Санкт-Петербург", "Санкт-Петербург")]
        ids = {}
        for code, name, addr in dcs:
            row = db.one("SELECT id FROM datacenters WHERE code=?", code)
            ids[code] = row["id"] if row else db.run("INSERT INTO datacenters(code,name,address) VALUES(?,?,?)", code, name, addr)
        for name, code in (("hmc-msk1-01", "МСК-1"), ("hmc-msk1-02", "МСК-1"), ("hmc-msk2-01", "МСК-2"), ("hmc-spb-01", "СПБ-1")):
            db.run("INSERT INTO hmcs(name,host,dc_id,username,password_enc) VALUES(?,?,?,?,?)",
                   name, f"{name}.demo", ids[code], "hmcscan_ro", vault.encrypt("demo"))
        log.warning("Демо-режим: добавлены тестовые ЦОД и HMC (*.demo)")
