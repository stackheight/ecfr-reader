"""The catalog job: everything regulations.gov knows about a docket's agency
documents, fetched in phases and saved as it goes, so it can stop (quota,
429, the user) and resume from the rows still pending.

    docket    GET /dockets/{id}                              1 request
    list      GET /documents?filter[docketId]&filter[documentType]
              one query per document type, 250 rows a page     ~5–10
    details   GET /documents/{id}?include=attachments          1 per document
              (the only place a document's files are listed)
    comments  GET /comments?filter[commentOnId]                1 per rule
    files     downloads.regulations.gov, the formats in `pull`  0 requests of quota

The job keeps client.RESERVE requests of the hour unspent and sleeps
client.PAUSE_S between requests. Public comments are counted, not
catalogued — a big docket has tens of thousands.

Progress is written to dockets.sync_state_json as
{phase, done, total, types, requests, started_at, updated_at, finished_at,
 stopped_reason, message} and the Flask route runs the job in a thread
(start / status below); the CLI runs it inline.
"""

import os
import threading
import time
import urllib.parse
from datetime import datetime, timezone

from .. import config
from . import client, store
from .client import RegsGovError, RefusedByFileHost

PULL_SETS = {"data": None, "all": {"*"}, "none": set()}   # "data" → config.auto_pull_formats()


class Stop(Exception):
    """Raised inside the job to end it cleanly with a reason."""

    def __init__(self, reason, message=None):
        super().__init__(reason)
        self.reason = reason
        self.message = message


def _now():
    return datetime.now(timezone.utc).isoformat()


def resolve_pull(pull):
    """'data' | 'all' | 'none' | iterable of formats → the set of formats to
    download ({'*'} meaning every format)."""
    if pull is None or pull == "data":
        return config.auto_pull_formats()
    if isinstance(pull, str):
        if pull in PULL_SETS:
            return PULL_SETS[pull]
        return {f.strip().lower().lstrip(".") for f in pull.split(",") if f.strip()}
    return {str(f).lower() for f in pull}


class Job:
    def __init__(self, docket_id, pull="data", progress=None, should_stop=None):
        self.docket_id = docket_id
        self.pull = resolve_pull(pull)
        self.progress = progress or (lambda state: None)
        self.should_stop = should_stop or (lambda: False)
        self.state = {"phase": "docket", "done": 0, "total": 0, "types": {}, "requests": 0,
                      "started_at": _now(), "updated_at": None, "finished_at": None,
                      "stopped_reason": None, "message": None, "pull": sorted(self.pull)}
        self._last_save = 0.0

    # ── bookkeeping ──
    def _save(self, force=False):
        self.state["updated_at"] = _now()
        if force or time.monotonic() - self._last_save > 1.0:
            store.set_sync_state(self.docket_id, self.state)
            self._last_save = time.monotonic()
        self.progress(self.state)

    def _request_gate(self):
        """Before each API request: stop if asked, or if the hour's quota is
        down to the reserve; otherwise pace."""
        if self.should_stop():
            raise Stop("cancelled", "Stopped by you; run Sync again to continue.")
        left = client.quota_left()
        if left <= client.RESERVE:
            raise Stop("quota", f"Paused with {left} requests left this hour (keeping {client.RESERVE} for "
                                "browsing). The quota resets on the hour; Sync again then to continue.")
        if self.state["requests"]:
            time.sleep(client.PAUSE_S)
        self.state["requests"] += 1

    def _phase(self, name, total=0):
        self.state.update({"phase": name, "done": 0, "total": total})
        self._save(force=True)

    # ── phases ──
    def run(self):
        try:
            self._docket()
            self._list()
            self._details()
            self._comments()
            self._files()
            self.state.update({"phase": "done", "stopped_reason": None, "message": None, "finished_at": _now()})
            store.set_sync_state(self.docket_id, self.state, synced=True)
            self.progress(self.state)
        except Stop as s:
            self.state.update({"stopped_reason": s.reason, "message": s.message, "finished_at": _now()})
            self._save(force=True)
        except RegsGovError as e:
            reason = "rate_limited" if e.status == 429 else "error"
            self.state.update({"stopped_reason": reason, "message": str(e), "finished_at": _now()})
            self._save(force=True)
        return self.state

    def _docket(self):
        self._phase("docket", 1)
        self._request_gate()
        store.upsert_docket(client.docket(self.docket_id))
        self.state["done"] = 1
        self._save(force=True)

    def _list(self):
        self._phase("list", len(client.DOCUMENT_TYPES))
        for i, dtype in enumerate(client.DOCUMENT_TYPES):
            page, total = 1, None
            while True:
                self._request_gate()
                r = client.documents(self.docket_id, dtype, page)
                store.upsert_documents(self.docket_id, r["rows"])
                total = r["total"]
                if page >= r["pages"] or not r["rows"] or page >= client.MAX_PAGE:
                    break
                page += 1
            self.state["types"][dtype] = total or 0
            self.state["done"] = i + 1
            self._save()

    def _details(self):
        pending = store.pending_details(self.docket_id)
        self._phase("details", len(pending))
        for i, doc_id in enumerate(pending):
            self._request_gate()
            try:
                r = client.document(doc_id)
            except RegsGovError as e:
                if e.status == 404:          # withdrawn between list and detail: record the gap, move on
                    store.set_detail(doc_id, {"docAbstract": None, "_missing": str(e)}, [])
                    continue
                raise
            store.set_detail(doc_id, r["detail"], r["files"])
            self.state["done"] = i + 1
            self._save()

    def _comments(self):
        pending = store.pending_comment_counts(self.docket_id)
        self._phase("comments", len(pending))
        for i, (doc_id, object_id) in enumerate(pending):
            self._request_gate()
            store.set_comment_count(doc_id, client.comment_count(object_id))
            self.state["done"] = i + 1
            self._save()

    def _files(self):
        formats = self.pull
        if not formats:
            return
        if "*" in formats:
            formats = set(store.docket_summary(self.docket_id)["formats"]) - {""}
        todo = store.files_to_pull(self.docket_id, formats)
        self._phase("files", len(todo))
        for i, f in enumerate(todo):
            if self.should_stop():
                raise Stop("cancelled", "Stopped by you; run Sync again to continue.")
            try:
                pull_file(f)
            except RefusedByFileHost as e:
                store.mark_file_error(f["id"], str(e))
                raise Stop("files_refused", str(e))     # the host refuses all of them alike: one honest try
            except RegsGovError as e:
                store.mark_file_error(f["id"], str(e))
            self.state["done"] = i + 1
            self._save()


