"""Read-only client for the IBM HMC REST API.

Only GET requests are made against /rest/api/uom; the PUT/DELETE calls go to
/rest/api/web/Logon to open and close the API session. Use an HMC user with the
hmcviewer task role.
"""
from __future__ import annotations

import re
import ssl
import time
from typing import Any
from xml.sax.saxutils import escape

import httpx
from defusedxml import ElementTree as ET

WEB_NS = "http://www.ibm.com/xmlns/systems/power/firmware/web/mc/2012_10/"
LOGON_CT = "application/vnd.ibm.powervm.web+xml; type=LogonRequest"
LOGON_ACCEPT = "application/vnd.ibm.powervm.web+xml; type=LogonResponse"
FEED_ACCEPT = "application/atom+xml"
MB_PER_GB = 1024

# Marketing names for common machine types. Unknown types fall back to the MTM.
MODEL_NAMES = {
    "9080-HEX": "Power E1080", "9043-MRX": "Power E1050", "9105-22A": "Power S1022",
    "9105-22B": "Power S1022s", "9105-41B": "Power S1014", "9105-42A": "Power S1024",
    "9786-22H": "Power L1022", "9786-42H": "Power L1024", "9824-22A": "Power S1122",
    "9824-42A": "Power S1124", "9080-M9S": "Power E980", "9040-MR9": "Power E950",
    "9009-42A": "Power S924", "9009-42G": "Power S924", "9009-41A": "Power S914",
    "9009-22A": "Power S922", "9009-22G": "Power S922", "9223-42H": "Power H924",
    "9223-22H": "Power H922", "8286-42A": "Power S824", "8286-41A": "Power S814",
    "8247-22L": "Power S822L", "9119-MME": "Power E870", "9119-MHE": "Power E880",
    "9080-MHE": "Power E880C", "9080-MME": "Power E870C",
}

STATE_MAP = {
    "running": "Running", "not activated": "Not Activated", "error": "Error",
    "open firmware": "Open Firmware", "starting": "Starting", "shutting down": "Shutting Down",
    "migrating running": "Migrating", "migrating not active": "Migrating", "hardware discovery": "Starting",
    "suspended": "Suspended", "failed": "Error", "not available": "Not Available", "unknown": "Unknown",
}

TYPE_MAP = {"AIX/Linux": "AIX/Linux", "OS400": "IBM i", "Virtual IO Server": "VIOS"}


class HMCError(Exception):
    pass


# ---------- XML helpers (namespace-agnostic) ----------

def _strip_ns(root):
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def parse_xml(content: bytes):
    return _strip_ns(ET.fromstring(content))


def _t(el, path: str, default: str | None = None) -> str | None:
    if el is None:
        return default
    x = el.find(path)
    if x is None or x.text is None:
        return default
    v = x.text.strip()
    return v if v != "" else default


def _f(el, path: str) -> float | None:
    v = _t(el, path)
    try:
        return float(v) if v is not None else None
    except ValueError:
        return None


def _i(el, path: str) -> int | None:
    v = _f(el, path)
    return int(v) if v is not None else None


def _b(el, path: str) -> bool | None:
    v = _t(el, path)
    return None if v is None else v.lower() == "true"


def _gb(mb: float | None) -> float | None:
    return None if mb is None else round(mb / MB_PER_GB, 2)


def _links(el, path: str) -> int | None:
    x = el.find(path) if el is not None else None
    return None if x is None else len(x.findall("link"))


def feed_entries(root) -> list[tuple[str, Any]]:
    """Return (uuid, object element) for every entry of an Atom feed."""
    out = []
    entries = [root] if root.tag == "entry" else root.findall("entry")
    for entry in entries:
        uuid = _t(entry, "id")
        content = entry.find("content")
        if content is None or len(content) == 0:
            continue
        out.append((uuid, content[0]))
    return out


# ---------- parsers ----------

