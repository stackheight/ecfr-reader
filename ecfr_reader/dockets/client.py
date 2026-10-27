"""Stdlib client for the regulations.gov v4 API
(https://open.gsa.gov/api/regulationsgov/): dockets, their documents, each
document's files and attachments, and a docket search. Written from the
public OpenAPI description with urllib.request only.

Being a good client: every request carries the api.data.gov key the user
registered (REGSGOV_API_KEY — DEMO_KEY is never substituted, it is 30
requests an hour shared by everyone behind the same address) and an
identifying User-Agent; the sync paces itself (PAUSE_S) and keeps RESERVE
requests of the hourly 1,000 unspent so the tab stays usable after a sync.
The quota headers (X-RateLimit-Limit / -Remaining) are read on every
response and kept in `last_rate` for the UI.

Files live on downloads.regulations.gov, which answers HTTP 403 to clients
that are not a browser. download() makes one honest attempt with this
tool's own User-Agent and reports the refusal; it does not pretend to be a
browser. The reader's answer is to open the file in the user's browser and
file the download back into the catalog.
"""

import gzip
import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from .. import config

BASE_URL = "https://api.regulations.gov/v4"
TIMEOUT = 30
DOWNLOAD_TIMEOUT = 120
PAGE_SIZE = 250          # the API's maximum
MAX_PAGE = 20            # and its last page: 5,000 rows per query
PAUSE_S = 0.6            # between requests in a sync
RESERVE = 25             # requests of the hour left for browsing
DOCUMENT_TYPES = ("Proposed Rule", "Rule", "Notice", "Supporting & Related Material", "Other")

# The last quota headers seen: {"limit", "remaining", "at"} — what the
# dockets home shows as "quota remaining". Process-wide, like the key.
last_rate = {"limit": None, "remaining": None, "at": None}


class RegsGovError(Exception):
    """A regulations.gov request failed. .args[0] is safe to show in the UI.
    .status is the HTTP status when there was one, .retry_after seconds
    when the server said so (a 429)."""

    def __init__(self, message, status=None, retry_after=None):
        super().__init__(message)
        self.status = status
        self.retry_after = retry_after


class RefusedByFileHost(RegsGovError):
    """downloads.regulations.gov said 403: the file is there, but only a
    browser gets it. The UI turns this into "open it, then drop it here"."""


def _body(resp) -> bytes:
    data = resp.read()
    if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
        return gzip.decompress(data)
    return data


def _api_key() -> str:
    try:
        return config.require_regsgov_api_key()
    except RuntimeError as e:
        raise RegsGovError(str(e)) from None


def _note_rate(headers) -> None:
    limit = headers.get("X-RateLimit-Limit")
    remaining = headers.get("X-RateLimit-Remaining")
    if limit is None and remaining is None:
        return
    try:
        last_rate.update({"limit": int(limit) if limit is not None else None,
                          "remaining": int(remaining) if remaining is not None else None,
                          "at": datetime.now(timezone.utc).isoformat()})
    except ValueError:
        pass


def _server_message(err) -> str:
    """The API's own explanation of a 4xx (JSON:API errors[].detail), when
    it sends one."""
    try:
        text = _body(err).decode("utf-8", "replace")
        d = json.loads(text)
    except Exception:
        return ""
    errs = d.get("errors") or []
    if errs and isinstance(errs, list):
        return (errs[0].get("detail") or errs[0].get("title") or "").strip()
    return (d.get("message") or "").strip()


def _get(path: str, params: dict = None) -> dict:
    """GET one API resource as JSON. Raises RegsGovError with a readable
    reason; a 429 carries retry_after."""
    key = _api_key()
    url = f"{BASE_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={
        "User-Agent": config.regsgov_user_agent(), "X-Api-Key": key,
        "Accept": "application/vnd.api+json, application/json", "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            _note_rate(resp.headers)
            return json.loads(_body(resp).decode("utf-8"))
    except urllib.error.HTTPError as e:
        _note_rate(e.headers)
        detail = _server_message(e)
        if e.code == 429:
            retry = e.headers.get("Retry-After")
            try:
                retry = int(retry) if retry is not None else None
            except ValueError:
                retry = None
            raise RegsGovError("regulations.gov says the hourly request limit for this key is used "
                               "up (HTTP 429). The quota resets on the hour; a sync resumes where it "
                               "stopped.", status=429, retry_after=retry) from e
        if e.code == 403:
            raise RegsGovError("regulations.gov rejected the API key (HTTP 403). Check REGSGOV_API_KEY"
                               + (f": {detail}" if detail else "."), status=403) from e
        if e.code == 404:
            raise RegsGovError(f"regulations.gov has no such record (HTTP 404)"
                               + (f": {detail}" if detail else "."), status=404) from e
        raise RegsGovError(f"regulations.gov returned HTTP {e.code}"
                           + (f" ({detail or e.reason})." if (detail or e.reason) else "."), status=e.code) from e
    except TimeoutError as e:
        raise RegsGovError(f"regulations.gov took longer than {TIMEOUT} s to answer (timed out).") from e
    except urllib.error.URLError as e:
        if isinstance(e.reason, TimeoutError):
            raise RegsGovError(f"regulations.gov took longer than {TIMEOUT} s to answer (timed out).") from e
        raise RegsGovError(f"Couldn't reach regulations.gov ({e.reason}).") from e
    except ValueError as e:
        raise RegsGovError(f"regulations.gov sent something that is not JSON ({e}).") from e


# ── Resources ──────────────────────────────────────────────────────────

def docket(docket_id: str) -> dict:
    """GET /dockets/{id} → the docket's attributes plus "id"."""
    d = _get(f"/dockets/{urllib.parse.quote(docket_id, safe='')}")
    data = d.get("data") or {}
    out = dict(data.get("attributes") or {})
    out["id"] = data.get("id") or docket_id
    return out


