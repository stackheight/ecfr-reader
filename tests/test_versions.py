"""The version timeline: a section's amendment dates and its text as of a
date, both from ecfr.gov, both cached. urlopen is replaced, so nothing
here touches the network."""
import io
import json
import os
import urllib.request
from email.message import Message

import pytest

HERE = os.path.dirname(__file__)
VERSIONS = open(os.path.join(HERE, "fixtures", "versions_60_4230.json"), "rb").read()
SECTION_XML = b'''<DIV8 N="999.10" TYPE="SECTION" hierarchy_metadata="{&quot;citation&quot;:&quot;40 CFR 999.10&quot;}">
<HEAD>\xc2\xa7 999.10 Definitions.</HEAD><P>The old wording of the first paragraph.</P></DIV8>'''


class _Resp(io.BytesIO):
    headers = Message()
    def __enter__(self): return self
    def __exit__(self, *a): pass


@pytest.fixture
def ecfr_gov(monkeypatch):
    """A fake ecfr.gov answering the versions and full-text endpoints;
    `calls` records every URL requested."""
    monkeypatch.setenv("ECFR_CONTACT", "t@example.org")
    calls = []

    def fake_urlopen(req, timeout=0):
        calls.append(req.full_url)
        if "/versions/" in req.full_url:
            return _Resp(VERSIONS)
        return _Resp(SECTION_XML)
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return calls


def test_section_versions_sorts_and_dedupes(ecfr_gov):
    from ecfr_reader.corpus.updates import section_versions
    r = section_versions("60", "60.4230")
    assert [v["date"] for v in r["versions"]] == ["2016-12-23", "2021-06-29", "2021-07-29"]
    assert r["versions"][0]["issue_date"] == "2017-01-01" and r["latest"] == "2021-07-29"
    assert "part=60" in ecfr_gov[0] and "section=60.4230" in ecfr_gov[0]


def test_versions_route_caches_for_a_day(client, ecfr_gov):
    r = client.get("/api/ecfr/section/versions?key=999:999.10").get_json()
    assert [v["date"] for v in r["versions"]] == ["2016-12-23", "2021-06-29", "2021-07-29"]
    assert r["local_snapshot_date"] == "2026-01-01" and r["cached"] is False
    again = client.get("/api/ecfr/section/versions?key=999:999.10").get_json()
    assert again["cached"] is True and len(ecfr_gov) == 1          # served from ecfr_cache
    client.get("/api/ecfr/section/versions?key=999:999.10&force=1")
    assert len(ecfr_gov) == 2
    assert client.get("/api/ecfr/section/versions?key=999:nope").status_code == 404
    assert client.get("/api/ecfr/section/versions").status_code == 400


def test_section_at_renders_and_caches_for_ever(client, ecfr_gov):
    r = client.get("/api/ecfr/section/at?key=999:999.10&date=2019-01-02")
    assert r.status_code == 200, r.get_json()
    d = r.get_json()
    assert d["as_of"] == "2019-01-02" and d["section_key"] == "999:999.10" and d["part"] == "999"
    assert d["blocks"][0]["text"].startswith("The old wording")
    assert "2019-01-02" in ecfr_gov[-1] and "section=999.10" in ecfr_gov[-1]
    client.get("/api/ecfr/section/at?key=999:999.10&date=2019-01-02")
    assert len(ecfr_gov) == 1                                        # the past never changes
    assert client.get("/api/ecfr/section/at?key=999:999.10&date=2019-1-2").status_code == 400
    assert client.get("/api/ecfr/section/at?key=999:999.10&date=2019-02-30").status_code == 400
    assert client.get("/api/ecfr/section/at?key=999:999.10&date=2999-01-01").status_code == 400
    assert client.get("/api/ecfr/section/at?key=999:nope&date=2019-01-02").status_code == 404


def test_versions_need_a_contact(client):
    r = client.get("/api/ecfr/section/versions?key=999:999.10")
    assert r.status_code == 502 and "ECFR_CONTACT" in r.get_json()["error"]
    r = client.get("/api/ecfr/section/at?key=999:999.10&date=2019-01-02")
    assert r.status_code == 502 and "ECFR_CONTACT" in r.get_json()["error"]