def parse_console(el) -> dict:
    mtms = el.find("MachineTypeModelAndSerialNumber")
    version = _t(el, "BaseVersion")
    vi = el.find("VersionInfo")
    if vi is not None:
        v, r = _t(vi, "Version"), _t(vi, "Release")
        m, sp = _t(vi, "Maintenance"), _t(vi, "ServicePackName")
        if v and r:
            version = f"V{v}R{r}" + (f" M{m}" if m else "")
        if sp:
            version = f"{version or ''} SP {sp}".strip()
    model = None
    if mtms is not None and _t(mtms, "MachineType"):
        model = f"{_t(mtms, 'MachineType')}-{_t(mtms, 'Model', '')}".strip("-")
    return {"name": _t(el, "ManagementConsoleName"), "version": version, "model": model}


def _generation(el) -> str | None:
    modes = [x.text or "" for x in el.iter("SupportedPartitionProcessorCompatibilityModes")]
    modes += [x.text or "" for x in el.iter("SupportedProcessorCompatibilityModes")]
    gens = [int(m) for m in re.findall(r"POWER(\d+)", " ".join(modes))]
    return f"POWER{max(gens)}" if gens else None


def parse_system(uuid: str, el) -> dict:
    mtms = el.find("MachineTypeModelAndSerialNumber")
    mt, model, serial = _t(mtms, "MachineType", ""), _t(mtms, "Model", ""), _t(mtms, "SerialNumber", "")
    mtm = f"{mt}-{model}" if mt else ""
    pc = el.find("AssociatedSystemProcessorConfiguration")
    mc = el.find("AssociatedSystemMemoryConfiguration")
    cpu_conf = _f(pc, "ConfigurableSystemProcessorUnits")
    cpu_avail = _f(pc, "CurrentAvailableSystemProcessorUnits")
    mem_conf = _f(mc, "ConfigurableSystemMemory")
    mem_avail = _f(mc, "CurrentAvailableSystemMemory")
    mem_hyp = _f(mc, "MemoryUsedByHypervisor")
    mem_used = None
    if None not in (mem_conf, mem_avail):
        mem_used = mem_conf - mem_avail - (mem_hyp or 0)
    fw = _t(el, "SystemFirmware")
    if fw is None:
        fw = _t(el, "ManagedSystemFirmware")
    return {
        "uuid": uuid,
        "key": re.sub(r"[^A-Za-z0-9_-]", "_", f"{mtm}_{serial}") if serial else uuid,
        "name": _t(el, "SystemName"),
        "state": _t(el, "State"),
        "mtm": mtm,
        "serial": serial,
        "model": MODEL_NAMES.get(mtm, mtm),
        "gen": _generation(el),
        "firmware": fw,
        "cpu": {
            "installed": _f(pc, "InstalledSystemProcessorUnits"),
            "configurable": cpu_conf,
            "available": cpu_avail,
            "assigned": None if None in (cpu_conf, cpu_avail) else round(cpu_conf - cpu_avail, 2),
        },
        "mem": {  # GB
            "installed": _gb(_f(mc, "InstalledSystemMemory")),
            "configurable": _gb(mem_conf),
            "available": _gb(mem_avail),
            "hypervisor": _gb(mem_hyp),
            "assigned": _gb(mem_used),
        },
    }


def parse_pools(entries) -> dict[int, str]:
    pools = {0: "DefaultPool"}
    for _, el in entries:
        pid = _i(el, "PoolID")
        if pid is not None:
            pools[pid] = _t(el, "PoolName") or f"Pool{pid}"
    return pools


def _proc_mode(dedicated: bool, sharing: str | None) -> str:
    s = (sharing or "").lower()
    if dedicated:
        return "ded" if s in ("", "keep idle procs") else "ded-donate"
    return "shared-uncapped" if s == "uncapped" else "shared-capped"


