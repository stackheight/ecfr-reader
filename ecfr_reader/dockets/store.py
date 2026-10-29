"""The docket catalog — one SQLite file (config.dockets_db), deliberately
neither the corpus (which is rebuilt from the XML in seconds; a docket is
~700 API requests to rebuild) nor annotations.db (which holds the user's
own writing). Kept files sit beside it under config.dockets_dir():
<docket>/<document>/<file>, with paths stored relative to that directory.

Every function opens its own connection, like corpus/store.py.
"""

import json
import os
import re
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from .. import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS dockets (
    docket_id TEXT PRIMARY KEY,
    agency_id TEXT,
    title TEXT,
    short_title TEXT,
    abstract TEXT,
    docket_type TEXT,
    rin TEXT,
    keywords_json TEXT,
    modify_date TEXT,
    raw_json TEXT,
    added_at TEXT,
    synced_at TEXT,
    sync_state_json TEXT
);
CREATE TABLE IF NOT EXISTS documents (
    document_id TEXT PRIMARY KEY,
    docket_id TEXT NOT NULL,
    object_id TEXT,
    document_type TEXT,
    subtype TEXT,
    title TEXT,
    posted_date TEXT,
    last_modified TEXT,
    fr_doc_num TEXT,
    comment_start TEXT,
    comment_end TEXT,
    open_for_comment INTEGER,
    withdrawn INTEGER,
    abstract TEXT,
    cfr_part TEXT,
    fr_citation TEXT,
    page_count INTEGER,
    comment_count INTEGER,
    detail_json TEXT,
    detail_fetched_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_documents_docket ON documents(docket_id, posted_date);
-- One row per downloadable file: the document's own (doc_order 0) and
-- each attachment's. local_path is set when a copy is kept, relative to
-- config.dockets_dir(). file_url is NULL only for a dropped-in file that
-- matched no catalogued one.
CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    document_id TEXT NOT NULL,
    attachment_title TEXT,
    doc_order INTEGER NOT NULL DEFAULT 0,
    file_url TEXT UNIQUE,
    format TEXT,
    size INTEGER,
    restricted TEXT,
    local_path TEXT,
    local_size INTEGER,
    sha256 TEXT,
    downloaded_at TEXT,
    download_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_document ON files(document_id, doc_order, id);
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
    document_id UNINDEXED, title, abstract, subtype, tokenize='porter unicode61');
CREATE TABLE IF NOT EXISTS dockets_cache (
    key TEXT PRIMARY KEY, fetched_at TEXT NOT NULL, value TEXT NOT NULL);
-- A kept file read as proposed regulatory text (proposals/): the parsed
-- sections and paragraphs, keyed by enumerator path, with before/after.
CREATE TABLE IF NOT EXISTS proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_id INTEGER NOT NULL,
    document_id TEXT NOT NULL,
    docket_id TEXT NOT NULL,
    title TEXT,
    source_format TEXT,
    kind TEXT,
    mode TEXT,
    parts_json TEXT,
    subparts_json TEXT,
    parsed_json TEXT,
    stats_json TEXT,
    created_at TEXT
);
"""

SORTS = {"posted": "d.posted_date DESC, d.document_id DESC", "-posted": "d.posted_date ASC, d.document_id ASC",
         "title": "d.title COLLATE NOCASE ASC", "type": "d.document_type ASC, d.posted_date DESC"}


def _now():
    return datetime.now(timezone.utc).isoformat()


@contextmanager
def db():
    path = config.dockets_db()
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def init_db():
    with db() as conn:
        conn.executescript(SCHEMA)
        conn.commit()


# ── Dockets ────────────────────────────────────────────────────────────

def upsert_docket(attrs: dict) -> None:
    """attrs is client.docket()'s dict (regulations.gov attribute names)."""
    with db() as conn:
        conn.execute("""INSERT INTO dockets (docket_id, agency_id, title, short_title, abstract, docket_type, rin,
                            keywords_json, modify_date, raw_json, added_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(docket_id) DO UPDATE SET agency_id = excluded.agency_id, title = excluded.title,
                            short_title = excluded.short_title, abstract = excluded.abstract,
                            docket_type = excluded.docket_type, rin = excluded.rin,
                            keywords_json = excluded.keywords_json, modify_date = excluded.modify_date,
                            raw_json = excluded.raw_json""",
                     (attrs["id"], attrs.get("agencyId"), attrs.get("title"), attrs.get("shortTitle"),
                      attrs.get("dkAbstract"), attrs.get("docketType"), attrs.get("rin"),
                      json.dumps(attrs.get("keywords") or []), attrs.get("modifyDate"), json.dumps(attrs), _now()))
        conn.commit()


