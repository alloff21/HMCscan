import asyncio
from pathlib import Path

import pytest

from app.demo import transport_for
from app.hmc_client import HMCClient, HMCError, feed_entries, parse_partition, parse_xml

FIX = Path(__file__).parent / "fixtures"


def test_partition_from_hmc_feed():
    entries = feed_entries(parse_xml((FIX / "logical_partition.xml").read_bytes()))
    assert len(entries) == 1
    uuid, el = entries[0]
    lp = parse_partition(uuid, el, False, {0: "DefaultPool", 1: "ORA_Pool"})
    assert lp["name"] == "msk1-aix-ora01"
    assert lp["id"] == 7
    assert lp["type"] == "AIX"
    assert lp["state"] == "Running"
    assert lp["mode"] == "shared-uncapped"
    assert lp["ec"] == {"min": 0.5, "des": 2.5, "max": 5.0, "cur": 2.5}
    assert lp["vp"] == {"min": 1, "des": 6, "max": 12, "cur": 6}
    assert lp["weight"] == 128
    assert lp["pool"] == "ORA_Pool"
    assert lp["mem"] == {"min": 16.0, "des": 64.0, "max": 128.0, "cur": 64.0}
    assert lp["ame"] == 1.25
    assert lp["compat"] == "POWER9_base"
    assert lp["srr"] is True
    assert lp["phys_slots"] == 0
    assert lp["veth"] == 2
    assert lp["vfc"] is None
    assert lp["ref_code"] is None


def test_collect_against_demo_hmc():
    async def run():
        async with HMCClient("hmc-test.demo", 12443, "u", "p", transport=transport_for("hmc-test.demo")) as c:
            return await c.collect()

    data = asyncio.run(run())
    assert data["console"]["version"] == "V10R3 M1062"
    assert data["systems"]
    for s in data["systems"]:
        assert s["cpu"]["configurable"] >= s["cpu"]["available"] >= 0
        assert s["mem"]["assigned"] > 0
        assert sum(1 for l in s["lpars"] if l["type"] == "VIOS") == 2
        ded = [l for l in s["lpars"] if l["mode"].startswith("ded")]
        assert all(l["vp"] is None for l in ded)


def test_wrong_password_is_reported():
    async def run():
        async with HMCClient("hmc-test.demo", 12443, "u", "wrong", transport=transport_for("hmc-test.demo")):
            pass

    with pytest.raises(HMCError, match="401"):
        asyncio.run(run())