def parse_partition(uuid: str, el, is_vios: bool, pools: dict[int, str]) -> dict:
    pc = el.find("PartitionProcessorConfiguration")
    dedicated = bool(_b(pc, "HasDedicatedProcessors"))
    sharing = _t(pc, "SharingMode")
    cpu: dict[str, Any]
    if dedicated:
        d = pc.find("DedicatedProcessorConfiguration") if pc is not None else None
        cur = pc.find("CurrentDedicatedProcessorConfiguration") if pc is not None else None
        cpu = {
            "ec": {"min": _f(d, "MinimumProcessors"), "des": _f(d, "DesiredProcessors"),
                   "max": _f(d, "MaximumProcessors"), "cur": _f(cur, "CurrentProcessors")},
            "vp": None, "weight": None, "pool": None,
        }
    else:
        s = pc.find("SharedProcessorConfiguration") if pc is not None else None
        cur = pc.find("CurrentSharedProcessorConfiguration") if pc is not None else None
        pool_id = _i(s, "SharedProcessorPoolID")
        weight = _i(cur, "CurrentUncappedWeight")
        if weight is None:
            weight = _i(s, "UncappedWeight")
        cpu = {
            "ec": {"min": _f(s, "MinimumProcessingUnits"), "des": _f(s, "DesiredProcessingUnits"),
                   "max": _f(s, "MaximumProcessingUnits"), "cur": _f(cur, "AllocatedProcessingUnits")},
            "vp": {"min": _i(s, "MinimumVirtualProcessors"), "des": _i(s, "DesiredVirtualProcessors"),
                   "max": _i(s, "MaximumVirtualProcessors"), "cur": _i(cur, "AllocatedVirtualProcessors")},
            "weight": weight if (sharing or "").lower() == "uncapped" else None,
            "pool": pools.get(pool_id, f"Pool{pool_id}") if pool_id is not None else "DefaultPool",
        }
    pm = el.find("PartitionMemoryConfiguration")
    ame = _b(pm, "ActiveMemoryExpansionEnabled")
    state_raw = (_t(el, "PartitionState") or "unknown").lower()
    ptype = _t(el, "PartitionType") or ("Virtual IO Server" if is_vios else "")
    os_ver = _t(el, "OperatingSystemVersion")
    kind = "VIOS" if is_vios else TYPE_MAP.get(ptype, ptype or "—")
    if kind == "AIX/Linux" and os_ver:  # the API does not split AIX from Linux, the OS string does
        low = os_ver.lower()
        kind = "AIX" if low.startswith("aix") else "Linux" if low.startswith("linux") or "red hat" in low or "suse" in low else kind
    io = el.find("PartitionIOConfiguration")
    phys_slots = len(io.findall(".//ProfileIOSlot")) if io is not None else None
    return {
        "uuid": uuid,
        "id": _i(el, "PartitionID"),
        "name": _t(el, "PartitionName"),
        "type": kind,
        "os": os_ver,
        "state": STATE_MAP.get(state_raw, state_raw.title()),
        "ref_code": _t(el, "ReferenceCode"),
        "mode": _proc_mode(dedicated, sharing),
        "sharing_mode": sharing,
        **cpu,
        "mem": {  # GB
            "min": _gb(_f(pm, "MinimumMemory")), "des": _gb(_f(pm, "DesiredMemory")),
            "max": _gb(_f(pm, "MaximumMemory")), "cur": _gb(_f(pm, "CurrentMemory")),
        },
        "ame": _f(pm, "ExpansionFactor") if ame else None,
        "ams": _b(pm, "ActiveMemorySharingEnabled"),
        "compat": _t(el, "CurrentProcessorCompatibilityMode"),
        "compat_pending": _t(el, "PendingProcessorCompatibilityMode"),
        "srr": _b(el, "SimplifiedRemoteRestartCapable") if _t(el, "SimplifiedRemoteRestartCapable") else _b(el, "RemoteRestartCapable"),
        "rmc": _t(el, "ResourceMonitoringControlState"),
        "rmc_ip": _t(el, "ResourceMonitoringIPAddress"),
        "phys_slots": phys_slots,
        "veth": _links(el, "ClientNetworkAdapters"),
        "vfc": _links(el, "VirtualFibreChannelClientAdapters"),
        "vscsi": _links(el, "VirtualSCSIClientAdapters"),
    }


# ---------- client ----------

def _ssl_context(tls_mode: str, ca_pem: str) -> ssl.SSLContext | bool:
    if tls_mode == "none":
        return False
    if tls_mode == "ca" and ca_pem.strip():
        ctx = ssl.create_default_context(cadata=ca_pem)
        ctx.check_hostname = True
        return ctx
    return True


