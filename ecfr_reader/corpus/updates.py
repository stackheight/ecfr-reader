"""Stdlib client for the eCFR versioner API (https://www.ecfr.gov/developers)
— fetches part / subpart / section XML and checks whether the local
snapshot is behind ecfr.gov. The update check is NOTIFY-ONLY: it never
writes the corpus; refreshing is `ecfr-reader fetch` then `import`.

Written from scratch against the public API documentation with
urllib.request only. It contains no code from any third-party eCFR
client.
"""

import gzip
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from collections import defaultdict

from .. import config

BASE_URL = "https://www.ecfr.gov/api/versioner/v1"
TIMEOUT = 25
TITLE = 40


class EcfrApiError(Exception):
    """An ecfr.gov request failed or returned something we can't parse.
    .args[0] is a human-readable message safe to show in the UI."""
def _body(resp) -> bytes:
    """The response body, inflated when the server compressed it."""
    data = resp.read()
    if (resp.headers.get("Content-Encoding") or "").lower() == "gzip":
        return gzip.decompress(data)
    return data


def _server_message(err) -> str:
    """ecfr.gov's own explanation of a 4xx, when it sends one
    (<error><message>…</message></error>), so the user reads the reason
    and not just the status line."""
    try:
        text = _body(err).decode("utf-8", "replace")
    except Exception:
        return ""
    m = re.search(r"<message>(.*?)</message>", text, re.S)
    return m.group(1).strip() if m else ""




def _user_agent() -> str:
    """config.user_agent(), with a missing ECFR_CONTACT reported as the
    same error class every other ecfr.gov failure uses, so a route turns
    it into a 502 with the reason instead of a traceback."""
    try:
        return config.user_agent()
    except RuntimeError as e:
        raise EcfrApiError(str(e)) from None


def _get(path: str, params: dict = None) -> dict:
    url = f"{BASE_URL}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"User-Agent": _user_agent(), "Accept": "application/json", "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(_body(resp).decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise EcfrApiError(f"ecfr.gov returned HTTP {e.code} ({_server_message(e) or e.reason}).") from e
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise EcfrApiError(f"Couldn't reach ecfr.gov ({e}).") from e


def fetch_full_xml(date: str, part: str, identifier: str,
                    is_appendix: bool = False, title: int = TITLE) -> str:
    """Fetch the live XML for one section or appendix as of `date` (a value
    from latest_title_date()). Never called during rendering of local
    content — only from the reader's explicit "view live" toggle."""
    params = {"part": part, "appendix" if is_appendix else "section": identifier}
    return _fetch_xml(date, params, title)


def fetch_subpart_xml(date: str, part: str, subpart: str, title: int = TITLE) -> str:
    """Fetch a whole subpart's live XML in ONE request.

    The reader shows a subpart at a time, and asking for it a section at a
    time is ~23 requests for one screen — which ecfr.gov answers with HTTP 429,
    reasonably. The versioner's /full endpoint takes `subpart` directly:
    part 60 subpart JJJJ is 130 KB in 0.8s, and contains exactly the 23
    sections the local corpus has.

    Be a good citizen with this: it's one request, but a big one. The caller
    caches per section_key, so a subpart is fetched once per session.
    """
    return _fetch_xml(date, {"part": part, "subpart": subpart}, title)


def _fetch_xml(date: str, params: dict, title: int) -> str:
    url = f"{BASE_URL}/full/{date}/title-{title}.xml?" + urllib.parse.urlencode(params)
    # Accept-Encoding is REQUIRED here: since October 2026 the /full endpoint
    # answers a request that does not permit compression with HTTP 406
    # ("This endpoint requires response compression"). urllib sends none
    # by default, so it is set by hand and the body inflated by hand.
    req = urllib.request.Request(url, headers={"User-Agent": _user_agent(), "Accept-Encoding": "gzip"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return _body(resp).decode("utf-8")
    except urllib.error.HTTPError as e:
        # 429 is the one worth naming: it means we asked too fast, and the
        # caller can say so rather than "couldn't reach ecfr.gov", which would
        # send someone looking for a network fault that isn't there.
        if e.code == 429:
            raise EcfrApiError(
                "ecfr.gov is rate-limiting us (HTTP 429) — wait a moment and retry.") from e
        raise EcfrApiError(f"ecfr.gov returned HTTP {e.code} ({_server_message(e) or e.reason}).") from e
    except (urllib.error.URLError, TimeoutError) as e:
        raise EcfrApiError(f"Couldn't reach ecfr.gov ({e}).") from e


def _natural_key(part: str):
    return [int(s) if s.isdigit() else s for s in re.split(r"(\d+)", part or "")]


def _parts_scope(parts_spec: str) -> set:
    """'50-99' -> {'50', …, '99'}; '60,63' and '50-52,60' work too (strings,
    matching ecfr_sections.part)."""
    out = set()
    for piece in str(parts_spec).split(","):
        piece = piece.strip()
        if not piece:
            continue
        if "-" in piece:
            lo, hi = piece.split("-", 1)
            out.update(str(p) for p in range(int(lo), int(hi) + 1))
        else:
            out.add(str(int(piece)))
    return out


def latest_title_date(title: int = TITLE) -> str:
    data = _get("/titles.json")
    for entry in data.get("titles", []):
        if entry.get("number") == title:
            return entry.get("up_to_date_as_of")
    raise EcfrApiError(f"Title {title} not found in titles.json")


def check_updates(snapshot_date: str, parts_spec: str, title: int = TITLE) -> dict:
    """Compare the local corpus's snapshot_date to ecfr.gov. Costs 1 request
    if already up to date, 2 otherwise.

    Returns a JSON-serializable dict:
        {up_to_date, latest, snapshot_date,
         changed_parts: [{part, count, substantive, removed, sample, dates}]}
    Raises EcfrApiError on any request failure — callers decide whether to
    fall back to a cached result.
    """
    scope = _parts_scope(parts_spec)
    latest = latest_title_date(title)

    result = {"snapshot_date": snapshot_date, "latest": latest,
              "up_to_date": latest <= snapshot_date, "changed_parts": []}
    if result["up_to_date"]:
        return result

    data = _get(f"/versions/title-{title}.json",
                {"issue_date[gte]": snapshot_date})
    events = data.get("content_versions", [])
    # An event is new if it was amended after the snapshot, or published
    # (issue_date) after it — late-published amendments can be backdated.
    changes = [v for v in events
               if v.get("amendment_date", "") > snapshot_date
               or v.get("issue_date", "") > snapshot_date]

    by_part = defaultdict(list)
    for v in changes:
        if v.get("part") in scope:
            by_part[v["part"]].append(v)

    for part in sorted(by_part, key=_natural_key):
        vs = by_part[part]
        dates = sorted({v["amendment_date"] for v in vs if v.get("amendment_date")})
        result["changed_parts"].append({
            "part": part,
            "count": len(vs),
            "substantive": sum(1 for v in vs if v.get("substantive")),
            "removed": sum(1 for v in vs if v.get("removed")),
            "sample": [v.get("identifier", "") for v in vs[:6]],
            "dates": f"{dates[0]}–{dates[-1]}" if len(dates) > 1
                     else (dates[0] if dates else ""),
        })
    return result
