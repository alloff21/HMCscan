import asyncio

import pytest
from fastapi.testclient import TestClient

from app import config
from app.ldap_auth import map_role
from app.poller import Poller


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "TLS", False)
    monkeypatch.setattr(config, "DEMO", True)
    monkeypatch.setattr(config, "ADMIN_PASSWORD", "admin-pass-1")
    from app.main import create_app
    app = create_app(tmp_path, start_poller=False)
    with TestClient(app) as c:
        c.app_ref = app
        yield c


def login(c, user="admin", pw="admin-pass-1"):
    return c.post("/api/auth/login", json={"login": user, "password": pw, "source": "local"})


def poll_all(c):
    app = c.app_ref
    p = Poller(app.state.db, app.state.vault)
    for h in app.state.db.all("SELECT id FROM hmcs"):
        asyncio.run(p.poll(h["id"]))


def test_requires_login(client):
    assert client.get("/api/overview").status_code == 401
    assert login(client, pw="nope").status_code == 401
    assert login(client).status_code == 200
    assert client.get("/api/auth/me").json()["role"] == "admin"


def test_inventory_after_poll(client):
    login(client)
    poll_all(client)
    ov = client.get("/api/overview").json()
    assert ov["totals"]["hmcs"] == 4 and ov["totals"]["servers"] > 0
    hmc = ov["hmcs"][0]
    assert hmc["status"] == "ok"
    servers = client.get(f"/api/hmcs/{hmc['id']}/servers").json()["servers"]
    detail = client.get(f"/api/servers/{servers[0]['key']}").json()
    assert detail["server"]["dc"]["code"]
    assert detail["lpars"][0]["ec"]["des"] is not None
    lpars = client.get("/api/lpars").json()["lpars"]
    assert len(lpars) == ov["totals"]["lpars"]
    assert {"dc", "hmc", "server"} <= lpars[0].keys()
    csv = client.get("/api/export/lpars.csv")
    assert csv.status_code == 200 and csv.text.count("\n") == len(lpars) + 1


def test_hmc_requires_datacenter(client):
    login(client)
    body = {"name": "hmc-x", "host": "hmc-x.demo", "username": "u", "password": "p"}
    r = client.post("/api/admin/hmcs", json=body)
    assert r.status_code == 422 and "ЦОД" in r.json()["detail"]
    dc = client.post("/api/admin/datacenters", json={"code": "НСК-1", "name": "ЦОД Новосибирск"}).json()["id"]
    assert client.post("/api/admin/hmcs", json=body | {"dc_id": dc}).status_code == 201
    # the datacenter cannot be deleted while an HMC uses it
    assert client.delete(f"/api/admin/datacenters/{dc}").status_code == 409
    listed = client.get("/api/admin/hmcs").json()
    assert all("password_enc" not in h for h in listed)


def test_viewer_cannot_admin(client):
    login(client)
    assert client.post("/api/admin/users", json={"login": "viewer1", "password": "viewer-pass", "role": "viewer"}).status_code == 201
    client.post("/api/auth/logout")
    assert login(client, "viewer1", "viewer-pass").status_code == 200
    assert client.get("/api/overview").status_code == 200
    assert client.get("/api/admin/hmcs").status_code == 403


def test_last_admin_is_protected(client):
    login(client)
    me = client.get("/api/auth/me").json()
    r = client.put(f"/api/admin/users/{me['id']}", json={"login": "admin", "role": "viewer"})
    assert r.status_code == 409


def test_ad_settings_keep_password(client):
    login(client)
    cfg = {"enabled": True, "servers": "ldaps://dc1:636", "base_dn": "DC=corp,DC=local",
           "bind_dn": "CN=svc,DC=corp,DC=local", "bind_password": "secret",
           "groups": [{"dn": "CN=HMCscan-Admins,OU=G,DC=corp,DC=local", "role": "admin"}]}
    assert client.put("/api/admin/ad", json=cfg).status_code == 200
    assert client.put("/api/admin/ad", json=cfg | {"bind_password": ""}).status_code == 200
    got = client.get("/api/admin/ad").json()
    assert got["has_bind_password"] is True and "bind_password_enc" not in got
    assert client.get("/api/auth/config").json()["ad_enabled"] is True


def test_role_mapping_takes_highest():
    mapping = [{"dn": "CN=Viewers,DC=c", "role": "viewer"}, {"dn": "CN=Admins,DC=c", "role": "admin"}]
    assert map_role(["cn=viewers,dc=c", "CN=Admins,DC=c"], mapping) == ("admin", "Admins")
    assert map_role(["CN=Other,DC=c"], mapping) == (None, "")