def search_dockets(term: str, agency: str = None) -> list:
    """GET /dockets?filter[searchTerm]=… (one request, ≤ 25 rows):
    [{id, title, docketType, agencyId, lastModifiedDate}]."""
    params = {"filter[searchTerm]": term, "page[size]": 25, "sort": "-lastModifiedDate"}
    if agency:
        params["filter[agencyId]"] = agency
    d = _get("/dockets", params)
    rows = []
    for item in d.get("data") or []:
        a = item.get("attributes") or {}
        rows.append({"id": item.get("id"), "title": a.get("title"), "docketType": a.get("docketType"),
                     "agencyId": a.get("agencyId"), "lastModifiedDate": a.get("lastModifiedDate")})
    return rows


def documents(docket_id: str, document_type: str = None, page: int = 1,
              sort: str = "postedDate,documentId") -> dict:
    """One page (PAGE_SIZE rows) of a docket's documents, optionally one
    type: {"rows": [{id, …list attributes}], "total": N, "pages": P,
    "subtypes": {label: count}}. The list endpoint carries no files — those
    come from document()."""
    params = {"filter[docketId]": docket_id, "page[size]": PAGE_SIZE,
              "page[number]": max(1, min(int(page), MAX_PAGE)), "sort": sort}
    if document_type:
        params["filter[documentType]"] = document_type
    d = _get("/documents", params)
    meta = d.get("meta") or {}
    rows = []
    for item in d.get("data") or []:
        a = dict(item.get("attributes") or {})
        a["id"] = item.get("id")
        rows.append(a)
    subtypes = {}
    for agg in (meta.get("aggregations") or {}).get("subtype") or []:
        if agg.get("label"):
            subtypes[agg["label"]] = agg.get("docCount") or 0
    return {"rows": rows, "total": meta.get("totalElements") or len(rows),
            "pages": meta.get("totalPages") or 1, "subtypes": subtypes}


def document(document_id: str) -> dict:
    """GET /documents/{id}?include=attachments → {"detail": attributes,
    "files": [{file_url, format, size, attachment_title, doc_order,
    restricted}]} — the document's own files first (doc_order 0), then
    each attachment's in its order."""
    d = _get(f"/documents/{urllib.parse.quote(document_id, safe='')}", {"include": "attachments"})
    data = d.get("data") or {}
    detail = dict(data.get("attributes") or {})
    detail["id"] = data.get("id") or document_id
    files = []
    for ff in detail.get("fileFormats") or []:
        if ff.get("fileUrl"):
            files.append({"file_url": ff["fileUrl"], "format": (ff.get("format") or "").lower(),
                          "size": ff.get("size"), "attachment_title": None, "doc_order": 0,
                          "restricted": None})
    for att in sorted(d.get("included") or [], key=lambda x: (x.get("attributes") or {}).get("docOrder") or 0):
        a = att.get("attributes") or {}
        for ff in a.get("fileFormats") or []:
            if ff.get("fileUrl"):
                files.append({"file_url": ff["fileUrl"], "format": (ff.get("format") or "").lower(),
                              "size": ff.get("size"), "attachment_title": a.get("title"),
                              "doc_order": a.get("docOrder") or 0,
                              "restricted": a.get("restrictReason") or None})
    return {"detail": detail, "files": files}


def comment_count(object_id: str) -> int:
    """How many public comments a document drew: GET /comments?filter[commentOnId]
    asking for the smallest page and reading meta.totalElements."""
    d = _get("/comments", {"filter[commentOnId]": object_id, "page[size]": 5})
    return int((d.get("meta") or {}).get("totalElements") or 0)


def quota_left() -> int:
    """Requests left this hour by the last headers seen, or a large number
    when none have been seen yet (the first request tells)."""
    r = last_rate.get("remaining")
    return 10 ** 6 if r is None else r


# ── Files ──────────────────────────────────────────────────────────────

def download(url: str, dest: str) -> dict:
    """One honest attempt to fetch a catalogued file to `dest` (written via
    dest + ".tmp", then renamed). Returns {"size", "sha256"}. Raises
    RefusedByFileHost on 403 — the host only serves browsers — and
    RegsGovError otherwise. Not an API request: no key, no quota."""
    import hashlib
    host = urllib.parse.urlparse(url).hostname or ""
    if not host.endswith("regulations.gov"):
        raise RegsGovError(f"Refusing to download from {host or url!r}: not a regulations.gov file.")
    req = urllib.request.Request(url, headers={"User-Agent": config.regsgov_user_agent(), "Accept": "*/*"})
    tmp = dest + ".tmp"
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    sha = hashlib.sha256()
    size = 0
    try:
        with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT) as resp, open(tmp, "wb") as f:
            while True:
                chunk = resp.read(1 << 16)
                if not chunk:
                    break
                f.write(chunk)
                sha.update(chunk)
                size += len(chunk)
    except urllib.error.HTTPError as e:
        _discard(tmp)
        if e.code == 403:
            raise RefusedByFileHost("The file host (downloads.regulations.gov) only serves browsers "
                                    "(HTTP 403). Open the file, then drop the download on the document "
                                    "to keep a copy here.", status=403) from e
        raise RegsGovError(f"The file host returned HTTP {e.code} ({e.reason}).", status=e.code) from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        _discard(tmp)
        raise RegsGovError(f"Couldn't download the file ({e}).") from e
    os.replace(tmp, dest)
    return {"size": size, "sha256": sha.hexdigest()}


def _discard(path):
    try:
        os.remove(path)
    except OSError:
        pass
