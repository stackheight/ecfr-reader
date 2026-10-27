"""The Dockets tab's backend against a fake regulations.gov: the client,
the resumable catalog sync, and the routes. urlopen is replaced, so nothing
here touches the network; the fixtures are trimmed live responses."""
import io
import json
import os
import urllib.error
import urllib.request
from email.message import Message

import pytest

HERE = os.path.dirname(__file__)
FIX = os.path.join(HERE, "fixtures", "regsgov")
DOCKET = "EPA-HQ-OAR-2021-0317"


def _fixture(name):
    with open(os.path.join(FIX, name), "rb") as f:
        return f.read()


class _Resp(io.BytesIO):
    def __init__(self, body, remaining=900):
        super().__init__(body)
        self.headers = Message()
        self.headers["X-RateLimit-Limit"] = "1000"
        self.headers["X-RateLimit-Remaining"] = str(remaining)
        self.status = 200
    def __enter__(self): return self
    def __exit__(self, *a): pass


def _http_error(url, code, body=b"", retry_after=None):
    hdrs = Message()
    hdrs["X-RateLimit-Limit"] = "1000"
    hdrs["X-RateLimit-Remaining"] = "0" if code == 429 else "899"
    if retry_after:
        hdrs["Retry-After"] = str(retry_after)
    return urllib.error.HTTPError(url, code, "reason", hdrs, io.BytesIO(body))


@pytest.fixture
def regs_gov(monkeypatch):
    """A fake api.regulations.gov + downloads.regulations.gov. `calls` lists
    every (url, X-Api-Key) requested; `files[url]` makes a download succeed
    with those bytes (otherwise the host says 403, as the real one does)."""
    from ecfr_reader.dockets import client
    monkeypatch.setenv("REGSGOV_API_KEY", "test-key")
    monkeypatch.setattr(client, "PAUSE_S", 0)
    monkeypatch.setattr(client, "last_rate", {"limit": None, "remaining": None, "at": None})
    state = {"calls": [], "files": {}, "remaining": 900, "fail": None}

    def fake_urlopen(req, timeout=0):
        url = req.full_url
        state["calls"].append((url, req.get_header("X-api-key")))
        if "downloads.regulations.gov" in url:
            if url in state["files"]:
                return _Resp(state["files"][url])
            raise _http_error(url, 403)
        if state["fail"]:
            raise _http_error(url, state["fail"], b'{"errors":[{"detail":"nope"}]}', retry_after=120)
        if f"/dockets/{DOCKET}" in url:
            return _Resp(_fixture("docket.json"), state["remaining"])
        if "/dockets?" in url:
            return _Resp(_fixture("dockets_search.json"), state["remaining"])
        if "/comments?" in url:
            return _Resp(_fixture("comments_count.json"), state["remaining"])
        if "/documents?" in url:
            from urllib.parse import parse_qs, urlparse
            dtype = parse_qs(urlparse(url).query).get("filter[documentType]", [""])[0]
            name = dtype.lower().replace(" & ", "_").replace(" ", "_")
            return _Resp(_fixture(f"documents_{name}.json"), state["remaining"])
        if "/documents/" in url:
            doc_id = url.split("/documents/")[1].split("?")[0]
            body = json.loads(_fixture("document_detail.json"))
            body["data"]["id"] = doc_id
            for k in ("documentType", "subtype", "title"):    # one detail body serves every document
                body["data"]["attributes"].pop(k, None)
            for ff in body["data"]["attributes"]["fileFormats"]:
                ff["fileUrl"] = ff["fileUrl"].replace("EPA-HQ-OAR-2021-0317-3859", doc_id)
            for inc in body["included"]:
                for ff in inc["attributes"]["fileFormats"]:
                    ff["fileUrl"] = ff["fileUrl"].replace("EPA-HQ-OAR-2021-0317-3859", doc_id)
            if doc_id.endswith("-3000"):
                raise _http_error(url, 404, b'{"errors":[{"detail":"withdrawn"}]}')
            return _Resp(json.dumps(body).encode(), state["remaining"])
        raise AssertionError(f"unexpected url {url}")
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    return state


# ── client ─────────────────────────────────────────────────────────────