def set_sync_state(docket_id: str, state: dict, synced: bool = False) -> None:
    with db() as conn:
        if synced:
            conn.execute("UPDATE dockets SET sync_state_json = ?, synced_at = ? WHERE docket_id = ?",
                         (json.dumps(state), _now(), docket_id))
        else:
            conn.execute("UPDATE dockets SET sync_state_json = ? WHERE docket_id = ?", (json.dumps(state), docket_id))
        conn.commit()


def _docket_row(r) -> dict:
    d = dict(r)
    d["keywords"] = json.loads(d.pop("keywords_json") or "[]")
    d["sync_state"] = json.loads(d.pop("sync_state_json") or "null")
    d.pop("raw_json", None)
    return d


def get_docket(docket_id: str):
    with db() as conn:
        r = conn.execute("SELECT * FROM dockets WHERE docket_id = ?", (docket_id,)).fetchone()
    return _docket_row(r) if r else None


def list_dockets() -> list:
    """Every tracked docket with its document / file counts, newest added first."""
    with db() as conn:
        rows = conn.execute("""SELECT k.*,
                (SELECT COUNT(*) FROM documents d WHERE d.docket_id = k.docket_id) AS document_count,
                (SELECT COUNT(*) FROM documents d WHERE d.docket_id = k.docket_id AND d.detail_fetched_at IS NULL) AS pending_count,
                (SELECT COUNT(*) FROM files f JOIN documents d ON d.document_id = f.document_id
                    WHERE d.docket_id = k.docket_id) AS file_count,
                (SELECT COUNT(*) FROM files f JOIN documents d ON d.document_id = f.document_id
                    WHERE d.docket_id = k.docket_id AND f.local_path IS NOT NULL) AS local_count
            FROM dockets k ORDER BY k.added_at DESC""").fetchall()
    return [_docket_row(r) for r in rows]


def remove_docket(docket_id: str) -> int:
    """Drop the docket's catalog rows. Kept files on disk are left alone
    unless the caller removes the directory itself."""
    with db() as conn:
        ids = [r[0] for r in conn.execute("SELECT document_id FROM documents WHERE docket_id = ?", (docket_id,))]
        conn.execute("DELETE FROM files WHERE document_id IN (SELECT document_id FROM documents WHERE docket_id = ?)",
                     (docket_id,))
        conn.execute("DELETE FROM documents_fts WHERE document_id IN "
                     "(SELECT document_id FROM documents WHERE docket_id = ?)", (docket_id,))
        conn.execute("DELETE FROM documents WHERE docket_id = ?", (docket_id,))
        n = conn.execute("DELETE FROM dockets WHERE docket_id = ?", (docket_id,)).rowcount
        conn.commit()
    return n if ids is not None else 0


def totals() -> dict:
    with db() as conn:
        r = conn.execute("""SELECT (SELECT COUNT(*) FROM dockets) AS dockets,
                                   (SELECT COUNT(*) FROM documents) AS documents,
                                   (SELECT COUNT(*) FROM files) AS files,
                                   (SELECT COUNT(*) FROM files WHERE local_path IS NOT NULL) AS local_files""").fetchone()
    return dict(r)


# ── Documents ──────────────────────────────────────────────────────────

def _fts_refresh(conn, document_id, title, abstract, subtype):
    conn.execute("DELETE FROM documents_fts WHERE document_id = ?", (document_id,))
    conn.execute("INSERT INTO documents_fts (document_id, title, abstract, subtype) VALUES (?, ?, ?, ?)",
                 (document_id, title or "", abstract or "", subtype or ""))


