"""A docket file → marked paragraphs.

    extract(path) -> {"format": "docx"|"pdf", "pages": n, "n_del": …, "n_ins": …,
                      "paragraphs": [{"runs": [[text, mark], …], "kind": "p"|"table", "page": n}, …]}

`mark` is None for plain text, "del" for text the document strikes out and
"ins" for text it inserts — the two halves of a redline. A paragraph's
before-text is its runs without the inserts, its after-text the runs
without the strikes (paragraph_text). A document with no marks at all is
"clean": both halves are the same text.

DOCX is exact: Word keeps tracked changes (w:ins / w:del) and formatting
(w:strike, w:dstrike, w:u) in the XML. Read with the standard library.

PDF is geometry: a strike or an underline is a thin rectangle or line the
producer drew across the words, so pdfminer.six's character boxes are
paired with the thin horizontal shapes on the page. A mark through the
middle of a character's box is a strike (del); one along its baseline is
an underline (ins). It is a best effort, and the counts are reported so
the user can judge it against the DOCX when the docket has one.
"""

import os
import re
import zipfile
import xml.etree.ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
ENUM_START = re.compile(r"^\s*\((?:[a-z]{1,2}|\d{1,3}|[ivxl]{1,6}|[A-Z]{1,2})\)")
HEADING_START = re.compile(r"^\s*(§|Sec\.|Section\s+\d|PART\s+\d|Subpart\s+[A-Z]|Amend\s|Appendix\s)", re.I)
INSTRUCTION_START = re.compile(r"^\s*(\d{1,3}|[a-z]|[ivx]{1,4})\.\s+\S")
PAGE_NUMBER = re.compile(r"^\s*(page\s+)?\d{1,4}(\s+of\s+\d{1,4})?\s*$", re.I)


class ExtractError(Exception):
    """The file could not be read as proposed text; .args[0] is UI-safe."""


def extract(path: str) -> dict:
    ext = os.path.splitext(path)[1].lower().lstrip(".")
    if ext == "docx":
        return extract_docx(path)
    if ext == "pdf":
        return extract_pdf(path)
    raise ExtractError(f"Proposed text can be read from a .docx or a .pdf, not .{ext or '?'}.")


def paragraph_text(p: dict, side: str = "after") -> str:
    """The paragraph as it reads on one side of the redline: "after" drops
    the struck runs, "before" drops the inserted ones. Whitespace squashed."""
    drop = "del" if side == "after" else "ins"
    text = "".join(t for t, m in p["runs"] if m != drop)
    return re.sub(r"\s+", " ", text).strip()


def _finish(paragraphs, fmt, pages):
    out = []
    for p in paragraphs:
        runs = _merge_runs(p["runs"])
        if not any(t.strip() for t, _ in runs):
            continue
        out.append({"runs": runs, "kind": p.get("kind", "p"), "page": p.get("page")})
    n_del = sum(1 for p in out for t, m in p["runs"] if m == "del" and t.strip())
    n_ins = sum(1 for p in out for t, m in p["runs"] if m == "ins" and t.strip())
    return {"format": fmt, "pages": pages, "n_del": n_del, "n_ins": n_ins, "paragraphs": out}


def _merge_runs(runs):
    """Adjacent runs with the same mark become one; whitespace-only runs
    take their neighbours' mark so a space never splits a span."""
    merged = []
    for text, mark in runs:
        if not text:
            continue
        if merged and (merged[-1][1] == mark or not text.strip()):
            merged[-1][0] += text
        elif merged and not merged[-1][0].strip():
            merged[-1] = [merged[-1][0] + text, mark]
        else:
            merged.append([text, mark])
    return merged


# ── DOCX ───────────────────────────────────────────────────────────────

def extract_docx(path: str) -> dict:
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read("word/document.xml")
    except (zipfile.BadZipFile, KeyError, OSError) as e:
        raise ExtractError(f"Not a Word document ({e}).") from e
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as e:
        raise ExtractError(f"The Word document's XML did not parse ({e}).") from e
    body = root.find(f"{W}body")
    if body is None:
        raise ExtractError("The Word document has no body.")
    paragraphs = []
    _docx_block(body, paragraphs)
    return _finish(paragraphs, "docx", None)


