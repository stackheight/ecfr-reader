"""SQLite access for the read-only corpus (ecfr.db).

Deliberately a separate file from annotations.db: the corpus is a
rebuildable cache of public-domain CFR text built by importer.py, and the
user's notes / highlights / favorites live elsewhere so they survive a
corpus rebuild.
"""

import os
import sqlite3
from contextlib import contextmanager

from .. import config


def db_path():
    """The corpus file (config.ecfr_db — read per call, never at import)."""
    return config.ecfr_db()


def fts5_available() -> bool:
    """Search needs an sqlite3 built with FTS5 (the norm; some conda /
    pyenv builds lack it). Checked before an import so the failure is a
    sentence, not an OperationalError mid-run."""
    try:
        sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x)")
        return True
    except sqlite3.OperationalError:
        return False

SCHEMA = """
CREATE TABLE IF NOT EXISTS ecfr_meta (
    key TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS ecfr_parts (
    part TEXT PRIMARY KEY,
    heading TEXT,
    order_index INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ecfr_subparts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    part TEXT NOT NULL,
    subpart TEXT NOT NULL,
    heading TEXT,
    order_index INTEGER NOT NULL,
    UNIQUE(part, subpart)
);

CREATE TABLE IF NOT EXISTS ecfr_sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_key TEXT NOT NULL UNIQUE,
    part TEXT NOT NULL,
    subpart TEXT,
    identifier TEXT NOT NULL,
    type TEXT NOT NULL,
    heading TEXT,
    citation TEXT,
    authority TEXT,
    source TEXT,
    blocks_json TEXT NOT NULL,
    order_index INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ecfr_sections_part ON ecfr_sections(part, order_index);

-- Full-text search over headings and body text.
--
-- A plain FTS5 table, NOT external-content: the body is a flatten of
-- blocks_json (paragraph text, plus table captions/headers/cells/footnotes),
-- which is not a column of ecfr_sections and so can't be referenced by one.
-- The cost is that the text is stored twice — the corpus roughly doubles —
-- which is the price of searching what the reader actually renders rather
-- than a JSON blob full of punctuation.
--
-- section_key/part are UNINDEXED: they're returned with hits and filtered on,
-- never matched against. bm25 weights in the search route index these columns
-- positionally, so DO NOT reorder them.
--
-- porter stems, so "ignition" finds "ignites" — worth having in a corpus that
-- says "combusting"/"combustion"/"combusted" interchangeably.
--
-- This lands ONLY on re-import: import_corpus.py builds a fresh .tmp db from
-- this SCHEMA and os.replace()s it. An existing ecfr.db never gains the table,
-- which is why the search route 503s with an import hint instead of 500ing.
CREATE VIRTUAL TABLE IF NOT EXISTS ecfr_fts USING fts5(
    section_key UNINDEXED,
    part UNINDEXED,
    heading,
    body,
    tokenize='porter unicode61'
);
"""


def corpus_exists() -> bool:
    return os.path.isfile(db_path())


@contextmanager
def ecfr_db():
    """Connection to the corpus. Callers should check corpus_exists() first
    (routes return 503 with an import hint) rather than relying on sqlite
    raising — a missing file otherwise creates an empty zero-table db here."""
    conn = sqlite3.connect(db_path())
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


def get_meta(conn) -> dict:
    rows = conn.execute("SELECT key, value FROM ecfr_meta").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_meta(conn, **kv) -> None:
    conn.executemany(
        "INSERT INTO ecfr_meta (key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        list(kv.items()))

# ── Corpus reads (backlog #89, 2026-08-25 — pulled out of blueprints/ecfr.py).
#    Every function opens its own connection; the API layer never does. ──

def read_meta() -> dict:
    with ecfr_db() as conn:
        return get_meta(conn)


def write_meta(**kv) -> None:
    with ecfr_db() as conn:
        set_meta(conn, **kv)
        conn.commit()


def part_count() -> int:
    with ecfr_db() as conn:
        return conn.execute("SELECT COUNT(*) FROM ecfr_parts").fetchone()[0]


def list_parts() -> list:
    with ecfr_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT part, heading, order_index FROM ecfr_parts ORDER BY order_index")]


def get_part(part):
    with ecfr_db() as conn:
        row = conn.execute("SELECT part, heading FROM ecfr_parts WHERE part = ?", (part,)).fetchone()
    return dict(row) if row else None


def list_subparts(part) -> list:
    with ecfr_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT subpart, heading, order_index FROM ecfr_subparts WHERE part = ? ORDER BY order_index",
            (part,))]


def list_part_sections(part) -> list:
    with ecfr_db() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT section_key, subpart, identifier, type, heading, order_index "
            "FROM ecfr_sections WHERE part = ? ORDER BY order_index", (part,))]