def upsert_documents(docket_id: str, rows: list) -> int:
    """List-level attributes (client.documents()). A row already holding a
    detail keeps it; the list fields are refreshed."""
    n = 0
    with db() as conn:
        for a in rows:
            if not a.get("id"):
                continue
            conn.execute("""INSERT INTO documents (document_id, docket_id, object_id, document_type, subtype, title,
                                posted_date, last_modified, fr_doc_num, comment_start, comment_end,
                                open_for_comment, withdrawn)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(document_id) DO UPDATE SET object_id = excluded.object_id,
                                document_type = excluded.document_type, subtype = excluded.subtype,
                                title = excluded.title, posted_date = excluded.posted_date,
                                last_modified = excluded.last_modified, fr_doc_num = excluded.fr_doc_num,
                                comment_start = excluded.comment_start, comment_end = excluded.comment_end,
                                open_for_comment = excluded.open_for_comment, withdrawn = excluded.withdrawn""",
                         (a["id"], docket_id, a.get("objectId"), a.get("documentType"), a.get("subtype"),
                          a.get("title"), a.get("postedDate"), a.get("lastModifiedDate"), a.get("frDocNum"),
                          a.get("commentStartDate"), a.get("commentEndDate"),
                          1 if a.get("openForComment") else 0, 1 if a.get("withdrawn") else 0))
            abstract = conn.execute("SELECT abstract FROM documents WHERE document_id = ?", (a["id"],)).fetchone()[0]
            _fts_refresh(conn, a["id"], a.get("title"), abstract, a.get("subtype"))
            n += 1
        conn.commit()
    return n


def pending_details(docket_id: str) -> list:
    """Document ids still without a detail, oldest posted first (the rules
    before the memos)."""
    with db() as conn:
        return [r[0] for r in conn.execute(
            "SELECT document_id FROM documents WHERE docket_id = ? AND detail_fetched_at IS NULL "
            "ORDER BY posted_date ASC, document_id ASC", (docket_id,))]


def set_detail(document_id: str, detail: dict, files: list) -> None:
    """Store client.document()'s result: the detail attributes and one files
    row per downloadable file (new URLs inserted, known ones refreshed)."""
    citation = None
    if detail.get("frVolNum") and detail.get("startEndPage"):
        citation = f"{detail['frVolNum']} FR {detail['startEndPage']}"
    elif detail.get("frVolNum"):
        citation = f"{detail['frVolNum']} FR"
    cfr = detail.get("cfrPart")
    if isinstance(cfr, list):
        cfr = "; ".join(str(c) for c in cfr)
    with db() as conn:
        conn.execute("""UPDATE documents SET abstract = ?, cfr_part = ?, fr_citation = ?, page_count = ?,
                            detail_json = ?, detail_fetched_at = ?,
                            subtype = COALESCE(?, subtype), title = COALESCE(?, title),
                            document_type = COALESCE(?, document_type)
                        WHERE document_id = ?""",
                     (detail.get("docAbstract"), cfr, citation, detail.get("pageCount"),
                      json.dumps(detail), _now(), detail.get("subtype"), detail.get("title"),
                      detail.get("documentType"), document_id))
        for f in files:
            conn.execute("""INSERT INTO files (document_id, attachment_title, doc_order, file_url, format, size, restricted)
                            VALUES (?, ?, ?, ?, ?, ?, ?)
                            ON CONFLICT(file_url) DO UPDATE SET attachment_title = excluded.attachment_title,
                                doc_order = excluded.doc_order, format = excluded.format, size = excluded.size,
                                restricted = excluded.restricted""",
                         (document_id, f.get("attachment_title"), f.get("doc_order") or 0, f["file_url"],
                          (f.get("format") or "").lower() or None, f.get("size"), f.get("restricted")))
        row = conn.execute("SELECT title, subtype FROM documents WHERE document_id = ?", (document_id,)).fetchone()
        if row:
            _fts_refresh(conn, document_id, row["title"], detail.get("docAbstract"), row["subtype"])
        conn.commit()