class HMCClient:
    def __init__(self, host: str, port: int, username: str, password: str,
                 tls_mode: str = "verify", ca_pem: str = "", transport: httpx.AsyncBaseTransport | None = None,
                 timeout: float = 90.0):
        self.base = f"https://{host}:{port}"
        self.username, self.password = username, password
        self._http = httpx.AsyncClient(
            base_url=self.base, verify=_ssl_context(tls_mode, ca_pem), transport=transport,
            timeout=httpx.Timeout(timeout, connect=10.0),
        )
        self.token: str | None = None

    async def __aenter__(self):
        try:
            await self.logon()
        except BaseException:
            await self._http.aclose()
            raise
        return self

    async def __aexit__(self, *exc):
        try:
            if self.token:
                await self._http.delete("/rest/api/web/Logon", headers={"X-API-Session": self.token})
        except httpx.HTTPError:
            pass
        finally:
            await self._http.aclose()

    async def _send(self, method: str, url: str, **kw) -> httpx.Response:
        try:
            return await self._http.request(method, url, **kw)
        except httpx.ConnectTimeout as e:
            raise HMCError(f"Нет ответа от {self.base} (таймаут подключения)") from e
        except httpx.ConnectError as e:
            msg = str(e)
            if "CERTIFICATE_VERIFY_FAILED" in msg or "certificate" in msg.lower():
                raise HMCError("TLS-сертификат HMC не прошёл проверку. Загрузите CA или отключите проверку.") from e
            raise HMCError(f"Не удалось подключиться к {self.base}: {msg}") from e
        except httpx.TimeoutException as e:
            raise HMCError(f"HMC не ответила вовремя на {url}") from e
        except httpx.HTTPError as e:
            raise HMCError(f"Ошибка обмена с HMC: {e}") from e

    async def logon(self) -> None:
        body = (f'<LogonRequest xmlns="{WEB_NS}" schemaVersion="V1_0">'
                f"<UserID>{escape(self.username)}</UserID><Password>{escape(self.password)}</Password></LogonRequest>")
        r = await self._send("PUT", "/rest/api/web/Logon", content=body.encode(),
                             headers={"Content-Type": LOGON_CT, "Accept": LOGON_ACCEPT})
        if r.status_code == 401:
            raise HMCError("HMC отклонила логин или пароль (401)")
        if r.status_code == 403:
            raise HMCError("У пользователя HMC нет права удалённого доступа к REST API (403)")
        if r.status_code != 200:
            raise HMCError(f"Вход на HMC завершился кодом {r.status_code}")
        root = parse_xml(r.content)
        token = _t(root, "X-API-Session")
        if not token:
            raise HMCError("HMC не вернула токен сессии")
        self.token = token

    async def feed(self, path: str) -> list[tuple[str, Any]]:
        r = await self._send("GET", path, headers={"X-API-Session": self.token or "", "Accept": FEED_ACCEPT})
        if r.status_code == 204:
            return []
        if r.status_code == 401:
            raise HMCError("Сессия HMC истекла (401)")
        if r.status_code != 200:
            raise HMCError(f"GET {path} вернул код {r.status_code}")
        return feed_entries(parse_xml(r.content))

    async def collect(self) -> dict:
        """Read the console, all managed systems and their partitions."""
        started = time.monotonic()
        console = {}
        mc = await self.feed("/rest/api/uom/ManagementConsole")
        if mc:
            console = parse_console(mc[0][1])
        systems = []
        warnings = []
        for uuid, el in await self.feed("/rest/api/uom/ManagedSystem"):
            ms = parse_system(uuid, el)
            ms["lpars"] = []
            try:
                pools = parse_pools(await self.feed(f"/rest/api/uom/ManagedSystem/{uuid}/SharedProcessorPool"))
                for vu, vel in await self.feed(f"/rest/api/uom/ManagedSystem/{uuid}/VirtualIOServer"):
                    ms["lpars"].append(parse_partition(vu, vel, True, pools))
                for lu, lel in await self.feed(f"/rest/api/uom/ManagedSystem/{uuid}/LogicalPartition"):
                    ms["lpars"].append(parse_partition(lu, lel, False, pools))
            except HMCError as e:
                ms["error"] = str(e)
                warnings.append(f"{ms['name']}: {e}")
            ms["lpars"].sort(key=lambda x: (x["id"] is None, x["id"] or 0))
            systems.append(ms)
        systems.sort(key=lambda s: s["name"] or "")
        return {"console": console, "systems": systems, "warnings": warnings,
                "duration_s": round(time.monotonic() - started, 1)}