def test_client_requires_the_key_and_sends_it(data_dir, regs_gov, monkeypatch):
    from ecfr_reader.dockets import client
    d = client.docket(DOCKET)
    assert d["id"] == DOCKET and d["shortTitle"].startswith("NSPS") and "methane" in d["keywords"]
    assert regs_gov["calls"][0][1] == "test-key"
    assert client.last_rate["remaining"] == 900 and client.quota_left() == 900
    monkeypatch.delenv("REGSGOV_API_KEY")
    with pytest.raises(client.RegsGovError, match="REGSGOV_API_KEY"):
        client.docket(DOCKET)
    assert len(regs_gov["calls"]) == 1          # refused before any request


def test_client_names_the_failure(data_dir, regs_gov):
    from ecfr_reader.dockets import client
    regs_gov["fail"] = 429
    with pytest.raises(client.RegsGovError, match="hourly") as e:
        client.docket(DOCKET)
    assert e.value.status == 429 and e.value.retry_after == 120 and client.quota_left() == 0
    regs_gov["fail"] = 403
    with pytest.raises(client.RegsGovError, match="API key"):
        client.docket(DOCKET)


def test_client_lists_documents_and_files(data_dir, regs_gov):
    from ecfr_reader.dockets import client
    page = client.documents(DOCKET, "Supporting & Related Material")
    assert page["total"] == 2 and page["pages"] == 1 and page["subtypes"] == {"Meeting Materials": 1, "Data": 1}
    assert "filter%5BdocumentType%5D=Supporting+%26+Related+Material" in regs_gov["calls"][-1][0]
    d = client.document("EPA-HQ-OAR-2021-0317-3859")
    assert d["detail"]["pageCount"] == 12
    assert [(f["format"], f["doc_order"]) for f in d["files"]] == [("pdf", 0), ("xlsx", 1)]
    assert d["files"][1]["attachment_title"].startswith("Emissions calculations")
    assert client.comment_count("0900006484c00001") == 1234
    assert client.search_dockets("oil and gas", "EPA")[0]["id"] == DOCKET


def test_download_is_one_honest_attempt(data_dir, regs_gov, tmp_path):
    from ecfr_reader.dockets import client
    url = "https://downloads.regulations.gov/X-1/content.pdf"
    with pytest.raises(client.RefusedByFileHost, match="only serves browsers"):
        client.download(url, str(tmp_path / "a" / "content.pdf"))
    assert not (tmp_path / "a" / "content.pdf").exists() and not (tmp_path / "a" / "content.pdf.tmp").exists()
    regs_gov["files"][url] = b"%PDF-1.4 fake"
    r = client.download(url, str(tmp_path / "a" / "content.pdf"))
    assert r["size"] == 13 and (tmp_path / "a" / "content.pdf").read_bytes() == b"%PDF-1.4 fake"
    with pytest.raises(client.RegsGovError, match="not a regulations.gov file"):
        client.download("https://example.org/x.pdf", str(tmp_path / "b.pdf"))
    assert all("example.org" not in u for u, _ in regs_gov["calls"])


# ── sync ───────────────────────────────────────────────────────────────

def test_sync_catalogs_a_docket(data_dir, regs_gov):
    from ecfr_reader.dockets import store, sync
    store.init_db()
    state = sync.sync_docket(DOCKET, pull="data")
    # 1 docket + 5 type lists + 4 details + 2 comment counts = 12 API requests, then the files
    assert state["requests"] == 12 and state["types"]["Supporting & Related Material"] == 2
    assert state["stopped_reason"] == "files_refused" and state["phase"] == "files"
    d = store.get_docket(DOCKET)
    assert d["short_title"].startswith("NSPS") and d["sync_state"]["stopped_reason"] == "files_refused"
    s = store.docket_summary(DOCKET)
    assert s["documents"] == 4 and s["pending"] == 0 and s["types"] == {"Proposed Rule": 1, "Rule": 1,
                                                                        "Supporting & Related Material": 2}
    assert s["formats"] == {"pdf": 3, "xlsx": 3} and s["files"] == 6 and s["local_files"] == 0
    docs = store.list_documents(DOCKET)["rows"]
    assert [r["document_id"][-4:] for r in docs] == ["3859", "3000", "0100", "0001"]   # newest first
    rule = store.get_document("EPA-HQ-OAR-2021-0317-0001")
    assert rule["comment_count"] == 1234 and rule["fr_citation"] is None and rule["abstract"].startswith("Presentation")
    missing = store.get_document("EPA-HQ-OAR-2021-0317-3000")      # 404 on detail: recorded, not fatal
    assert missing["has_detail"] and missing["files"] == [] and missing["comment_count"] == 1234
    # the one xlsx the files phase tried carries the host's refusal; the others are untouched
    errs = [f for r in docs for f in r["files"] if f["download_error"]]
    assert len(errs) == 1 and "browser" in errs[0]["download_error"]
    assert sum(1 for u, _ in regs_gov["calls"] if "downloads." in u) == 1