def pending_comment_counts(docket_id: str) -> list:
    """(document_id, object_id) of rules and proposed rules without a count."""
    with db() as conn:
        return [(r[0], r[1]) for r in conn.execute(
            "SELECT document_id, object_id FROM documents WHERE docket_id = ? AND comment_count IS NULL "
            "AND object_id IS NOT NULL AND document_type IN ('Rule', 'Proposed Rule') ORDER BY posted_date",
            (docket_id,))]


def set_comment_count(document_id: str, n: int) -> None:
    with db() as conn:
        conn.execute("UPDATE documents SET comment_count = ? WHERE document_id = ?", (n, document_id))
        conn.commit()


def docket_summary(docket_id: str) -> dict:
    """Facet counts for the docket screen: by type, subtype and format,
    plus files known / kept and details still pending."""
    with db() as conn:
        types = {r[0] or "": r[1] for r in conn.execute(
            "SELECT document_type, COUNT(*) FROM documents WHERE docket_id = ? GROUP BY document_type", (docket_id,))}
        subtypes = {r[0] or "": r[1] for r in conn.execute(
            "SELECT subtype, COUNT(*) FROM documents WHERE docket_id = ? GROUP BY subtype ORDER BY COUNT(*) DESC",
            (docket_id,))}
        formats = {r[0] or "": r[1] for r in conn.execute(
            "SELECT f.format, COUNT(*) FROM files f JOIN documents d ON d.document_id = f.document_id "
            "WHERE d.docket_id = ? GROUP BY f.format ORDER BY COUNT(*) DESC", (docket_id,))}
        r = conn.execute("""SELECT
                (SELECT COUNT(*) FROM documents WHERE docket_id = ?) AS documents,
                (SELECT COUNT(*) FROM documents WHERE docket_id = ? AND detail_fetched_at IS NULL) AS pending,
                (SELECT COUNT(*) FROM files f JOIN documents d ON d.document_id = f.document_id WHERE d.docket_id = ?) AS files,
                (SELECT COUNT(*) FROM files f JOIN documents d ON d.document_id = f.document_id
                    WHERE d.docket_id = ? AND f.local_path IS NOT NULL) AS local_files,
                (SELECT COALESCE(SUM(f.size), 0) FROM files f JOIN documents d ON d.document_id = f.document_id
                    WHERE d.docket_id = ?) AS bytes""", (docket_id,) * 5).fetchone()
    out = dict(r)
    out.update({"types": types, "subtypes": subtypes, "formats": formats})
    return out


def _fts_query(q: str):
    tokens = re.findall(r"[A-Za-z0-9]+", q or "")
    return " ".join(f'"{t}"' for t in tokens) if tokens else None


def list_documents(docket_id: str, document_type: str = None, subtype: str = None, fmt: str = None,
                   q: str = None, local_only: bool = False, sort: str = "posted",
                   offset: int = 0, limit: int = 100) -> dict:
    """Filtered, paged rows with their files: {"total", "rows": [{…, files: […]}]}."""
    where, args = ["d.docket_id = ?"], [docket_id]
    if document_type:
        where.append("d.document_type = ?"); args.append(document_type)
    if subtype:
        where.append("d.subtype = ?"); args.append(subtype)
    if fmt:
        where.append("EXISTS (SELECT 1 FROM files f WHERE f.document_id = d.document_id AND f.format = ?)")
        args.append(fmt.lower())
    if local_only:
        where.append("EXISTS (SELECT 1 FROM files f WHERE f.document_id = d.document_id AND f.local_path IS NOT NULL)")
    match = _fts_query(q)
    if match:
        where.append("d.document_id IN (SELECT document_id FROM documents_fts WHERE documents_fts MATCH ?)")
        args.append(match)
    sql_where = " AND ".join(where)
    order = SORTS.get(sort, SORTS["posted"])
    with db() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM documents d WHERE {sql_where}", args).fetchone()[0]
        rows = [dict(r) for r in conn.execute(
            f"""SELECT d.document_id, d.document_type, d.subtype, d.title, d.posted_date, d.fr_doc_num,
                       d.comment_start, d.comment_end, d.open_for_comment, d.withdrawn, d.comment_count,
                       d.fr_citation, d.detail_fetched_at IS NOT NULL AS has_detail
                FROM documents d WHERE {sql_where} ORDER BY {order} LIMIT ? OFFSET ?""",
            args + [max(1, min(int(limit), 500)), max(0, int(offset))])]
        _attach_files(conn, rows)
    return {"total": total, "rows": rows}


