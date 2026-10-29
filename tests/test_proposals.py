"""Proposed regulatory text: reading a redline (DOCX exact, PDF by
geometry), finding its sections and enumerator paths, and composing the
local unit as it would read. Every document here is built in the test."""
import io
import os
import zipfile

import pytest

# ── builders ───────────────────────────────────────────────────────────

W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def docx_bytes(paragraphs):
    """paragraphs: list of lists of (text, mark) with mark in None/'del'/'ins'/
    'strike'/'underline' (the last two as formatting, the first two as
    tracked changes); a tuple ("table", rows) makes a table."""
    body = []
    for p in paragraphs:
        if isinstance(p, tuple) and p[0] == "table":
            rows = "".join("<w:tr>" + "".join(f"<w:tc><w:p><w:r><w:t>{c}</w:t></w:r></w:p></w:tc>" for c in row) + "</w:tr>"
                           for row in p[1])
            body.append(f"<w:tbl>{rows}</w:tbl>")
            continue
        runs = []
        for text, mark in p:
            if mark == "del":
                runs.append(f'<w:del w:author="x"><w:r><w:delText xml:space="preserve">{text}</w:delText></w:r></w:del>')
            elif mark == "ins":
                runs.append(f'<w:ins w:author="x"><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:ins>')
            elif mark == "strike":
                runs.append(f'<w:r><w:rPr><w:strike/></w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>')
            elif mark == "underline":
                runs.append(f'<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t xml:space="preserve">{text}</w:t></w:r>')
            else:
                runs.append(f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>')
        body.append(f"<w:p>{''.join(runs)}</w:p>")
    xml = f'<?xml version="1.0" encoding="UTF-8"?><w:document {W_NS}><w:body>{"".join(body)}</w:body></w:document>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr("word/document.xml", xml)
    return buf.getvalue()


def pdf_bytes(pages):
    """pages: list of pages; a page is a list of items: ("text", x, y, size, text)
    or ("rect", x, y, w, h). Helvetica, letter size, hand-built xref."""
    objs = []

    def add(s):
        objs.append(s)
        return len(objs)
    cat = add("<< /Type /Catalog /Pages 2 0 R >>")
    add("")                                   # 2: pages, filled below
    font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    page_ids = []
    for items in pages:
        ops = []
        for it in items:
            if it[0] == "text":
                _, x, y, size, text = it
                text = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
                ops.append(f"BT /F1 {size} Tf {x} {y} Td ({text}) Tj ET")
            else:
                _, x, y, w, h = it
                ops.append(f"{x} {y} {w} {h} re f")
        content = "\n".join(ops).encode("latin-1")
        cid = add(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")
        pid = add(f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {font} 0 R >> >> /Contents {cid} 0 R >>")
        page_ids.append(pid)
    objs[1] = f"<< /Type /Pages /Kids [{' '.join(f'{p} 0 R' for p in page_ids)}] /Count {len(page_ids)} >>"
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, o in enumerate(objs, 1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode()
        out += o if isinstance(o, bytes) else o.encode("latin-1")
        out += b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root {cat} 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return bytes(out)


def write(tmp_path, name, data):
    p = tmp_path / name
    p.write_bytes(data)
    return str(p)


# ── extract ────────────────────────────────────────────────────────────

def test_docx_tracked_changes_and_formatting(tmp_path):
    from ecfr_reader.proposals.extract import extract, paragraph_text
    path = write(tmp_path, "redline.docx", docx_bytes([
        [("§ 999.10 Definitions.", None)],
        [("(a) The owner ", None), ("shall", "del"), ("must", "ins"), (" notify the Administrator.", None)],
        [("(b) Struck in full.", "strike")],
        [("(c) Added by formatting.", "underline")],
        ("table", [["Pollutant", "Limit"], ["NOx", "10 ppm"]]),
        [("   ", None)],
    ]))
    r = extract(path)
    assert r["format"] == "docx" and r["n_del"] == 2 and r["n_ins"] == 2
    ps = r["paragraphs"]
    assert len(ps) == 5                                   # the blank paragraph is dropped
    assert paragraph_text(ps[1], "before") == "(a) The owner shall notify the Administrator."
    assert paragraph_text(ps[1], "after") == "(a) The owner must notify the Administrator."
    assert ps[1]["runs"] == [["(a) The owner ", None], ["shall", "del"], ["must", "ins"], [" notify the Administrator.", None]]
    assert paragraph_text(ps[2], "after") == "" and paragraph_text(ps[2], "before") == "(b) Struck in full."
    assert paragraph_text(ps[3], "before") == "" and paragraph_text(ps[3], "after") == "(c) Added by formatting."
    assert ps[4]["kind"] == "table" and "Pollutant | Limit / NOx | 10 ppm" in paragraph_text(ps[4])


def test_docx_that_is_not_one(tmp_path):
    from ecfr_reader.proposals.extract import ExtractError, extract
    with pytest.raises(ExtractError, match="Word"):
        extract(write(tmp_path, "x.docx", b"not a zip"))
    with pytest.raises(ExtractError, match="docx or a .pdf"):
        extract(write(tmp_path, "x.xlsx", b"PK"))


def test_pdf_geometry_pairs_marks_with_characters(tmp_path):
    from ecfr_reader.proposals.extract import extract, paragraph_text
    S = 12
    # "(a) The owner " plain · "shall" struck · "must" underlined · " notify." plain, one line
    seg = lambda x, t: ("text", x, 700, S, t)
    page1 = [seg(72, "(a) The owner"), seg(160, "shall"), seg(200, "must"), seg(236, "notify."),
             ("rect", 158, 704, 34, 0.8),          # strike through "shall": mid x-height
             ("rect", 198, 699, 30, 0.8),          # underline under "must": just below the baseline
             seg(72, "(b) Keep compli-"), ("text", 72, 686, S, "ance records."),
             ("text", 72, 30, S, "Page 1 of 2")]
    page1[6] = ("text", 72, 700 - 14, S, "(b) Keep compli-")     # second line, 14 pt below the first
    page1[7] = ("text", 72, 700 - 28, S, "ance records.")
    page2 = [("text", 72, 700, S, "(c) New paragraph."), ("rect", 70, 699, 110, 0.8),
             ("text", 72, 30, S, "Page 2 of 2")]
    r = extract(write(tmp_path, "redline.pdf", pdf_bytes([page1, page2])))
    assert r["format"] == "pdf" and r["pages"] == 2
    texts = [(paragraph_text(p, "before"), paragraph_text(p, "after")) for p in r["paragraphs"]]
    assert texts[0] == ("(a) The owner shall notify.", "(a) The owner must notify.")
    assert texts[1] == ("(b) Keep compliance records.", "(b) Keep compliance records.")
    assert texts[2] == ("", "(c) New paragraph.")
    assert len(texts) == 3                                 # the running footer is gone
    assert r["n_del"] == 1 and r["n_ins"] == 2
    clean = extract(write(tmp_path, "clean.pdf", pdf_bytes([[("text", 72, 700, S, "(a) Nothing marked.")]])))
    assert clean["n_del"] == 0 and clean["n_ins"] == 0 and paragraph_text(clean["paragraphs"][0]) == "(a) Nothing marked."


# ── parse ──────────────────────────────────────────────────────────────

def test_enumerator_paths_follow_the_cfr_levels():
    from ecfr_reader.proposals.parse import PathResolver, block_paths
    r = PathResolver()
    seq = [[], ["a"], ["1"], ["i"], ["ii"], ["A"], ["B"], ["2"], ["b"], [], ["1"], ["c"], ["d"], ["e"], ["f"], ["g"], ["h"], ["i"], ["j"]]
    assert [r.next(x) for x in seq] == [
        "intro", "(a)", "(a)(1)", "(a)(1)(i)", "(a)(1)(ii)", "(a)(1)(ii)(A)", "(a)(1)(ii)(B)", "(a)(2)", "(b)", "(b)+1",
        "(b)(1)", "(c)", "(d)", "(e)", "(f)", "(g)", "(h)", "(i)", "(j)"]
    r = PathResolver()
    assert r.next(["b", "2", "i"]) == "(b)(2)(i)" and r.next(["ii"]) == "(b)(2)(ii)" and r.next(["3"]) == "(b)(3)"
    assert r.next(["4"]) == "(b)(4)" and r.next(["c"]) == "(c)"
    assert block_paths([{"type": "p", "text": "Intro text."}, {"type": "p", "text": "(a) First."},
                        {"type": "table", "caption": "t"}, {"type": "p", "text": "(b) Second."}]) == ["intro", "(a)", "(a)+1", "(b)"]


def test_parse_finds_sections_instructions_and_paragraphs(tmp_path):
    from ecfr_reader.proposals.extract import extract
    from ecfr_reader.proposals.parse import parse
    path = write(tmp_path, "r.docx", docx_bytes([
        [("MEMORANDUM: Redline/Strikeout for amendments to 40 CFR part 999", None)],
        [("PART 999—STANDARDS OF PERFORMANCE FOR EXAMPLE SOURCES", None)],
        [("Subpart A—General Provisions", None)],
        [("Section 999.10 is amended by:", None)],
        [("a. Revising paragraph (1);", None)],
        [("b. Removing paragraph (2); and", None)],
        [("c. Adding paragraph (3).", None)],
        [("§ 999.10 Definitions.", None)],
        [("(1) The first numbered paragraph", None), (", revised", "ins"), (".", None)],
        [("(2) The second numbered paragraph, with a figure inside.", "del")],
        [("(3) A third numbered paragraph.", "ins")],
        [("§ 999.11 Emission standards", None), (" and limits", "ins"), (".", None)],
        [("(a) Table 1 of this section lists the standards.", None)],
        [("§ 999.12 [Removed]", None)],
        [("§ 999.13 A brand new section.", "ins")],
        [("(a) Its only paragraph.", "ins")],
    ]))
    r = parse(extract(path))
    assert r["parts"] == ["999"] and r["subparts"] == ["A"] and r["front_matter"] == 1
    s = {x["identifier"]: x for x in r["sections"]}
    assert list(s) == ["999.10", "999.11", "999.12", "999.13"]
    assert s["999.10"]["heading"] == "Definitions." and s["999.10"]["subpart"] == "A"
    assert [(i["verb"], i["paths"]) for i in s["999.10"]["instructions"]] == [
        ("revise", ["(1)"]), ("remove", ["(2)"]), ("add", ["(3)"])]
    ps = s["999.10"]["paragraphs"]
    assert [p["path"] for p in ps] == ["(1)", "(2)", "(3)"]
    assert ps[0]["after"] == "(1) The first numbered paragraph, revised." and ps[0]["before"] == "(1) The first numbered paragraph."
    assert ps[1]["after"] == "" and ps[2]["before"] == ""
    assert s["999.11"]["heading"] == "Emission standards and limits." and s["999.11"]["heading_before"] == "Emission standards."
    assert s["999.12"]["removed"] is True
    assert s["999.13"]["heading_before"] == "" and s["999.13"]["paragraphs"][0]["path"] == "(a)"


# ── compose ────────────────────────────────────────────────────────────

def _unit():
    return {"heading": "Subpart A—General Provisions", "part": "999", "subpart": "A", "sections": [
        {"section_key": "999:999.10", "part": "999", "subpart": "A", "identifier": "999.10", "type": "section",
         "heading": "§ 999.10 Definitions.", "citation": "40 CFR 999.10", "blocks": [
             {"type": "p", "text": "Spark ignition engine means an engine."},
             {"type": "p", "text": "(1) The first numbered paragraph."},
             {"type": "p", "text": "(2) The second numbered paragraph."},
             {"type": "p", "text": "(i) A child of the second."},
             {"type": "p", "text": "(3) The third."}]},
        {"section_key": "999:999.11", "part": "999", "subpart": "A", "identifier": "999.11", "type": "section",
         "heading": "§ 999.11 Emission standards.", "citation": "40 CFR 999.11", "blocks": [
             {"type": "p", "text": "(a) Table 1 lists the standards."},
             {"type": "table", "caption": "Table 1", "headers": [], "rows": [], "footnotes": []},
             {"type": "p", "text": "(b) A graphic follows."}]},
        {"section_key": "999:999.12", "part": "999", "subpart": "A", "identifier": "999.12", "type": "section",
         "heading": "§ 999.12 Old.", "citation": "40 CFR 999.12", "blocks": [{"type": "p", "text": "Gone soon."}]},
    ]}


def _proposal():
    return {"parts": ["999"], "subparts": ["A"], "front_matter": 0, "sections": [
        {"identifier": "999.10", "part": "999", "subpart": "A", "heading": "Definitions.", "heading_before": "Definitions.",
         "removed": False, "instructions": [{"verb": "revise", "paths": ["(1)"], "target": "paragraph"},
                                            {"verb": "remove", "paths": ["(2)"], "target": "paragraph"},
                                            {"verb": "add", "paths": ["(4)"], "target": "paragraph"}],
         "paragraphs": [
             {"path": "(1)", "before": "(1) The first numbered paragraph.", "after": "(1) The first numbered paragraph, revised.", "kind": "p"},
             {"path": "(3)", "before": "(3) The third, as EPA had it.", "after": "(3) The third, as EPA had it.", "kind": "p"},
             {"path": "(4)", "before": "", "after": "(4) A fourth, added.", "kind": "p"},
             {"path": "(4)(i)", "before": "", "after": "(i) Under the fourth.", "kind": "p"},
             {"path": "(9)", "before": "(9) A paragraph EPA thinks exists.", "after": "(9) A paragraph EPA thinks exists, changed.", "kind": "p"}]},
        {"identifier": "999.11", "part": "999", "subpart": "A", "heading": "Emission standards and limits.",
         "heading_before": "Emission standards.", "removed": False, "instructions": [],
         "paragraphs": [{"path": "(b)", "before": "(b) A graphic follows.", "after": "", "kind": "p"}]},
        {"identifier": "999.12", "part": "999", "subpart": "A", "heading": "", "heading_before": "", "removed": True,
         "instructions": [], "paragraphs": []},
        {"identifier": "999.115", "part": "999", "subpart": "A", "heading": "A brand new section.", "heading_before": "",
         "removed": False, "instructions": [], "paragraphs": [{"path": "(a)", "before": "", "after": "(a) Its only paragraph.", "kind": "p"}]},
        {"identifier": "60.1", "part": "60", "subpart": None, "heading": "Elsewhere.", "heading_before": "Elsewhere.",
         "removed": False, "instructions": [], "paragraphs": [{"path": "(a)", "before": "x", "after": "y", "kind": "p"}]},
    ]}


def test_compose_the_subpart_as_it_would_read():
    from ecfr_reader.proposals.compose import compose
    r = compose(_unit(), _proposal())
    assert r["as_of"] == "proposed" and [s["identifier"] for s in r["sections"]] == ["999.10", "999.11", "999.115"]
    s10 = r["sections"][0]
    assert [b["text"] for b in s10["blocks"]] == [
        "Spark ignition engine means an engine.",
        "(1) The first numbered paragraph, revised.",            # replaced
        "(3) The third, as EPA had it.",                           # (2) and its child removed by instruction
        "(4) A fourth, added.", "(i) Under the fourth."]           # inserted after the anchor, child after parent
    s11 = r["sections"][1]
    assert s11["heading"] == "§ 999.11 Emission standards and limits."
    assert [b.get("text") or b["type"] for b in s11["blocks"]] == ["(a) Table 1 lists the standards.", "table"]
    assert r["sections"][2]["heading"] == "§ 999.115 A brand new section." and r["sections"][2]["proposed"] == "added"
    c = r["coverage"]
    assert c["sections_touched"] == 2 and c["replaced"] == 2 and c["inserted"] == 2 and c["removed"] == 2
    assert c["added_sections"] == ["999.115"] and c["removed_sections"] == ["999.12"] and c["other_parts"] == ["60"]
    assert c["unmatched"] == [{"identifier": "999.10", "path": "(9)", "text": "(9) A paragraph EPA thinks exists, changed."}]
    assert all(s["as_of"] == "proposed" for s in r["sections"])
    assert _unit()["sections"][0]["blocks"][1]["text"].endswith("paragraph.")       # the input is untouched


def test_compose_before_side_checks_the_base():
    from ecfr_reader.proposals.compose import compose
    r = compose(_unit(), _proposal(), side="before")
    s10 = r["sections"][0]
    assert [b["text"] for b in s10["blocks"]][:3] == ["Spark ignition engine means an engine.",
                                                      "(1) The first numbered paragraph.", "(2) The second numbered paragraph."]
    assert [b["text"] for b in s10["blocks"]][-1] == "(3) The third, as EPA had it."   # EPA's base text stands in
    assert len(r["sections"]) == 3 and r["sections"][2]["identifier"] == "999.12"       # nothing added or removed
    c = r["coverage"]
    assert c["base_compared"] == 3 and c["base_matched"] == 2 and c["base_match"] == 0.667
    assert c["mismatches"][0]["path"] == "(3)" and c["mismatches"][0]["local"] == "(3) The third."


def test_compose_replace_mode_swaps_whole_sections():
    from ecfr_reader.proposals.compose import compose
    r = compose(_unit(), _proposal(), mode="replace")
    s10 = r["sections"][0]
    assert [b["text"] for b in s10["blocks"]] == ["(1) The first numbered paragraph, revised.", "(3) The third, as EPA had it.",
                                                   "(4) A fourth, added.", "(i) Under the fourth.",
                                                   "(9) A paragraph EPA thinks exists, changed."]
    assert r["coverage"]["replaced"] == 5 and r["coverage"]["unmatched"] == []


# ── routes ─────────────────────────────────────────────────────────────

from test_dockets import DOCKET, regs_gov   # noqa: E402,F401  (the fake regulations.gov)


def _redline_docx():
    return docx_bytes([
        [("MEMORANDUM: Redline/Strikeout for amendments to 40 CFR part 999", None)],
        [("Section 999.10 is amended by:", None)],
        [("a. Revising paragraph (1);", None)],
        [("b. Removing paragraph (2); and", None)],
        [("c. Adding paragraph (3).", None)],
        [("§ 999.10 Definitions.", None)],
        [("(1) The first numbered paragraph", None), (", revised", "ins"), (".", None)],
        [("(2) The second numbered paragraph, with a figure inside.", "del")],
        [("(3) A third numbered paragraph.", "ins")],
    ])


def test_import_a_proposal_and_compose_the_unit(client, regs_gov):
    from ecfr_reader.dockets import sync
    c = client
    assert c.post("/api/dockets", json={"docket_id": DOCKET, "pull": "none"}).status_code == 201
    sync.wait(DOCKET, timeout=10)
    doc = "EPA-HQ-OAR-2021-0317-3859"
    up = lambda name, data: c.post(f"/api/dockets/documents/{doc}/upload", data={"file": (io.BytesIO(data), name)},
                                   content_type="multipart/form-data").get_json()["file"]
    # a catalogued pdf that was never kept, and a kept spreadsheet, are refused with the reason
    pdf = [f for f in c.get(f"/api/dockets/documents/{doc}").get_json()["files"] if f["format"] == "pdf"][0]
    r = c.post(f"/api/dockets/files/{pdf['id']}/proposal")
    assert r.status_code == 400 and "Keep a copy" in r.get_json()["error"]
    xlsx = up("attachment_1.xlsx", b"x" * 48213)
    assert c.post(f"/api/dockets/files/{xlsx['id']}/proposal").status_code == 400
    # the redline, dropped in as an extra file on the memo
    f = up("redline.docx", _redline_docx())
    r = c.post(f"/api/dockets/files/{f['id']}/proposal", json={"mode": "amend"})
    assert r.status_code == 201, r.get_json()
    p = r.get_json()["proposal"]
    assert p["kind"] == "redline" and p["parts"] == ["999"] and p["subparts"] == ["A"] and p["mode"] == "amend"
    assert p["stats"]["n_del"] == 1 and p["stats"]["n_ins"] == 2 and p["stats"]["sections"] == 1 and p["stats"]["instructions"] == 3
    assert r.get_json()["warnings"] == []
    assert p["title"] == "01.17.2023 Meeting with GPA Midstream"
    assert c.get("/api/dockets/proposals?part=999").get_json()["proposals"][0]["id"] == p["id"]
    assert c.get("/api/dockets/proposals?part=60").get_json()["proposals"] == []
    assert [x["proposal_id"] for x in c.get(f"/api/dockets/documents/{doc}").get_json()["files"] if x["id"] == f["id"]] == [p["id"]]

    u = c.get(f"/api/dockets/proposals/{p['id']}/unit?part=999&subpart=A").get_json()
    plain = c.get("/api/ecfr/unit?part=999&subpart=A").get_json()
    assert set(plain) <= set(u) and u["as_of"] == "proposed" and u["proposal"]["id"] == p["id"]
    s10 = u["sections"][0]
    assert s10["section_key"] == "999:999.10" and s10["as_of"] == "proposed" and s10["proposed"] == "amended"
    assert [b["text"] for b in s10["blocks"]] == ["Spark ignition engine means an engine that uses a spark plug to ignite the mixture.",
                                                  "(1) The first numbered paragraph, revised.", "(3) A third numbered paragraph."]
    assert u["sections"][1]["blocks"] == plain["sections"][1]["blocks"]          # 999.11 untouched
    cov = u["coverage"]
    assert (cov["sections_touched"], cov["replaced"], cov["inserted"], cov["removed"], cov["unmatched"]) == (1, 1, 1, 1, [])
    before = c.get(f"/api/dockets/proposals/{p['id']}/unit?part=999&subpart=A&side=before").get_json()
    assert before["coverage"]["base_match"] == 1.0 and len(before["sections"][0]["blocks"]) == 3
    sec = c.get(f"/api/dockets/proposals/{p['id']}/section?key=999:999.10").get_json()
    assert sec["blocks"][1]["text"].endswith("revised.") and sec["coverage"]["replaced"] == 1
    assert c.get(f"/api/dockets/proposals/{p['id']}/section?key=999:nope").status_code == 404
    assert c.get(f"/api/dockets/proposals/{p['id']}/unit?part=999&subpart=A&side=sideways").status_code == 400
    assert c.get(f"/api/dockets/proposals/{p['id']}/unit?part=999&subpart=Z").status_code == 404
    # a re-import replaces the reading; a preamble-only file is refused
    again = c.post(f"/api/dockets/files/{f['id']}/proposal", json={"mode": "replace"}).get_json()["proposal"]
    assert again["mode"] == "replace" and again["id"] != p["id"]
    assert [x["id"] for x in c.get("/api/dockets/proposals").get_json()["proposals"]] == [again["id"]]
    assert c.get(f"/api/dockets/proposals/{p['id']}").status_code == 404           # the earlier reading is gone
    pre = up("preamble.docx", docx_bytes([[("SUMMARY: The EPA is proposing amendments.", None)]]))
    assert c.post(f"/api/dockets/files/{pre['id']}/proposal").status_code == 422
    assert c.delete(f"/api/dockets/proposals/{again['id']}").status_code == 200
    assert c.get("/api/dockets/proposals").get_json()["proposals"] == []
