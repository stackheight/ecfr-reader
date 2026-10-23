"""Render eCFR Title 40 bulk XML (DIV5=part, DIV6=subpart, DIV7=subject group,
DIV8=section, DIV9=appendix) into the block structures stored in the corpus
database: a list of paragraph / table BLOCK objects per section, so a
highlight can anchor to one paragraph.

The table-grid and citation-parsing logic is adapted from the author's own
earlier, unpublished script; it contains no code from third-party eCFR
parsers.
"""

import html
import json
import re

from bs4 import NavigableString

# Tags whose content becomes its own paragraph block.
BLOCK_TAGS = {
    "P", "FP", "FP-1", "FP-2", "HD", "HD1", "HD2", "HD3", "NOTE",
    "EXTRACT", "CITA", "SECAUTH", "APPRO", "EFFDNOT", "EDNOTE",
}

# Structural division tags (DIV1..DIV9) — nested ones become their own
# records and must not be flattened into a parent section's blocks.
_STRUCTURAL_DIV = re.compile(r"DIV\d")


def _squash(text):
    return re.sub(r"\s+", " ", text).strip()


def _cite_text(element):
    """Text of an AUTH/SOURCE element without its 'Authority:'/'Source:' label."""
    if element is None:
        return ""
    body = element.find("PSPACE") or element
    text = _squash(body.get_text(" ", strip=True))
    return re.sub(r"^(Authority|Source):\s*", "", text)


def _div_metadata(div):
    """Parse the hierarchy_metadata attribute (entity-escaped JSON, sometimes twice)."""
    raw = div.get("hierarchy_metadata", "")
    while "&quot;" in raw:
        raw = html.unescape(raw)
    try:
        return json.loads(raw)
    except (ValueError, TypeError):
        return {}


def _expand_grid(trs):
    """Expand TR rows into a rectangular text grid, honoring rowspan/colspan."""
    grid = {}
    n_cols = 0
    for r, tr in enumerate(trs):
        c = 0
        for cell in tr.find_all(["TH", "TD"], recursive=False):
            while (r, c) in grid:
                c += 1
            text = _squash(cell.get_text(" ", strip=True))
            rowspan = int(cell.get("rowspan", 1))
            colspan = int(cell.get("colspan", 1))
            for dr in range(rowspan):
                for dc in range(colspan):
                    grid[(r + dr, c + dc)] = text
            c += colspan
            n_cols = max(n_cols, c)
    return [[grid.get((r, c), "") for c in range(n_cols)] for r in range(len(trs))]


def _parse_table(table):
    """Parse an HTML-style TABLE into a structured table block."""
    caption_el = table.find("CAPTION")
    caption = _squash(caption_el.get_text(" ", strip=True)) if caption_el else ""

    thead = table.find("THEAD")
    header_grid = _expand_grid(thead.find_all("TR", recursive=False)) if thead else []
    # Multi-row heads: name each column by joining its stacked (deduped) cells.
    headers = []
    if header_grid:
        for col in zip(*header_grid):
            parts = []
            for cell in col:
                if cell and (not parts or parts[-1] != cell):
                    parts.append(cell)
            headers.append(" / ".join(parts))

    body_trs = [tr for tr in table.find_all("TR")
                if tr.find_parent("THEAD") is None and tr.find_parent("TFOOT") is None]
    rows = _expand_grid(body_trs)

    tfoot = table.find("TFOOT")
    footnotes = []
    if tfoot:
        for tr in tfoot.find_all("TR"):
            note = _squash(tr.get_text(" ", strip=True))
            if note:
                footnotes.append(note)

    n_cols = max([len(headers)] + [len(r) for r in rows]) if (headers or rows) else 0
    headers = (headers + [""] * n_cols)[:n_cols]
    rows = [(r + [""] * n_cols)[:n_cols] for r in rows]

    return {"type": "table", "caption": caption, "headers": headers,
            "rows": rows, "footnotes": footnotes}