def _attach_files(conn, rows):
    ids = [r["document_id"] for r in rows]
    by_doc = {i: [] for i in ids}
    if ids:
        marks = ",".join("?" * len(ids))
        for f in conn.execute(f"""SELECT id, document_id, attachment_title, doc_order, file_url, format, size, restricted,
                                         local_path IS NOT NULL AS local, local_size, downloaded_at, download_error,
                                         (SELECT p.id FROM proposals p WHERE p.file_id = files.id ORDER BY p.id DESC LIMIT 1) AS proposal_id
                                  FROM files WHERE document_id IN ({marks}) ORDER BY doc_order, id""", ids):
            d = dict(f)
            d["local"] = bool(d["local"])
            by_doc[d["document_id"]].append(d)
    for r in rows:
        r["files"] = by_doc.get(r["document_id"], [])
        r["has_detail"] = bool(r.get("has_detail"))


def get_document(document_id: str):
    with db() as conn:
        r = conn.execute("SELECT * FROM documents WHERE document_id = ?", (document_id,)).fetchone()
        if not r:
            return None
        d = dict(r)
        d["detail"] = json.loads(d.pop("detail_json") or "null")
        d["has_detail"] = d.get("detail_fetched_at") is not None
        _attach_files(conn, [d])
    return d


# ── Files ──────────────────────────────────────────────────────────────

def get_file(file_id: int):
    with db() as conn:
        r = conn.execute("SELECT f.*, d.docket_id FROM files f JOIN documents d ON d.document_id = f.document_id "
                         "WHERE f.id = ?", (file_id,)).fetchone()
    return dict(r) if r else None


def files_to_pull(docket_id: str, formats: set) -> list:
    """Catalogued files of the given formats with no local copy and no
    recorded refusal, as get_file() dicts."""
    if not formats:
        return []
    marks = ",".join("?" * len(formats))
    with db() as conn:
        return [dict(r) for r in conn.execute(
            f"""SELECT f.*, d.docket_id FROM files f JOIN documents d ON d.document_id = f.document_id
                WHERE d.docket_id = ? AND f.local_path IS NULL AND f.download_error IS NULL AND f.file_url IS NOT NULL
                  AND f.format IN ({marks}) ORDER BY d.posted_date, f.doc_order, f.id""",
            [docket_id] + sorted(formats))]


def mark_file_local(file_id: int, rel_path: str, size: int, sha256: str) -> None:
    with db() as conn:
        conn.execute("UPDATE files SET local_path = ?, local_size = ?, sha256 = ?, downloaded_at = ?, "
                     "download_error = NULL WHERE id = ?", (rel_path, size, sha256, _now(), file_id))
        conn.commit()


def mark_file_error(file_id: int, error: str) -> None:
    with db() as conn:
        conn.execute("UPDATE files SET download_error = ? WHERE id = ?", (error, file_id))
        conn.commit()


def clear_file_errors(docket_id: str) -> None:
    with db() as conn:
        conn.execute("UPDATE files SET download_error = NULL WHERE document_id IN "
                     "(SELECT document_id FROM documents WHERE docket_id = ?)", (docket_id,))
        conn.commit()