def _docx_block(elem, out):
    for child in elem:
        tag = child.tag
        if tag == f"{W}p":
            runs = []
            _docx_runs(child, runs, None)
            out.append({"runs": runs, "kind": "p"})
        elif tag == f"{W}tbl":
            cells = []
            for tr in child.iter(f"{W}tr"):
                row = []
                for tc in tr.findall(f"{W}tc"):
                    runs = []
                    for p in tc.iter(f"{W}p"):
                        _docx_runs(p, runs, None)
                        runs.append([" ", None])
                    row.append(runs)
                cells.append(row)
            runs = []
            for row in cells:
                for i, cell in enumerate(row):
                    runs.extend(cell)
                    runs.append([" | " if i < len(row) - 1 else " / ", None])
            out.append({"runs": runs, "kind": "table"})
        elif tag in (f"{W}sdt", f"{W}sdtContent", f"{W}customXml"):
            inner = child.find(f"{W}sdtContent") if tag == f"{W}sdt" else child
            if inner is not None:
                _docx_block(inner, out)


def _docx_runs(elem, runs, mark):
    for child in elem:
        tag = child.tag
        if tag in (f"{W}ins", f"{W}moveTo"):
            _docx_runs(child, runs, "ins")
        elif tag in (f"{W}del", f"{W}moveFrom"):
            _docx_runs(child, runs, "del")
        elif tag == f"{W}r":
            m = mark or _run_mark(child)
            text = []
            for t in child:
                if t.tag in (f"{W}t", f"{W}delText"):
                    text.append(t.text or "")
                elif t.tag == f"{W}tab":
                    text.append(" ")
                elif t.tag in (f"{W}br", f"{W}cr"):
                    text.append(" ")
                elif t.tag == f"{W}sym":
                    text.append("§" if (t.get(f"{W}char") or "").upper() in ("A7", "F0A7") else "")
            runs.append(["".join(text), m])
        elif tag in (f"{W}hyperlink", f"{W}smartTag", f"{W}sdt", f"{W}sdtContent", f"{W}fldSimple", f"{W}customXml"):
            _docx_runs(child, runs, mark)


def _run_mark(r):
    rpr = r.find(f"{W}rPr")
    if rpr is None:
        return None
    for tag in (f"{W}strike", f"{W}dstrike"):
        el = rpr.find(tag)
        if el is not None and (el.get(f"{W}val") or "true").lower() not in ("0", "false", "off"):
            return "del"
    u = rpr.find(f"{W}u")
    if u is not None and (u.get(f"{W}val") or "single").lower() != "none":
        return "ins"
    return None


# ── PDF ────────────────────────────────────────────────────────────────

MARK_MAX_HEIGHT = 2.0      # pt: thicker than this is a box or a rule, not a strike
MARK_MIN_WIDTH = 2.5


def extract_pdf(path: str) -> dict:
    try:
        from pdfminer.high_level import extract_pages
        from pdfminer.layout import LAParams, LTAnno, LTChar, LTCurve, LTLine, LTRect, LTTextBox, LTTextLine
    except ImportError as e:
        raise ExtractError("Reading a PDF needs pdfminer.six (pip install -r requirements.txt).") from e
    pages = []          # per page: list of lines; a line = {"runs": [...], "box": id, "y": y0, "x0": x0}
    try:
        for page_no, page in enumerate(extract_pages(path, laparams=LAParams(line_margin=0.3, char_margin=2.5)), 1):
            marks = []
            boxes = []
            _pdf_collect(page, marks, boxes, (LTRect, LTLine, LTCurve), LTTextBox)
            lines = []
            for box_id, box in enumerate(boxes):
                for line in box:
                    if not isinstance(line, LTTextLine):
                        continue
                    runs, prev = [], None
                    for ch in line:
                        if isinstance(ch, LTChar):
                            m = _mark_for(ch, marks)
                            runs.append([ch.get_text(), m])
                            prev = m
                        elif isinstance(ch, LTAnno):
                            runs.append([" " if ch.get_text() != "\n" else "", prev])
                    text = "".join(t for t, _ in runs)
                    if text.strip():
                        lines.append({"runs": runs, "box": box_id, "x0": line.x0, "y0": line.y0, "text": text})
            pages.append(lines)
    except Exception as e:       # pdfminer raises a zoo of its own types on a bad file
        if isinstance(e, ExtractError):
            raise
        raise ExtractError(f"The PDF could not be read ({type(e).__name__}: {e}).") from e
    if not any(pages):
        raise ExtractError("No text in the PDF (a scanned image needs OCR first).")
    _drop_running_lines(pages)
    paragraphs = _pdf_paragraphs(pages)
    return _finish(paragraphs, "pdf", len(pages))