def get_section(key):
    """The full section row (blocks_json still serialized), with its prev/next
    neighbours in document order, or None."""
    with ecfr_db() as conn:
        row = conn.execute("SELECT * FROM ecfr_sections WHERE section_key = ?", (key,)).fetchone()
        if not row:
            return None
        result = dict(row)
        prev_row = conn.execute(
            "SELECT section_key, heading FROM ecfr_sections "
            "WHERE part = ? AND order_index < ? ORDER BY order_index DESC LIMIT 1",
            (result["part"], result["order_index"])).fetchone()
        next_row = conn.execute(
            "SELECT section_key, heading FROM ecfr_sections "
            "WHERE part = ? AND order_index > ? ORDER BY order_index ASC LIMIT 1",
            (result["part"], result["order_index"])).fetchone()
    result["prev"] = dict(prev_row) if prev_row else None
    result["next"] = dict(next_row) if next_row else None
    return result


def get_section_locator(key):
    """{part, identifier, type} — what the live fetch needs — or None."""
    with ecfr_db() as conn:
        row = conn.execute("SELECT part, identifier, type FROM ecfr_sections WHERE section_key = ?",
                           (key,)).fetchone()
    return dict(row) if row else None


def get_section_part_subpart(key):
    with ecfr_db() as conn:
        row = conn.execute("SELECT part, subpart FROM ecfr_sections WHERE section_key = ?",
                           (key,)).fetchone()
    return dict(row) if row else None


def sections_meta(keys) -> dict:
    """section_key -> {part, subpart, citation, heading}; missing keys are
    simply absent. Chunked to stay under SQLite's host-parameter limit."""
    keys = [k for k in keys if k]
    if not keys:
        return {}
    meta = {}
    with ecfr_db() as conn:
        for i in range(0, len(keys), 400):
            chunk = keys[i:i + 400]
            ph = ",".join("?" * len(chunk))
            for row in conn.execute(
                    f"SELECT section_key, part, subpart, citation, heading "
                    f"FROM ecfr_sections WHERE section_key IN ({ph})", chunk):
                meta[row["section_key"]] = dict(row)
    return meta


def subpart_exists(part, subpart) -> bool:
    with ecfr_db() as conn:
        return conn.execute("SELECT 1 FROM ecfr_subparts WHERE part = ? AND subpart = ?",
                            (part, subpart)).fetchone() is not None


def unit_sections(part, subpart=None, appendix=None):
    """(part_row, rows, subpart_heading) for one top-level division of a
    part: a subpart, ONE appendix, or the part's loose sections (neither).
    part_row is None when the part is unknown; rows keep blocks_json."""
    if subpart:
        where, params = "part = ? AND subpart = ?", [part, subpart]
    elif appendix:
        where, params = "part = ? AND identifier = ? AND type = 'appendix'", [part, appendix]
    else:
        # Loose sections only: an appendix with no subpart is its own unit.
        where, params = "part = ? AND subpart IS NULL AND type = 'section'", [part]
    with ecfr_db() as conn:
        part_row = conn.execute("SELECT part, heading FROM ecfr_parts WHERE part = ?", (part,)).fetchone()
        if not part_row:
            return None, [], None
        rows = [dict(r) for r in conn.execute(
            f"""SELECT section_key, part, subpart, identifier, type, heading, citation,
                       authority, source, blocks_json, order_index
                FROM ecfr_sections WHERE {where} ORDER BY order_index""", params)]
        heading = None
        if subpart:
            sp = conn.execute("SELECT heading FROM ecfr_subparts WHERE part = ? AND subpart = ?",
                              (part, subpart)).fetchone()
            heading = sp["heading"] if sp else None
    return dict(part_row), rows, heading


def search(match, part, limit, offset):
    """(total, rows) for an FTS5 MATCH expression the caller has already
    made safe. Raises sqlite3.OperationalError when the corpus predates
    the FTS table (the route turns that into a 503 with an import hint)."""
    where, params = "ecfr_fts MATCH ?", [match]
    if part:
        where += " AND part = ?"; params.append(part)
    with ecfr_db() as conn:
        total = conn.execute(f"SELECT count(*) FROM ecfr_fts WHERE {where}", params).fetchone()[0]
        # \x01/\x02 mark the hit boundaries — sentinels, never HTML; the
        # frontend escapes the snippet and THEN swaps them for <b>.
        # snippet()'s column index is positional — 3 is `body`.
        rows = [dict(r) for r in conn.execute(f"""
            SELECT section_key, part, heading,
                   snippet(ecfr_fts, 3, char(1), char(2), ' … ', 22) AS snippet
            FROM ecfr_fts WHERE {where}
            ORDER BY bm25(ecfr_fts, 0.0, 0.0, 4.0, 1.0)
            LIMIT ? OFFSET ?""", params + [limit, offset])]
    return total, rows