def match_upload(document_id: str, filename: str, size: int, fmt: str):
    """The catalogued file a dropped-in download most likely is: same
    document, same format, and the same size when the catalog knows one
    (regulations.gov names every download content.<ext> or attachment_N.<ext>,
    so the name alone rarely tells). None when nothing fits."""
    with db() as conn:
        rows = [dict(r) for r in conn.execute(
            "SELECT * FROM files WHERE document_id = ? AND local_path IS NULL ORDER BY doc_order, id", (document_id,))]
    fmt = (fmt or "").lower()
    same_fmt = [r for r in rows if (r.get("format") or "") == fmt]
    exact = [r for r in same_fmt if r.get("size") == size]
    if len(exact) == 1:
        return exact[0]
    base = os.path.basename(filename or "")
    m = re.match(r"attachment_(\d+)\.", base)
    if m:
        order = int(m.group(1))
        by_order = [r for r in same_fmt if r.get("doc_order") == order]
        if len(by_order) == 1:
            return by_order[0]
    if base.startswith("content.") and len([r for r in same_fmt if r.get("doc_order") == 0]) == 1:
        return [r for r in same_fmt if r.get("doc_order") == 0][0]
    if len(same_fmt) == 1 and not same_fmt[0].get("size"):
        return same_fmt[0]
    return None


def add_extra_file(document_id: str, title: str, fmt: str, rel_path: str, size: int, sha256: str) -> int:
    """A dropped-in file that matched no catalogued row: kept on the document
    with no regulations.gov URL."""
    with db() as conn:
        cur = conn.execute("INSERT INTO files (document_id, attachment_title, doc_order, file_url, format, size, "
                           "local_path, local_size, sha256, downloaded_at) VALUES (?, ?, 99, NULL, ?, ?, ?, ?, ?, ?)",
                           (document_id, title, fmt, size, rel_path, size, sha256, _now()))
        conn.commit()
        return cur.lastrowid


# ── Small cache (docket search) ────────────────────────────────────────

def cache_get(key: str, max_age_s: float = None):
    with db() as conn:
        row = conn.execute("SELECT fetched_at, value FROM dockets_cache WHERE key = ?", (key,)).fetchone()
    if not row:
        return None
    if max_age_s is not None:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(row["fetched_at"])
        if age.total_seconds() > max_age_s:
            return None
    return json.loads(row["value"])


def cache_put(key: str, value) -> None:
    with db() as conn:
        conn.execute("INSERT OR REPLACE INTO dockets_cache (key, fetched_at, value) VALUES (?, ?, ?)",
                     (key, _now(), json.dumps(value)))
        conn.commit()


# ── Proposals (proposed regulatory text read from a kept file) ─────────

def add_proposal(file_id, document_id, docket_id, title, source_format, kind, mode, parts, subparts, parsed, stats) -> int:
    """One proposal per file: a re-import replaces the earlier reading."""
    with db() as conn:
        conn.execute("DELETE FROM proposals WHERE file_id = ?", (file_id,))
        cur = conn.execute("""INSERT INTO proposals (file_id, document_id, docket_id, title, source_format, kind, mode,
                                  parts_json, subparts_json, parsed_json, stats_json, created_at)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                           (file_id, document_id, docket_id, title, source_format, kind, mode, json.dumps(parts),
                            json.dumps(subparts), json.dumps(parsed), json.dumps(stats), _now()))
        conn.commit()
        return cur.lastrowid


def _proposal_row(r, with_parsed):
    d = dict(r)
    d["parts"] = json.loads(d.pop("parts_json") or "[]")
    d["subparts"] = json.loads(d.pop("subparts_json") or "[]")
    d["stats"] = json.loads(d.pop("stats_json") or "{}")
    parsed = d.pop("parsed_json")
    if with_parsed:
        d["parsed"] = json.loads(parsed or "null")
    return d


def list_proposals(part=None) -> list:
    with db() as conn:
        rows = conn.execute("SELECT * FROM proposals ORDER BY id DESC").fetchall()
    out = [_proposal_row(r, False) for r in rows]
    if part:
        out = [p for p in out if str(part) in p["parts"]]
    return out


def get_proposal(proposal_id, with_parsed=True):
    with db() as conn:
        r = conn.execute("SELECT * FROM proposals WHERE id = ?", (proposal_id,)).fetchone()
    return _proposal_row(r, with_parsed) if r else None


def delete_proposal(proposal_id) -> int:
    with db() as conn:
        n = conn.execute("DELETE FROM proposals WHERE id = ?", (proposal_id,)).rowcount
        conn.commit()
    return n
