"""Import the fetched XML into the corpus database (`ecfr-reader import`).

Rebuilds ecfr.db from <data>/xml/title-40-part-*.xml atomically — writes
to ecfr.db.tmp, then os.replace() — so a running reader never sees a
partially-written file. Parses ONE part XML per loop
iteration and drops the reference before moving on so each BeautifulSoup tree
can be garbage-collected (part 63 alone is a 26 MB parse).
"""

import glob
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone

from bs4 import BeautifulSoup

from .. import config
from .render import render_part
from .store import SCHEMA, db_path, fts5_available


def _natural_key(part: str):
    return [int(s) if s.isdigit() else s for s in re.split(r"(\d+)", part)]


def _xml_files(xml_dir):
    parts = []
    for path in glob.glob(os.path.join(xml_dir, "title-40-part-*.xml")):
        m = re.search(r"title-40-part-(\d+)\.xml$", path)
        if m:
            parts.append((m.group(1), path))
    return sorted(parts, key=lambda pair: _natural_key(pair[0]))


def _fts_body(blocks) -> str:
    """One section's searchable text, flattened out of its rendered blocks.

    Mirrors what the reader actually puts on screen (see ecfrRenderBlock in
    frontend/js/ecfr.js) — including table text, because a standard is very
    often IN a table and "0.5 g/HP-hr" is exactly the kind of thing worth
    searching for. Only the two block shapes the corpus contains are handled:
    'p' and 'table'.
    """
    out = []
    for b in blocks or []:
        if b.get("type") == "table":
            if b.get("caption"):
                out.append(b["caption"])
            out.extend(b.get("headers") or [])
            for row in b.get("rows") or []:
                out.extend(cell for cell in row if cell)
            out.extend(b.get("footnotes") or [])
        elif b.get("text"):
            out.append(b["text"])
    return "\n".join(out)


def run():
    """Build the corpus from the XML on disk. Returns the section count."""
    if not fts5_available():
        sys.exit("This Python's sqlite3 was built without FTS5, which the search index needs. "
                 "Use a python.org, distro or uv-managed interpreter (all ship FTS5).")
    state_path, xml_dir, out = config.dataset_state_path(), config.xml_dir(), db_path()
    if not os.path.isfile(state_path):
        sys.exit(f"Missing {state_path} — run `ecfr-reader fetch` first.")
    with open(state_path, "r", encoding="utf-8") as f:
        dataset_state = json.load(f)

    files = _xml_files(xml_dir)
    if not files:
        sys.exit(f"No title-40-part-*.xml files found in {xml_dir} — run `ecfr-reader fetch` first.")
    os.makedirs(os.path.dirname(out) or ".", exist_ok=True)

    tmp_path = out + ".tmp"
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    conn = sqlite3.connect(tmp_path)
    conn.executescript(SCHEMA)

    section_count = 0
    for part_num, path in files:
        with open(path, "r", encoding="utf-8") as f:
            soup = BeautifulSoup(f.read(), "lxml-xml")
        _, part_heading, subparts, sections = render_part(soup)
        del soup  # free this part's parse tree before the next iteration

        order_index = int(part_num) if part_num.isdigit() else 0
        conn.execute(
            "INSERT OR REPLACE INTO ecfr_parts (part, heading, order_index) "
            "VALUES (?, ?, ?)", (part_num, part_heading, order_index))
        for sp in subparts:
            conn.execute(
                "INSERT OR REPLACE INTO ecfr_subparts "
                "(part, subpart, heading, order_index) VALUES (?, ?, ?, ?)",
                (part_num, sp["subpart"], sp["heading"], sp["order_index"]))
        for sec in sections:
            conn.execute(
                "INSERT OR REPLACE INTO ecfr_sections "
                "(section_key, part, subpart, identifier, type, heading, "
                " citation, authority, source, blocks_json, order_index) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (sec["section_key"], sec["part"], sec["subpart"],
                 sec["identifier"], sec["type"], sec["heading"],
                 sec["citation"], sec["authority"], sec["source"],
                 json.dumps(sec["blocks"], ensure_ascii=False),
                 sec["order_index"]))
            # Indexed from the blocks in memory, before they're serialized —
            # searching blocks_json itself would match JSON punctuation and
            # miss nothing useful in return.
            conn.execute(
                "INSERT INTO ecfr_fts (section_key, part, heading, body) "
                "VALUES (?, ?, ?, ?)",
                (sec["section_key"], sec["part"], sec["heading"] or "",
                 _fts_body(sec["blocks"])))
        section_count += len(sections)
        print(f"  part {part_num}: {len(sections)} sections/appendices, "
              f"{len(subparts)} subparts")

    # The search index holds a SECOND copy of the text, and nothing keeps it
    # in step with ecfr_sections automatically — FTS5 has no triggers here and
    # can't carry a UNIQUE constraint. The two writes above therefore disagree
    # in one specific case: a duplicate section_key REPLACEs in ecfr_sections
    # (the column is UNIQUE) but INSERTs a second time into ecfr_fts, leaving a
    # ghost row that still holds the OLD text. Search would then show the
    # section twice, one quoting text no longer in the corpus, and say nothing.
    #
    # Cheap to check, invisible if we don't: fail the import rather than
    # os.replace() a subtly wrong corpus over a working one.
    fts_rows = conn.execute("SELECT count(*) FROM ecfr_fts").fetchone()[0]
    base_rows = conn.execute("SELECT count(*) FROM ecfr_sections").fetchone()[0]
    if fts_rows != base_rows:
        dupes = conn.execute("""
            SELECT section_key, count(*) c FROM ecfr_fts
            GROUP BY section_key HAVING c > 1 LIMIT 5""").fetchall()
        conn.close()
        os.remove(tmp_path)
        sys.exit(f"Import aborted: search index has {fts_rows} rows but the corpus has "
                 f"{base_rows} — the two copies would ship out of step.\n"
                 f"Likely duplicate section_keys, e.g. {[tuple(d) for d in dupes]}.\n"
                 f"The existing {out} was left untouched.")

    imported_at = datetime.now(timezone.utc).isoformat()
    conn.executemany(
        "INSERT OR REPLACE INTO ecfr_meta (key, value) VALUES (?, ?)",
        [("snapshot_date", dataset_state["snapshot_date"]),
         ("parts", dataset_state["parts"]),
         ("imported_at", imported_at),
         ("section_count", str(section_count))])
    conn.commit()
    conn.close()

    os.replace(tmp_path, out)
    print(f"=== Wrote {out}: {section_count} sections/appendices across "
          f"{len(files)} parts (snapshot {dataset_state['snapshot_date']}) ===")
    return section_count


if __name__ == "__main__":
    run()
