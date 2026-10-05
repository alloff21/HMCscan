"""Background polling of all HMCs on their own interval."""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta, timezone

from . import config
from .db import DB
from .hmc_client import HMCClient, HMCError
from .security import Vault

log = logging.getLogger("hmcscan")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def transport_for_host(host: str):
    if config.DEMO and host.endswith(".demo"):
        from .demo import transport_for
        return transport_for(host)
    return None


async def collect(host: str, port: int, username: str, password: str, tls_mode: str, ca_pem: str) -> dict:
    async with HMCClient(host, port, username, password, tls_mode, ca_pem,
                         transport=transport_for_host(host)) as c:
        return await c.collect()


class Poller:
    def __init__(self, db: DB, vault: Vault):
        self.db, self.vault = db, vault
        self._running: dict[int, asyncio.Task] = {}
        self._sem = asyncio.Semaphore(config.POLL_CONCURRENCY)
        self._task: asyncio.Task | None = None

    def start(self) -> None:
        self._task = asyncio.create_task(self._loop())

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
        for t in list(self._running.values()):
            t.cancel()

    def is_running(self, hmc_id: int) -> bool:
        t = self._running.get(hmc_id)
        return bool(t and not t.done())

    def trigger(self, hmc_id: int) -> bool:
        """Start a poll now unless one is already running. Returns True if started."""
        if self.is_running(hmc_id):
            return False
        self._running[hmc_id] = asyncio.create_task(self._guarded(hmc_id))
        return True

    def trigger_all(self) -> int:
        return sum(self.trigger(h["id"]) for h in self.db.all("SELECT id FROM hmcs WHERE enabled=1"))

    async def _loop(self) -> None:
        while True:
            try:
                self._schedule_due()
            except Exception:  # never let the scheduler die
                log.exception("Ошибка планировщика опроса")
            await asyncio.sleep(20)

    def _schedule_due(self) -> None:
        rows = self.db.all(
            "SELECT h.id, h.interval_min, s.attempted_at FROM hmcs h LEFT JOIN snapshots s ON s.hmc_id=h.id WHERE h.enabled=1")
        now = datetime.now(timezone.utc)
        for r in rows:
            last = datetime.fromisoformat(r["attempted_at"]) if r["attempted_at"] else None
            if last is None or now - last >= timedelta(minutes=r["interval_min"]):
                self.trigger(r["id"])

    async def _guarded(self, hmc_id: int) -> None:
        async with self._sem:
            await self.poll(hmc_id)

    async def poll(self, hmc_id: int) -> dict | None:
        h = self.db.one("SELECT * FROM hmcs WHERE id=?", hmc_id)
        if not h:
            return None
        attempted = now_iso()
        self.db.run("INSERT INTO snapshots(hmc_id,status,attempted_at) VALUES(?, 'running', ?) "
                    "ON CONFLICT(hmc_id) DO UPDATE SET attempted_at=excluded.attempted_at", hmc_id, attempted)
        try:
            password = self.vault.decrypt(h["password_enc"])
            data = await collect(h["host"], h["port"], h["username"], password, h["tls_mode"], h["ca_pem"])
        except (HMCError, ValueError) as e:
            log.warning("Опрос %s не удался: %s", h["name"], e)
            self.db.run("UPDATE snapshots SET status='err', error=? WHERE hmc_id=?", str(e), hmc_id)
            return None
        except Exception as e:  # unexpected parser or network problem: record it, keep the old data
            log.exception("Опрос %s: непредвиденная ошибка", h["name"])
            self.db.run("UPDATE snapshots SET status='err', error=? WHERE hmc_id=?", f"Внутренняя ошибка: {e}", hmc_id)
            return None
        status = "warn" if data["warnings"] else "ok"
        self.db.run("UPDATE snapshots SET status=?, error=?, polled_at=?, duration_s=?, data=? WHERE hmc_id=?",
                    status, "; ".join(data["warnings"]) or None, now_iso(), data["duration_s"],
                    json.dumps(data, ensure_ascii=False), hmc_id)
        log.info("Опрос %s: %d серверов за %.1f с", h["name"], len(data["systems"]), data["duration_s"])
        return data