def test_sync_resumes_from_pending_rows_and_respects_the_reserve(data_dir, regs_gov):
    from ecfr_reader.dockets import client, store, sync
    store.init_db()
    seen = []

    def stop_after_list():
        return any(s["phase"] == "details" for s in seen)
    state = sync.sync_docket(DOCKET, pull="none", progress=lambda s: seen.append(dict(s)),
                             should_stop=stop_after_list)
    assert state["stopped_reason"] == "cancelled" and store.pending_details(DOCKET) == [
        "EPA-HQ-OAR-2021-0317-0001", "EPA-HQ-OAR-2021-0317-0100", "EPA-HQ-OAR-2021-0317-3000",
        "EPA-HQ-OAR-2021-0317-3859"]
    n = len(regs_gov["calls"])
    state = sync.sync_docket(DOCKET, pull="none")
    assert state["phase"] == "done" and state["stopped_reason"] is None
    assert len(regs_gov["calls"]) - n == 12 and store.pending_details(DOCKET) == []
    assert store.get_docket(DOCKET)["synced_at"]
    # the reserve: with the hour nearly spent the job pauses before asking anything
    client.last_rate["remaining"] = client.RESERVE
    state = sync.sync_docket(DOCKET, pull="none")
    assert state["stopped_reason"] == "quota" and "resets on the hour" in state["message"]
    assert len(regs_gov["calls"]) - n == 12


def test_sync_pulls_what_the_host_allows(data_dir, regs_gov):
    from ecfr_reader import config
    from ecfr_reader.dockets import store, sync
    store.init_db()
    for doc in ("0001", "0100", "3859"):
        regs_gov["files"][f"https://downloads.regulations.gov/EPA-HQ-OAR-2021-0317-{doc}/attachment_1.xlsx"] = b"PK..xlsx"
    state = sync.sync_docket(DOCKET, pull="xlsx")
    assert state["phase"] == "done" and state["total"] == 3 and state["done"] == 3
    s = store.docket_summary(DOCKET)
    assert s["local_files"] == 3
    f = [x for x in store.get_document("EPA-HQ-OAR-2021-0317-0100")["files"] if x["format"] == "xlsx"][0]
    assert f["local"] and f["local_size"] == 8
    kept = os.path.join(config.dockets_dir(), DOCKET, "EPA-HQ-OAR-2021-0317-0100", "attachment_1.xlsx")
    assert open(kept, "rb").read() == b"PK..xlsx"


# ── routes ─────────────────────────────────────────────────────────────

def test_home_loads_without_a_key_and_add_says_what_is_missing(empty_client, monkeypatch):
    monkeypatch.delenv("REGSGOV_API_KEY", raising=False)
    home = empty_client.get("/api/dockets").get_json()
    assert home["dockets"] == [] and home["key_set"] is False and home["totals"]["documents"] == 0
    r = empty_client.post("/api/dockets", json={"docket_id": DOCKET})
    assert r.status_code == 502 and r.get_json()["key_missing"] and "api.data.gov" in r.get_json()["signup_url"]
    assert empty_client.post("/api/dockets", json={"docket_id": "../x"}).status_code == 400
    assert empty_client.get("/api/dockets/search?q=o").status_code == 400
    assert empty_client.get("/api/dockets/NOPE-1").status_code == 404


