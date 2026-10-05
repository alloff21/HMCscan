"""Fake HMC for demo mode and tests.

Serves the same XML shapes the real HMC REST API returns (Atom feeds with UOM
objects), so the whole pipeline — logon, parsing, storage, UI — runs without an
HMC. Enabled with HMCSCAN_DEMO=1 for hosts ending in ".demo".
"""
from __future__ import annotations

import random
import uuid as uuidlib
from xml.sax.saxutils import escape

import httpx

UOM_NS = "http://www.ibm.com/xmlns/systems/power/firmware/uom/mc/2012_10/"
WEB_NS = "http://www.ibm.com/xmlns/systems/power/firmware/web/mc/2012_10/"

TEMPLATES = {
    "E1080": ("9080", "HEX", 120, 8192, "POWER10", "MH1040_052"),
    "E1050": ("9043", "MRX", 96, 4096, "POWER10", "ML1050_043"),
    "S1022": ("9105", "22A", 40, 1024, "POWER10", "ML1050_043"),
    "E980": ("9080", "M9S", 96, 4096, "POWER9", "VH950_136"),
    "S924": ("9009", "42G", 24, 1024, "POWER9", "VL950_136"),
}
APPS = ["db", "app", "web", "sap", "mq", "esb", "bi", "ora", "1c", "etl", "crm", "abs"]


def _uuid(rnd: random.Random) -> str:
    return str(uuidlib.UUID(int=rnd.getrandbits(128), version=4))


def _feed(entries: list[tuple[str, str, str]]) -> bytes:
    """entries: (uuid, type name, inner xml)"""
    body = "".join(
        f'<entry><id>{u}</id><title>{t}</title>'
        f'<content type="application/vnd.ibm.powervm.uom+xml; type={t}">'
        f'<{t}:{t} xmlns:{t}="{UOM_NS}" xmlns="{UOM_NS}" schemaVersion="V1_0">{x}</{t}:{t}></content></entry>'
        for u, t, x in entries
    )
    return f'<feed xmlns="http://www.w3.org/2005/Atom"><id>{uuidlib.uuid4()}</id>{body}</feed>'.encode()


def _tag(name: str, value) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        value = "true" if value else "false"
    return f"<{name}>{escape(str(value))}</{name}>"


