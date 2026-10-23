"""Your notes, highlights and favorites — one SQLite file
(config.annotations_db), deliberately NOT the corpus file, so a corpus
rebuild at a newer snapshot never touches them. Rows reference sections by
`section_key` ("<part>:<identifier>", e.g. "60:60.4230") with no foreign key:
a highlight whose text drifted after a re-import is shown as orphaned by
the reader rather than lost.
"""
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_key TEXT NOT NULL,
    citation TEXT,
    note TEXT NOT NULL,
    created_at TEXT,
    updated_at TEXT
);
-- Anchored to the section's rendered text by character position
-- (start_pos / end_pos) with the quoted text and its neighbours, so the
-- reader can re-find a mark after the text shifts, or call it orphaned.
CREATE TABLE IF NOT EXISTS highlights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_key TEXT NOT NULL,
    quote TEXT NOT NULL,
    snapshot_date TEXT,
    created_at TEXT,
    color TEXT NOT NULL DEFAULT 'yellow',
    kind TEXT NOT NULL DEFAULT 'highlight',
    comment TEXT,
    start_pos INTEGER NOT NULL,
    end_pos INTEGER NOT NULL,
    prefix TEXT,
    suffix TEXT
);
-- Any starrable node of the TOC tree. node_key encodes its type and the
-- three formats are disjoint: part '60' · subpart '60/JJJJ' · section
-- '60:60.4230' (the corpus section_key).
CREATE TABLE IF NOT EXISTS favorites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_type TEXT NOT NULL,
    node_key TEXT NOT NULL UNIQUE,
    citation TEXT,
    label TEXT,
    created_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_section ON notes(section_key);
CREATE INDEX IF NOT EXISTS idx_highlights_section ON highlights(section_key);
"""

NODE_TYPES = ("part", "subpart", "section")

# Columns PATCH /api/ecfr/highlights/<id> may write. Anything else in the
# request body is ignored — never interpolate caller-supplied keys into SQL.
HIGHLIGHT_PATCH_COLUMNS = (
    "color", "kind", "comment", "start_pos", "end_pos",
    "prefix", "suffix", "quote", "snapshot_date",
)


def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(config.annotations_db())), exist_ok=True)
    with db() as conn:
        conn.executescript(SCHEMA)


@contextmanager
def db():
    """A connection; the tables are (re)created when the file is new, so
    deleting annotations.db while the reader runs just starts it over."""
    path = config.annotations_db()
    fresh = not os.path.exists(path)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    if fresh:
        conn.executescript(SCHEMA)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _now():
    return datetime.now().isoformat()


# ── notes ──
def add_note(section_key, citation, note):
    now = _now()
    with db() as conn:
        cur = conn.execute("INSERT INTO notes (section_key, citation, note, created_at, updated_at) "
                           "VALUES (?, ?, ?, ?, ?)", (section_key, citation, note, now, now))
        return {"id": cur.lastrowid, "section_key": section_key, "citation": citation,
                "note": note, "created_at": now, "updated_at": now}


def update_note(note_id, note):
    with db() as conn:
        return conn.execute("UPDATE notes SET note = ?, updated_at = ? WHERE id = ?",
                            (note, _now(), note_id)).rowcount > 0


def delete_note(note_id):
    with db() as conn:
        return conn.execute("DELETE FROM notes WHERE id = ?", (note_id,)).rowcount > 0


# ── highlights ──
def add_highlight(section_key, quote, snapshot_date, start_pos, end_pos, color="yellow",
                  kind="highlight", comment=None, prefix=None, suffix=None):
    with db() as conn:
        cur = conn.execute(
            "INSERT INTO highlights (section_key, quote, snapshot_date, created_at, color, kind, "
            "comment, start_pos, end_pos, prefix, suffix) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (section_key, quote, snapshot_date, _now(), color, kind, comment, start_pos, end_pos, prefix, suffix))
        return dict(conn.execute("SELECT * FROM highlights WHERE id = ?", (cur.lastrowid,)).fetchone())


def update_highlight(highlight_id, fields):
    """Write the whitelisted columns present in `fields`; returns the full
    row, or None when the id is unknown or nothing was updatable."""
    updates = {k: v for k, v in fields.items() if k in HIGHLIGHT_PATCH_COLUMNS}
    if not updates:
        return None
    set_clause = ", ".join(f"{col} = ?" for col in updates)
    with db() as conn:
        if conn.execute(f"UPDATE highlights SET {set_clause} WHERE id = ?",
                        [*updates.values(), highlight_id]).rowcount == 0:
            return None
        return dict(conn.execute("SELECT * FROM highlights WHERE id = ?", (highlight_id,)).fetchone())


def delete_highlight(highlight_id):
    with db() as conn:
        return conn.execute("DELETE FROM highlights WHERE id = ?", (highlight_id,)).rowcount > 0


def all_annotations():
    """Every note and highlight. The reader's panel scopes them to a
    section / subpart / part / the whole title, and scoping needs each
    row's part + subpart — which live in the corpus, a different file —
    so the API pulls everything and buckets it in Python. Fine at this
    size: annotations are hand-made, hundreds at most."""
    with db() as conn:
        notes = [dict(r) for r in conn.execute("SELECT * FROM notes ORDER BY created_at")]
        highlights = [dict(r) for r in conn.execute(
            "SELECT * FROM highlights ORDER BY section_key, start_pos")]
    return {"notes": notes, "highlights": highlights}


# ── favorites ──
def favorite_id(node_key):
    with db() as conn:
        row = conn.execute("SELECT id FROM favorites WHERE node_key = ?", (node_key,)).fetchone()
    return row["id"] if row else None


def toggle_favorite(node_type, node_key, citation, label):
    """Add the favorite if absent, remove it if present."""
    with db() as conn:
        existing = conn.execute("SELECT id FROM favorites WHERE node_key = ?", (node_key,)).fetchone()
        if existing:
            conn.execute("DELETE FROM favorites WHERE id = ?", (existing["id"],))
            return {"favorited": False, "favorite_id": None}
        cur = conn.execute("INSERT INTO favorites (node_type, node_key, citation, label, created_at) "
                           "VALUES (?, ?, ?, ?, ?)", (node_type, node_key, citation, label, _now()))
        return {"favorited": True, "favorite_id": cur.lastrowid}


def favorites():
    """Newest first. Node types are mixed — node_key's format says which."""
    with db() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM favorites ORDER BY created_at DESC, id DESC")]