def _inline_text(element):
    """Flatten an element's content to text; images become bracketed placeholders."""
    out = []
    for child in element.children:
        if isinstance(child, NavigableString):
            out.append(str(child))
            continue
        name = child.name or ""
        if name == "img":
            label = child.get("src", "unnamed").rsplit("/", 1)[-1]
            kind = "FORMULA" if (element.name or "") == "MATH" else "GRAPHIC"
            out.append(f"[{kind}: {label}]")
            continue
        out.append(_inline_text(child))
    return "".join(out)


def _block_text(element):
    text = re.sub(r"[ \t]+", " ", _inline_text(element))
    text = re.sub(r" ?\n ?", " ", text)
    return _squash(text)


def _collect_blocks(element, blocks, skip_head):
    """Walk element's children in document order, appending paragraph/table
    blocks. Recurses into non-block wrapper elements; stops at nested
    structural DIVs (a section/appendix never contains another one)."""
    for child in element.children:
        if isinstance(child, NavigableString):
            continue
        name = child.name or ""
        if _STRUCTURAL_DIV.fullmatch(name):
            continue  # nested structural divisions become their own records
        if skip_head and name == "HEAD":
            skip_head = False
            continue
        if name == "TABLE":
            blocks.append(_parse_table(child))
            continue
        if name in BLOCK_TAGS:
            text = _block_text(child)
            if text:
                blocks.append({"type": "p", "text": text})
            continue
        _collect_blocks(child, blocks, skip_head)


def render_part(soup):
    """Render one parsed part XML tree.

    Returns (part_num, part_heading, subparts, sections):
      subparts: [{"subpart": "JJJJ", "heading": ..., "order_index": int}]
      sections: [{"section_key", "part", "subpart", "identifier", "type",
                  "heading", "citation", "authority", "source", "blocks",
                  "order_index"}]
    """
    part_div = soup.find("DIV5")
    part_num = part_div.get("N")
    part_head_el = part_div.find("HEAD", recursive=False)
    part_heading = _squash(part_head_el.get_text(" ", strip=True)) if part_head_el else ""
    part_authority = _cite_text(part_div.find("AUTH", recursive=False))
    part_source = _cite_text(part_div.find("SOURCE", recursive=False))

    subparts = []
    seen_subparts = {}
    for i, div6 in enumerate(part_div.find_all("DIV6", recursive=True)):
        subpart_id = div6.get("N")
        if subpart_id in seen_subparts:
            continue
        head_el = div6.find("HEAD", recursive=False)
        heading = _squash(head_el.get_text(" ", strip=True)) if head_el else ""
        seen_subparts[subpart_id] = {
            "authority": _cite_text(div6.find("AUTH", recursive=False)) or part_authority,
            "source": _cite_text(div6.find("SOURCE", recursive=False)) or part_source,
        }
        subparts.append({"subpart": subpart_id, "heading": heading, "order_index": i})

    sections = []
    for order_index, div in enumerate(part_div.find_all(["DIV8", "DIV9"])):
        div_type = (div.get("TYPE") or "").lower()
        if div_type not in ("section", "appendix"):
            continue

        subpart_div = div.find_parent("DIV6")
        subpart_id = subpart_div.get("N") if subpart_div else None
        auth_src = seen_subparts.get(subpart_id, {
            "authority": part_authority, "source": part_source})

        head_el = div.find("HEAD", recursive=False)
        heading = _squash(head_el.get_text(" ", strip=True)) if head_el else ""

        identifier = div.get("N", "")
        meta = _div_metadata(div)
        citation = meta.get("citation", "")
        if not citation:
            if div_type == "section":
                citation = f"40 CFR {identifier}"
            else:
                short = identifier.split(" to ")[0] if identifier else "Appendix"
                citation = f"40 CFR Part {part_num}, {short}"

        blocks = []
        _collect_blocks(div, blocks, skip_head=True)

        sections.append({
            "section_key": f"{part_num}:{identifier}",
            "part": part_num,
            "subpart": subpart_id,
            "identifier": identifier,
            "type": div_type,
            "heading": heading,
            "citation": citation,
            "authority": auth_src["authority"],
            "source": auth_src["source"],
            "blocks": blocks,
            "order_index": order_index,
        })

    return part_num, part_heading, subparts, sections