def _pdf_collect(container, marks, boxes, mark_types, box_type):
    for obj in container:
        if isinstance(obj, mark_types):
            w, h = obj.x1 - obj.x0, obj.y1 - obj.y0
            if h <= MARK_MAX_HEIGHT and w >= MARK_MIN_WIDTH:
                marks.append((obj.x0, obj.x1, (obj.y0 + obj.y1) / 2))
        elif isinstance(obj, box_type):
            boxes.append(obj)
        elif hasattr(obj, "__iter__") and not isinstance(obj, (str, bytes)):
            try:
                _pdf_collect(obj, marks, boxes, mark_types, box_type)
            except TypeError:
                pass


def _mark_for(ch, marks):
    """A thin horizontal shape across the character: through its middle →
    strike (del); along its baseline → underline (ins)."""
    if not marks:
        return None
    h = ch.height or ch.size or 10
    cx = (ch.x0 + ch.x1) / 2
    for x0, x1, y in marks:
        if x0 - 1.0 <= cx <= x1 + 1.0:
            rel = (y - ch.y0) / h
            if 0.3 <= rel <= 0.8:
                return "del"
            if -0.15 <= rel < 0.3:
                return "ins"
    return None


def _drop_running_lines(pages):
    """Running headers and footers: a line (digits blanked) that sits first
    or last on most pages, and bare page numbers anywhere at the edge."""
    if len(pages) < 2:
        for lines in pages:
            lines[:] = [l for l in lines if not PAGE_NUMBER.match(l["text"])]
        return
    seen = {}
    for lines in pages:
        edge = {re.sub(r"\d+", "#", l["text"].strip()) for l in (lines[:1] + lines[-1:])}
        for key in edge:
            seen[key] = seen.get(key, 0) + 1
    running = {k for k, n in seen.items() if n >= max(2, 0.6 * len(pages))}
    for lines in pages:
        keep = []
        for i, l in enumerate(lines):
            at_edge = i == 0 or i == len(lines) - 1
            key = re.sub(r"\d+", "#", l["text"].strip())
            if at_edge and (key in running or PAGE_NUMBER.match(l["text"])):
                continue
            keep.append(l)
        lines[:] = keep


def _pdf_paragraphs(pages):
    """Lines → paragraphs. A new paragraph starts at a new text box, at a
    line that opens with an enumerator, a section heading or an amendatory
    instruction, or after a line that ends a sentence when the next line is
    indented. A hyphen at a line end joins to the next line."""
    out = []
    cur, cur_box, cur_page = None, None, None
    for page_no, lines in enumerate(pages, 1):
        for l in lines:
            text = l["text"].strip()
            starts_new = (cur is None or l["box"] != cur_box
                          or ENUM_START.match(text) or HEADING_START.match(text) or INSTRUCTION_START.match(text))
            if starts_new or cur is None:
                cur = {"runs": [], "kind": "p", "page": page_no}
                out.append(cur)
                cur_box, cur_page = l["box"], page_no
            else:
                # joining: a hyphenated break loses the hyphen, anything else gets a space
                so_far = "".join(t for t, _ in cur["runs"]).rstrip()
                if so_far.endswith("-") and text[:1].islower():
                    for i in range(len(cur["runs"]) - 1, -1, -1):
                        stripped = cur["runs"][i][0].rstrip()
                        if stripped:
                            cur["runs"][i][0] = stripped[:-1]
                            break
                    cur["runs"] = cur["runs"][:i + 1]
                else:
                    cur["runs"].append([" ", None])
            cur["runs"].extend([t, m] for t, m in l["runs"])
            cur_box, cur_page = l["box"], page_no
    return out