class DemoHMC:
    def __init__(self, host: str, servers: list[str] | None = None):
        self.host = host
        rnd = random.Random(host)
        self.rnd = rnd
        if servers is None:
            pool = list(TEMPLATES)
            servers = [rnd.choice(pool) for _ in range(rnd.randint(2, 4))]
        site = host.split(".")[0].replace("hmc-", "")
        self.systems = [self._system(k, n, site) for n, k in enumerate(servers, 1)]

    # ---- data generation ----
    def _system(self, key: str, n: int, site: str) -> dict:
        rnd = self.rnd
        mt, model, cores, mem_gb, gen, fw = TEMPLATES[key]
        sysd = {
            "uuid": _uuid(rnd), "name": f"{'P10' if gen == 'POWER10' else 'P9'}-{key}-{site.upper()}-{n:02d}",
            "mt": mt, "model": model, "serial": f"78{rnd.randrange(16**5):05X}", "gen": gen, "fw": fw,
            "cores": cores, "conf": cores, "mem": mem_gb * 1024, "hyp": int(mem_gb * 1024 * 0.025),
            "pools": [(0, "DefaultPool"), (1, "ORA_Pool")], "lpars": [],
        }
        budget_cpu = cores * rnd.uniform(0.55, 0.9)
        budget_mem = (sysd["mem"] - sysd["hyp"]) * rnd.uniform(0.5, 0.9)
        used_cpu = used_mem = 0.0
        pid = 1
        for v in (1, 2):
            lp = self._lpar(pid, f"{site}-{key.lower()}{n}-vios{v}", "Virtual IO Server", gen, vios=True,
                            ec=2.0 if cores >= 90 else 1.0, mem=32768 if cores >= 90 else 16384)
            sysd["lpars"].append(lp)
            used_cpu += lp["ec_cur"]; used_mem += lp["mem_cur"]; pid += 1
        for _ in range(30):
            ptype = rnd.choice(["AIX/Linux"] * 6 + ["OS400"])
            lp = self._lpar(pid, "", ptype, gen, mem_scale=4 if mem_gb >= 4096 else 1)
            if used_cpu + lp["ec_cur"] > budget_cpu or used_mem + lp["mem_cur"] > budget_mem:
                if len(sysd["lpars"]) > 5:
                    break
                continue
            sysd["lpars"].append(lp)
            used_cpu += lp["ec_cur"]; used_mem += lp["mem_cur"]; pid += 1
            if len(sysd["lpars"]) >= 14:
                break
        off = rnd.choice(sysd["lpars"][2:])
        off["state"] = "not activated"; used_cpu -= off["ec_cur"]; used_mem -= off["mem_cur"]
        off["ec_cur"] = 0; off["vp_cur"] = 0; off["mem_cur"] = 0; off["rmc"] = "inactive"
        sysd["avail_cpu"] = round(cores - used_cpu, 2)
        sysd["avail_mem"] = int(sysd["mem"] - sysd["hyp"] - used_mem)
        return sysd

    def _lpar(self, pid, name, ptype, gen, vios=False, ec=None, mem=None, mem_scale=1) -> dict:
        rnd = self.rnd
        is_aix = ptype == "AIX/Linux" and rnd.random() < 0.7
        if not name:
            prefix = "aix" if is_aix else ("lnx" if ptype == "AIX/Linux" else "ibmi")
            name = f"{self.host.split('.')[0].replace('hmc-', '')}-{prefix}-{rnd.choice(APPS)}{rnd.randint(1, 12):02d}"
        if vios:
            osv = "VIOS 4.1.0.10"
        elif ptype == "OS400":
            osv = rnd.choice(["IBM i 7.5", "IBM i 7.4"])
        elif is_aix:
            osv = rnd.choice(["AIX 7.3 7300-02-02-2420", "AIX 7.2 7200-05-07-2346"])
        else:
            osv = rnd.choice(["Linux/Red Hat 5.14.0 9.4", "Linux/SuSE 5.14.21 15.5"])
        x = rnd.random()
        dedicated = not vios and x > 0.8
        sharing = ("keep idle procs" if x < 0.9 else "share idle procs") if dedicated else ("uncapped" if vios or x < 0.65 else "capped")
        if dedicated:
            d = float(rnd.choice([2, 4, 4, 8, 12]))
            lp = {"ec_min": max(1.0, d // 2), "ec_des": d, "ec_max": d * 1.5, "ec_cur": d, "vp_cur": None}
        else:
            d = ec or rnd.choice([0.5, 0.5, 1.0, 1.0, 1.5, 2.0, 3.0, 4.0, 6.0])
            vp = max(1, int(d * rnd.uniform(1.5, 3) + 0.99))
            lp = {"ec_min": max(0.1, round(d / 4, 2)), "ec_des": d, "ec_max": d * 2, "ec_cur": d,
                  "vp_min": 1, "vp_des": vp, "vp_max": vp * 2, "vp_cur": vp,
                  "weight": 255 if vios else rnd.choice([128, 128, 64, 192]),
                  "pool": 1 if "ora" in name else 0}
        m = mem or rnd.choice([8, 16, 32, 32, 64, 64, 128, 256]) * 1024 * mem_scale
        lp.update({
            "uuid": _uuid(rnd), "id": pid, "name": name, "type": ptype, "os": osv, "state": "running",
            "dedicated": dedicated, "sharing": sharing, "vios": vios,
            "mem_min": m // 4, "mem_des": m, "mem_max": m * 2, "mem_cur": m,
            "ame": is_aix and rnd.random() < 0.25, "compat": gen if rnd.random() < 0.5 else "default",
            "srr": not vios and rnd.random() < 0.6, "rmc": "active",
            "ip": f"10.{rnd.randint(1, 40)}.{rnd.randint(1, 250)}.{rnd.randint(10, 240)}",
            "slots": rnd.choice([4, 6]) if vios else (2 if dedicated and rnd.random() < 0.4 else 0),
            "veth": rnd.choice([1, 2]), "vfc": 0 if vios else rnd.choice([0, 2, 4]), "vscsi": 0 if vios else rnd.choice([0, 1]),
        })
        return lp

    # ---- XML ----
    def _system_xml(self, s) -> str:
        gens = {"POWER10": "default POWER8 POWER9_base POWER9 POWER10", "POWER9": "default POWER7 POWER8 POWER9_base POWER9"}[s["gen"]]
        modes = "".join(_tag("SupportedPartitionProcessorCompatibilityModes", m) for m in gens.split())
        return (
            f"<AssociatedSystemCapabilities>{modes}</AssociatedSystemCapabilities>"
            "<AssociatedSystemMemoryConfiguration>"
            + _tag("ConfigurableSystemMemory", s["mem"]) + _tag("CurrentAvailableSystemMemory", s["avail_mem"])
            + _tag("InstalledSystemMemory", s["mem"]) + _tag("MemoryUsedByHypervisor", s["hyp"])
            + "</AssociatedSystemMemoryConfiguration><AssociatedSystemProcessorConfiguration>"
            + _tag("ConfigurableSystemProcessorUnits", s["conf"]) + _tag("CurrentAvailableSystemProcessorUnits", s["avail_cpu"])
            + _tag("InstalledSystemProcessorUnits", s["cores"])
            + "</AssociatedSystemProcessorConfiguration>"
            + f"<MachineTypeModelAndSerialNumber>{_tag('MachineType', s['mt'])}{_tag('Model', s['model'])}{_tag('SerialNumber', s['serial'])}</MachineTypeModelAndSerialNumber>"
            + _tag("State", "operating") + _tag("SystemName", s["name"]) + _tag("SystemFirmware", s["fw"])
        )

    def _lpar_xml(self, lp) -> str:
        if lp["dedicated"]:
            proc = (_tag("HasDedicatedProcessors", True) + _tag("SharingMode", lp["sharing"])
                    + "<DedicatedProcessorConfiguration>" + _tag("DesiredProcessors", int(lp["ec_des"]))
                    + _tag("MaximumProcessors", int(lp["ec_max"])) + _tag("MinimumProcessors", int(lp["ec_min"]))
                    + "</DedicatedProcessorConfiguration><CurrentDedicatedProcessorConfiguration>"
                    + _tag("CurrentProcessors", int(lp["ec_cur"])) + "</CurrentDedicatedProcessorConfiguration>")
        else:
            proc = (_tag("HasDedicatedProcessors", False) + _tag("SharingMode", lp["sharing"])
                    + "<SharedProcessorConfiguration>" + _tag("DesiredProcessingUnits", lp["ec_des"])
                    + _tag("DesiredVirtualProcessors", lp["vp_des"]) + _tag("MaximumProcessingUnits", lp["ec_max"])
                    + _tag("MaximumVirtualProcessors", lp["vp_max"]) + _tag("MinimumProcessingUnits", lp["ec_min"])
                    + _tag("MinimumVirtualProcessors", lp["vp_min"]) + _tag("SharedProcessorPoolID", lp["pool"])
                    + _tag("UncappedWeight", lp["weight"]) + "</SharedProcessorConfiguration>"
                    + "<CurrentSharedProcessorConfiguration>" + _tag("AllocatedProcessingUnits", lp["ec_cur"])
                    + _tag("AllocatedVirtualProcessors", lp["vp_cur"]) + _tag("CurrentUncappedWeight", lp["weight"])
                    + "</CurrentSharedProcessorConfiguration>")
        links = lambda tag, n: f"<{tag}>" + "".join(f'<link href="https://x/{i}" rel="related"/>' for i in range(n)) + f"</{tag}>"
        slots = "".join("<ProfileIOSlot><AssociatedIOSlot/></ProfileIOSlot>" for _ in range(lp["slots"]))
        return (
            _tag("CurrentProcessorCompatibilityMode", lp["compat"]) + _tag("OperatingSystemVersion", lp["os"])
            + f"<PartitionIOConfiguration><ProfileIOSlots>{slots}</ProfileIOSlots></PartitionIOConfiguration>"
            + _tag("PartitionID", lp["id"])
            + "<PartitionMemoryConfiguration>" + _tag("ActiveMemoryExpansionEnabled", lp["ame"])
            + _tag("ActiveMemorySharingEnabled", False) + _tag("DesiredMemory", lp["mem_des"])
            + (_tag("ExpansionFactor", 1.3) if lp["ame"] else "")
            + _tag("MaximumMemory", lp["mem_max"]) + _tag("MinimumMemory", lp["mem_min"]) + _tag("CurrentMemory", lp["mem_cur"])
            + "</PartitionMemoryConfiguration>"
            + _tag("PartitionName", lp["name"])
            + f"<PartitionProcessorConfiguration>{proc}</PartitionProcessorConfiguration>"
            + _tag("PartitionState", lp["state"]) + _tag("PartitionType", lp["type"])
            + _tag("ResourceMonitoringControlState", lp["rmc"]) + _tag("ResourceMonitoringIPAddress", lp["ip"])
            + _tag("SimplifiedRemoteRestartCapable", lp["srr"])
            + links("ClientNetworkAdapters", lp["veth"]) + links("VirtualFibreChannelClientAdapters", lp["vfc"])
            + links("VirtualSCSIClientAdapters", lp["vscsi"])
        )

    # ---- HTTP ----
    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/rest/api/web/Logon":
            if request.method == "DELETE":
                return httpx.Response(204)
            body = request.content.decode()
            if "<Password>wrong</Password>" in body:
                return httpx.Response(401)
            return httpx.Response(200, content=(
                f'<LogonResponse xmlns="{WEB_NS}" schemaVersion="V1_0">'
                f'<X-API-Session kb="ROR" kxe="false">demo-token</X-API-Session></LogonResponse>').encode())
        if request.method != "GET":
            return httpx.Response(405)
        if request.headers.get("X-API-Session") != "demo-token":
            return httpx.Response(401)
        if path == "/rest/api/uom/ManagementConsole":
            x = ("<MachineTypeModelAndSerialNumber><MachineType>7063</MachineType><Model>CR2</Model>"
                 "<SerialNumber>DEMO001</SerialNumber></MachineTypeModelAndSerialNumber>"
                 f"<ManagementConsoleName>{escape(self.host.split('.')[0])}</ManagementConsoleName>"
                 "<VersionInfo><Maintenance>1062</Maintenance><Release>3</Release><Version>10</Version></VersionInfo>")
            return httpx.Response(200, content=_feed([(str(uuidlib.uuid4()), "ManagementConsole", x)]))
        if path == "/rest/api/uom/ManagedSystem":
            return httpx.Response(200, content=_feed([(s["uuid"], "ManagedSystem", self._system_xml(s)) for s in self.systems]))
        parts = path.split("/")
        if len(parts) == 7 and parts[4] == "ManagedSystem":
            s = next((x for x in self.systems if x["uuid"] == parts[5]), None)
            if s is None:
                return httpx.Response(404)
            kind = parts[6]
            if kind == "SharedProcessorPool":
                return httpx.Response(200, content=_feed([(str(uuidlib.uuid4()), "SharedProcessorPool",
                                                           _tag("PoolID", i) + _tag("PoolName", n)) for i, n in s["pools"]]))
            if kind in ("LogicalPartition", "VirtualIOServer"):
                want_vios = kind == "VirtualIOServer"
                lps = [lp for lp in s["lpars"] if lp["vios"] == want_vios]
                if not lps:
                    return httpx.Response(204)
                return httpx.Response(200, content=_feed([(lp["uuid"], kind, self._lpar_xml(lp)) for lp in lps]))
        return httpx.Response(404)


_instances: dict[str, DemoHMC] = {}


def transport_for(host: str) -> httpx.MockTransport:
    if host not in _instances:
        _instances[host] = DemoHMC(host)
    return httpx.MockTransport(_instances[host].handle)