def render_unit(soup, part_num):
    """Render a whole live UNIT — every section of one subpart — from the
    versioner API's /full/{date}/title-{n}.xml?part=&subpart= endpoint.

    Exists because the reader shows a subpart at a time. Fetching that subpart
    a section at a time is 23 requests to ecfr.gov for one screen, which earns
    a real HTTP 429; asking for the subpart itself is ONE request (~130 KB,
    under a second) and returns exactly the same sections.

    The root here is the DIV6 subpart, so its own authority/source are
    readable where it declares them — but the part-level ancestors aren't in
    the fragment, and that's where Title 40 usually puts them, so in practice
    these come back empty (subpart JJJJ does). Empty is the honest answer: the
    alternative is borrowing the local snapshot's authority and captioning
    live text with it. The reader only shows authority for the local frame
    anyway.

    Returns {"subpart", "heading", "sections": [...]} shaped like render_part's
    sections, or None if the fragment has no subpart root.
    """
    div6 = soup.find("DIV6")
    if div6 is None:
        return None

    subpart_id = div6.get("N")
    head_el = div6.find("HEAD", recursive=False)
    heading = _squash(head_el.get_text(" ", strip=True)) if head_el else ""
    meta = _div_metadata(div6)
    authority = meta.get("authority", "")
    source = meta.get("source", "")

    sections = []
    for order_index, div in enumerate(div6.find_all(["DIV8", "DIV9"])):
        div_type = (div.get("TYPE") or "").lower()
        if div_type not in ("section", "appendix"):
            continue
        sec_head = div.find("HEAD", recursive=False)
        identifier = div.get("N", "")
        sec_meta = _div_metadata(div)
        citation = sec_meta.get("citation", "") or (
            f"40 CFR {identifier}" if div_type == "section"
            else f"40 CFR Part {part_num}, {identifier.split(' to ')[0] or 'Appendix'}")
        blocks = []
        _collect_blocks(div, blocks, skip_head=True)
        sections.append({
            "section_key": f"{part_num}:{identifier}",
            "part": part_num,
            "subpart": subpart_id,
            "identifier": identifier,
            "type": div_type,
            "heading": _squash(sec_head.get_text(" ", strip=True)) if sec_head else "",
            "citation": citation,
            "authority": authority,
            "source": source,
            "blocks": blocks,
            "order_index": order_index,
        })

    return {"subpart": subpart_id, "heading": heading, "sections": sections}


def render_standalone(soup):
    """Render a single-section/appendix XML fragment, as returned by the eCFR
    versioner API's /full/{date}/title-{n}.xml?part=&section=(or &appendix=)
    endpoint — used for the reader's "view live from ecfr.gov" toggle
    (updates.py). The root element there IS the DIV8/DIV9 itself,
    with no part/subpart ancestors, so authority/source (only found on those
    ancestors) aren't resolvable here — the live view omits them.

    Returns None if the fragment has no section/appendix root.
    """
    div = soup.find(["DIV8", "DIV9"])
    if div is None:
        return None

    div_type = (div.get("TYPE") or "").lower()
    head_el = div.find("HEAD", recursive=False)
    heading = _squash(head_el.get_text(" ", strip=True)) if head_el else ""
    identifier = div.get("N", "")
    meta = _div_metadata(div)
    citation = meta.get("citation", "")

    blocks = []
    _collect_blocks(div, blocks, skip_head=True)

    return {"identifier": identifier, "type": div_type, "heading": heading,
            "citation": citation, "blocks": blocks}
