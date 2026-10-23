"""Import → the corpus tables → the read helpers."""
import json
import os

from ecfr_reader.corpus import store


def test_import_builds_every_table(corpus):
    assert store.corpus_exists()
    meta = store.read_meta()
    assert meta["snapshot_date"] == "2026-01-01" and meta["parts"] == "999"
    assert meta["section_count"] == "5"                    # 4 sections + 1 appendix
    assert store.part_count() == 1
    assert [p["part"] for p in store.list_parts()] == ["999"]
    assert [s["subpart"] for s in store.list_subparts("999")] == ["A", "B"]
    keys = [s["section_key"] for s in store.list_part_sections("999")]
    assert keys == ["999:999.1", "999:999.10", "999:999.11", "999:999.20", "999:Appendix A to Part 999"]


def test_render_shapes(corpus):
    sec = store.get_section("999:999.11")
    blocks = json.loads(sec["blocks_json"])
    assert sec["citation"] == "40 CFR 999.11"              # the twice-escaped metadata still parses
    assert sec["subpart"] == "A" and sec["heading"].startswith("§ 999.11")
    table = next(b for b in blocks if b.get("type") == "table")
    assert table["caption"].startswith("Table 1")
    assert table["headers"][0] == "Engine type"
    assert table["rows"][1][0] == "Non-emergency"           # the rowspan carried down
    assert any("GRAPHIC" in (b.get("text") or "") for b in blocks)
    loose = store.get_section("999:999.1")
    assert loose["subpart"] is None
    sub_b = store.get_section("999:999.20")
    assert "7414" in sub_b["authority"]                     # the subpart's own authority
    sub_a = store.get_section("999:999.10")
    assert "7401" in sub_a["authority"]                     # inherited from the part


def test_units_keep_the_three_shapes_apart(corpus):
    _, rows, heading = store.unit_sections("999", "A", None)
    assert [r["section_key"] for r in rows] == ["999:999.10", "999:999.11"] and "General" in heading
    _, rows, _ = store.unit_sections("999", None, "Appendix A to Part 999")
    assert [r["section_key"] for r in rows] == ["999:Appendix A to Part 999"]
    _, rows, _ = store.unit_sections("999", None, None)
    assert [r["section_key"] for r in rows] == ["999:999.1"]      # the loose sections only


def test_search_index_matches_the_corpus(corpus):
    total, rows = store.search('"spark" "ignition"', "", 25, 0)
    assert total == 1 and rows[0]["section_key"] == "999:999.10"
    total, _ = store.search('"records"', "999", 25, 0)
    assert total == 1


def test_reimport_replaces_the_file_atomically(corpus):
    from ecfr_reader.corpus import importer
    before = os.stat(store.db_path()).st_ino
    assert importer.run() == 5
    assert store.corpus_exists() and not os.path.exists(store.db_path() + ".tmp")
    assert os.stat(store.db_path()).st_ino != before


def test_parts_scope_accepts_ranges_and_lists():
    from ecfr_reader.corpus.updates import _parts_scope
    assert _parts_scope("60") == {"60"}
    assert _parts_scope("50-52") == {"50", "51", "52"}
    assert _parts_scope("50-51, 63") == {"50", "51", "63"}


def test_fetch_asks_for_compression_and_inflates(monkeypatch):
    """ecfr.gov's full-text endpoint answers 406 unless the request permits
    compression; the client asks for gzip and inflates the reply."""
    import gzip
    import io
    import urllib.request
    from email.message import Message
    from ecfr_reader.corpus import updates
    monkeypatch.setenv("ECFR_CONTACT", "t@example.org")
    seen = {}

    class Resp(io.BytesIO):
        headers = Message()
        def __enter__(self): return self
        def __exit__(self, *a): pass
    Resp.headers["Content-Encoding"] = "gzip"

    def fake_urlopen(req, timeout=0):
        seen["enc"] = req.get_header("Accept-encoding")
        return Resp(gzip.compress("<DIV5>hello</DIV5>".encode()))
    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    assert updates.fetch_full_xml("2026-10-21", "60", "60.4230") == "<DIV5>hello</DIV5>"
    assert seen["enc"] == "gzip"