def test_add_sync_filter_upload_and_serve(empty_client, regs_gov):
    from ecfr_reader import config
    from ecfr_reader.dockets import sync
    c = empty_client
    r = c.post("/api/dockets", json={"docket_id": DOCKET.lower(), "pull": "none"})
    assert r.status_code == 201 and r.get_json()["docket"]["docket_id"] == DOCKET
    sync.wait(DOCKET, timeout=10)
    d = c.get(f"/api/dockets/{DOCKET}").get_json()
    assert d["sync"]["phase"] == "done" and d["sync"]["running"] is False and d["summary"]["documents"] == 4
    assert d["keywords"][0].startswith("40 CFR part 60")
    assert c.get("/api/dockets").get_json()["dockets"][0]["file_count"] == 6

    rows = c.get(f"/api/dockets/{DOCKET}/documents?format=xlsx&type=Supporting+%26+Related+Material").get_json()
    assert rows["total"] == 2 and all(any(f["format"] == "xlsx" for f in r["files"]) for r in rows["rows"])
    assert c.get(f"/api/dockets/{DOCKET}/documents?q=impact+workbook").get_json()["total"] == 1
    assert c.get(f"/api/dockets/{DOCKET}/documents?subtype=Data").get_json()["rows"][0]["document_id"].endswith("0100")
    assert c.get(f"/api/dockets/{DOCKET}/documents?sort=title&limit=2").get_json()["rows"][0]["title"].startswith("01.17")
    assert c.get(f"/api/dockets/{DOCKET}/documents?local=1").get_json()["total"] == 0

    doc = c.get("/api/dockets/documents/EPA-HQ-OAR-2021-0317-3859").get_json()
    xlsx = [f for f in doc["files"] if f["format"] == "xlsx"][0]
    assert xlsx["size"] == 48213 and xlsx["local"] is False
    # a server-side attempt is refused by the file host, and says what to do instead
    r = c.post(f"/api/dockets/files/{xlsx['id']}/fetch")
    assert r.status_code == 502 and r.get_json()["refused"] and "drop" in r.get_json()["error"]
    assert c.get(f"/api/dockets/files/{xlsx['id']}").status_code == 404
    # the drop zone: a browser download of the right size files itself under the catalogued row
    body = b"x" * 48213
    r = c.post("/api/dockets/documents/EPA-HQ-OAR-2021-0317-3859/upload",
               data={"file": (io.BytesIO(body), "attachment_1.xlsx")}, content_type="multipart/form-data")
    assert r.status_code == 201 and r.get_json()["matched"] and r.get_json()["file"]["id"] == xlsx["id"]
    served = c.get(f"/api/dockets/files/{xlsx['id']}")
    assert served.status_code == 200 and served.data == body
    assert served.mimetype.endswith("spreadsheetml.sheet") and "attachment" in served.headers["Content-Disposition"]
    # an unknown file is kept as an extra on the document; a hostile name cannot escape the library
    r = c.post("/api/dockets/documents/EPA-HQ-OAR-2021-0317-3859/upload",
               data={"file": (io.BytesIO(b"hello"), "../../../etc/passwd.csv")}, content_type="multipart/form-data")
    assert r.status_code == 201 and r.get_json()["matched"] is False
    kept = r.get_json()["file"]["local_path"]
    assert ".." not in kept and os.path.isfile(os.path.join(config.dockets_dir(), kept))
    assert len(c.get("/api/dockets/documents/EPA-HQ-OAR-2021-0317-3859").get_json()["files"]) == 3
    assert c.get(f"/api/dockets/{DOCKET}/documents?local=1").get_json()["total"] == 1
    # search goes upstream once, then the cache answers
    n = len(regs_gov["calls"])
    assert c.get("/api/dockets/search?q=oil+and+gas").get_json()["results"][0]["id"] == DOCKET
    assert c.get("/api/dockets/search?q=oil+and+gas").get_json()["cached"] is True and len(regs_gov["calls"]) == n + 1
    # resume through the route, then untrack with the files
    assert c.post(f"/api/dockets/{DOCKET}/sync", json={"pull": "none"}).status_code == 202
    sync.wait(DOCKET, timeout=10)
    assert c.delete(f"/api/dockets/{DOCKET}?files=1").get_json()["files_removed"] is True
    assert c.get(f"/api/dockets/{DOCKET}").status_code == 404
    assert not os.path.exists(os.path.join(config.dockets_dir(), DOCKET))


def test_cli_lists_and_syncs(data_dir, regs_gov, capsys):
    from ecfr_reader.__main__ import main
    assert main(["dockets", "list"]) == 0
    assert "no dockets tracked yet" in capsys.readouterr().out
    assert main(["dockets", "add", DOCKET, "--pull", "none"]) == 0
    out = capsys.readouterr().out
    assert "tracking" in out and "details: 4/4" in out and "complete: 12 requests" in out
    main(["dockets", "list"])
    assert "4 documents (0 without detail)" in capsys.readouterr().out
    main(["status"])
    assert "REGSGOV_API_KEY set" in capsys.readouterr().out
