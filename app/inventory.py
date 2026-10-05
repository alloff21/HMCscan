"""Turns stored HMC snapshots into the views the UI shows.

A server managed by two HMCs (a redundant pair) is shown once: the copy from the
most recent successful poll wins, and both HMCs are listed on it.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field

from .db import DB


@dataclass
class Inventory:
    dcs: list[dict]
    hmcs: list[dict]                       # hmc row + snapshot status + console info
    servers: dict[str, dict] = field(default_factory=dict)   # key -> server (deduplicated)
    by_hmc: dict[int, list[str]] = field(default_factory=dict)


def _num(v) -> float:
    return v or 0


def load(db: DB) -> Inventory:
    dcs = db.all("SELECT * FROM datacenters ORDER BY code")
    rows = db.all(
        "SELECT h.id, h.name, h.host, h.port, h.dc_id, h.username, h.interval_min, h.enabled, h.tls_mode, "
        "s.status, s.error, s.attempted_at, s.polled_at, s.duration_s, s.data "
        "FROM hmcs h LEFT JOIN snapshots s ON s.hmc_id=h.id ORDER BY h.name")
    inv = Inventory(dcs=dcs, hmcs=[])
    dc_by_id = {d["id"]: d for d in dcs}
    for r in rows:
        data = json.loads(r.pop("data")) if r.get("data") else None
        console = (data or {}).get("console") or {}
        r["version"], r["model"] = console.get("version"), console.get("model")
        r["status"] = r["status"] or "pending"
        r["dc"] = dc_by_id.get(r["dc_id"])
        inv.hmcs.append(r)
        inv.by_hmc[r["id"]] = []
        for s in (data or {}).get("systems", []):
            key = s["key"]
            inv.by_hmc[r["id"]].append(key)
            prev = inv.servers.get(key)
            entry = dict(s, hmc_id=r["id"], dc_id=r["dc_id"], polled_at=r["polled_at"],
                         stale=r["status"] == "err")
            if prev is None:
                entry["hmc_ids"] = [r["id"]]
                inv.servers[key] = entry
            else:
                ids = prev["hmc_ids"] + [r["id"]]
                if (r["polled_at"] or "") > (prev["polled_at"] or ""):
                    entry["hmc_ids"] = ids
                    inv.servers[key] = entry
                else:
                    prev["hmc_ids"] = ids
    return inv


def server_summary(s: dict) -> dict:
    lp = s.get("lpars", [])
    return {k: s.get(k) for k in ("key", "name", "state", "mtm", "serial", "model", "gen", "firmware",
                                  "cpu", "mem", "hmc_ids", "dc_id", "polled_at", "stale", "error")} | {
        "lpar_count": len(lp),
        "lpar_running": sum(1 for x in lp if x["state"] == "Running"),
        "vios_count": sum(1 for x in lp if x["type"] == "VIOS"),
    }


def totals(servers: list[dict]) -> dict:
    t = {"cpu_conf": 0.0, "cpu_free": 0.0, "mem_conf": 0.0, "mem_free": 0.0, "servers": len(servers), "lpars": 0, "running": 0}
    for s in servers:
        t["cpu_conf"] += _num(s["cpu"]["configurable"])
        t["cpu_free"] += _num(s["cpu"]["available"])
        t["mem_conf"] += _num(s["mem"]["configurable"]) - _num(s["mem"]["hypervisor"])
        t["mem_free"] += _num(s["mem"]["available"])
        t["lpars"] += len(s.get("lpars", []))
        t["running"] += sum(1 for x in s.get("lpars", []) if x["state"] == "Running")
    return {k: round(v, 2) if isinstance(v, float) else v for k, v in t.items()}


def overview(inv: Inventory) -> dict:
    hmcs = []
    for h in inv.hmcs:
        ss = [inv.servers[k] for k in inv.by_hmc[h["id"]] if k in inv.servers]
        hmcs.append({k: h[k] for k in ("id", "name", "host", "dc_id", "status", "error", "polled_at",
                                        "attempted_at", "duration_s", "version", "model", "enabled")}
                    | {"totals": totals(ss)})
    return {"dcs": inv.dcs, "hmcs": hmcs, "totals": totals(list(inv.servers.values())) | {"hmcs": len(inv.hmcs), "dcs": len(inv.dcs)}}


def hmc_servers(inv: Inventory, hmc_id: int) -> dict | None:
    h = next((x for x in inv.hmcs if x["id"] == hmc_id), None)
    if h is None:
        return None
    servers = [server_summary(inv.servers[k]) for k in inv.by_hmc[hmc_id] if k in inv.servers]
    return {"hmc": {k: h[k] for k in ("id", "name", "host", "port", "dc", "status", "error", "polled_at",
                                       "version", "model")}, "servers": servers}


def server_detail(inv: Inventory, key: str) -> dict | None:
    s = inv.servers.get(key)
    if s is None:
        return None
    hmcs = [{"id": h["id"], "name": h["name"]} for h in inv.hmcs if h["id"] in s["hmc_ids"]]
    dc = next((d for d in inv.dcs if d["id"] == s["dc_id"]), None)
    return {"server": server_summary(s) | {"hmcs": hmcs, "dc": dc}, "lpars": s.get("lpars", [])}


def all_lpars(inv: Inventory) -> list[dict]:
    hmc_name = {h["id"]: h["name"] for h in inv.hmcs}
    dc_code = {d["id"]: d["code"] for d in inv.dcs}
    out = []
    for s in inv.servers.values():
        for lp in s.get("lpars", []):
            out.append(lp | {"server": s["name"], "server_key": s["key"], "hmc": hmc_name.get(s["hmc_id"]),
                             "hmc_id": s["hmc_id"], "dc": dc_code.get(s["dc_id"]), "dc_id": s["dc_id"]})
    out.sort(key=lambda x: (x["name"] or "").lower())
    return out