def local_path_for(f: dict) -> str:
    """<docket>/<document>/<basename of the URL path>, relative to dockets_dir()."""
    name = os.path.basename(urllib.parse.urlparse(f["file_url"]).path) or f"file-{f['id']}"
    return os.path.join(_safe(f["docket_id"]), _safe(f["document_id"]), _safe(name))


def _safe(s: str) -> str:
    from werkzeug.utils import secure_filename
    return secure_filename(s) or "x"


def pull_file(f: dict) -> dict:
    """One honest download of a catalogued file into the library; records
    the result. Raises RefusedByFileHost / RegsGovError (also recorded)."""
    rel = local_path_for(f)
    dest = os.path.join(config.dockets_dir(), rel)
    r = client.download(f["file_url"], dest)
    store.mark_file_local(f["id"], rel, r["size"], r["sha256"])
    return {"local_path": rel, **r}


def sync_docket(docket_id, pull="data", progress=None, should_stop=None) -> dict:
    """Run the job inline (the CLI). Returns the final state."""
    return Job(docket_id, pull, progress, should_stop).run()


# ── Background jobs for the Flask process ──────────────────────────────

_jobs = {}            # docket_id -> {"thread", "state", "stop": Event}
_lock = threading.Lock()


def start(docket_id, pull="data") -> dict:
    """Start (or resume) the docket's sync in a daemon thread; one per
    docket at a time. Returns the live state."""
    with _lock:
        j = _jobs.get(docket_id)
        if j and j["thread"].is_alive():
            return j["state"]
        stop = threading.Event()
        holder = {"state": None, "stop": stop}

        def progress(state):
            holder["state"] = dict(state)

        job = Job(docket_id, pull, progress, stop.is_set)
        holder["state"] = dict(job.state)
        t = threading.Thread(target=job.run, name=f"docket-sync-{docket_id}", daemon=True)
        holder["thread"] = t
        _jobs[docket_id] = holder
        t.start()
        return holder["state"]


def stop(docket_id) -> bool:
    with _lock:
        j = _jobs.get(docket_id)
    if j and j["thread"].is_alive():
        j["stop"].set()
        return True
    return False


def status(docket_id) -> dict:
    """The live state when a job runs, else what the catalog last stored."""
    with _lock:
        j = _jobs.get(docket_id)
    if j:
        s = dict(j["state"] or {})
        s["running"] = j["thread"].is_alive()
        return s
    d = store.get_docket(docket_id)
    s = dict((d or {}).get("sync_state") or {})
    s["running"] = False
    return s


def wait(docket_id, timeout=None) -> None:
    """Block until the docket's job ends (tests, the CLI after start())."""
    with _lock:
        j = _jobs.get(docket_id)
    if j:
        j["thread"].join(timeout)
