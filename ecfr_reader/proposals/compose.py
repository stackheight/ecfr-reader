"""Apply a parsed proposal to a local unit, so the result reads as the
subpart would after the rule — the same payload shape /api/ecfr/unit
returns, plus a `coverage` report that says what was done and, above all,
what did not fit. An unmatched paragraph is listed, never dropped.

    compose(unit, proposal, side="after"|"before", mode="amend"|"replace")

side "after" is the proposal's text (struck runs dropped); "before" is the
base EPA marked up (inserted runs dropped), composed the same way so it
can be diffed against the snapshot: coverage.base_match says how much of
that base equals the local text paragraph for paragraph.
"""

import copy
import re

from .parse import _kinds, _roman_value, block_paths

_TOKEN_RE = re.compile(r"\(([^()]+)\)")


def _ordinal(token, siblings):
    """Order a token among its siblings: digits by value, letters by (length,
    text), numerals by value when the siblings read as numerals."""
    if token.isdigit():
        return (0, int(token), "")
    roman = "roman" in _kinds(token) and any(t not in ("i", "v", "x", "l", "c") and "roman" in _kinds(t) for t in siblings)
    if roman or ("alpha" not in _kinds(token) and "roman" in _kinds(token)):
        return (1, _roman_value(token) or 0, "")
    return (2, len(token), token.lower())


def _insert_at(paths, path):
    """Where a new block with `path` goes: after the last existing sibling
    that precedes it, else right after its parent, else at the end. None
    when the parent is unknown."""
    tokens = _TOKEN_RE.findall(path)
    if not tokens:
        return None
    parent = "".join(f"({t})" for t in tokens[:-1])
    depth = len(tokens)
    sibs = [(i, _TOKEN_RE.findall(pth)[-1]) for i, pth in enumerate(paths)
            if pth.startswith(parent) and len(_TOKEN_RE.findall(pth)) == depth and "+" not in pth]
    names = [t for _, t in sibs]
    mine = _ordinal(tokens[-1], names)
    before = [i for i, t in sibs if _ordinal(t, names) < mine]
    if before:
        return _children_end(paths, max(before))
    if parent and parent in paths:
        return paths.index(parent) + 1
    if not parent:
        return len(paths)
    return None

_QUOTES = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "—": "-", "–": "-",
                         " ": " "})


def normalise(text):
    t = (text or "").translate(_QUOTES).lower()
    t = re.sub(r"\s+", " ", t)
    t = re.sub(r"\s*([,.;:()])\s*", r"\1", t)
    return t.strip()


def _ident_key(ident):
    m = re.match(r"(\d+)\.(\d+)([a-z]*)", ident or "")
    return (int(m.group(1)), int(m.group(2)), m.group(3)) if m else (0, 0, ident or "")


def _children_end(paths, i):
    """Index just past block i and every block nested under it."""
    base = paths[i]
    j = i + 1
    while j < len(paths) and (paths[j].startswith(base + "(") or paths[j].startswith(base + "+")):
        j += 1
    return j


def compose(unit: dict, proposal: dict, side: str = "after", mode: str = "amend") -> dict:
    out = copy.deepcopy(unit)
    sections = out.get("sections") or []
    part = str(out.get("part") or (sections[0]["part"] if sections else ""))
    by_ident = {s["identifier"]: s for s in sections}
    cov = {"side": side, "mode": mode, "sections_touched": 0, "replaced": 0, "inserted": 0, "removed": 0,
           "added_sections": [], "removed_sections": [], "unmatched": [], "other_parts": [],
           "base_compared": 0, "base_matched": 0, "base_match": None, "mismatches": []}

    for ps in proposal.get("sections") or []:
        ident = ps["identifier"]
        if ps.get("part") and ps["part"] != part:
            if ps["part"] not in cov["other_parts"]:
                cov["other_parts"].append(ps["part"])
            continue
        sec = by_ident.get(ident)
        texts = [(p["path"], p[side], p) for p in ps["paragraphs"]]

        if ps.get("removed"):
            if sec is not None and side == "after":
                sections.remove(sec)
                del by_ident[ident]
                cov["removed_sections"].append(ident)
            continue

        if sec is None:
            blocks = [{"type": "p", "text": t} for _, t, _ in texts if t]
            if not blocks:
                continue                       # a new section has no "before"
            heading = ps["heading"] if side == "after" else ps.get("heading_before") or ps["heading"]
            new = {"section_key": f"{part}:{ident}", "part": part, "subpart": out.get("subpart") or ps.get("subpart"),
                   "identifier": ident, "type": "section", "heading": f"§ {ident} {heading}".strip(),
                   "citation": f"40 CFR {ident}", "blocks": blocks, "proposed": "added"}
            pos = len(sections)
            for i, s in enumerate(sections):
                if _ident_key(s["identifier"]) > _ident_key(ident):
                    pos = i
                    break
            sections.insert(pos, new)
            by_ident[ident] = new
            cov["added_sections"].append(ident)
            continue

        cov["sections_touched"] += 1
        sec["proposed"] = "amended"
        heading = ps["heading"] if side == "after" else ps.get("heading_before")
        if heading and normalise(heading) != normalise(re.sub(r"^§\s*\S+\s*", "", sec.get("heading") or "")):
            sec["heading"] = f"§ {ident} {heading}"
        blocks = sec["blocks"]

        if mode == "replace":
            new_blocks = [{"type": "p", "text": t} for _, t, _ in texts if t]
            cov["replaced"] += len(new_blocks)
            cov["removed"] += max(0, len(blocks) - len(new_blocks))
            sec["blocks"] = new_blocks
            continue

        paths = block_paths(blocks)
        # explicit removals first
        if side == "after":
            for instr in ps.get("instructions") or []:
                if instr["verb"] in ("remove", "reserve") and instr.get("target") == "paragraph":
                    for target in instr["paths"]:
                        if target in paths:
                            i = paths.index(target)
                            j = _children_end(paths, i)
                            if instr["verb"] == "reserve":
                                blocks[i:j] = [{"type": "p", "text": f"{target} [Reserved]"}]
                                cov["replaced"] += 1
                            else:
                                del blocks[i:j]
                                cov["removed"] += 1
                            paths = block_paths(blocks)
        add_paths = [t for instr in (ps.get("instructions") or []) if instr["verb"] == "add" for t in instr["paths"]]

        anchor = None                                   # index of the last block placed
        for path, text, p in texts:
            index = {}
            for i, pth in enumerate(paths):
                index.setdefault(pth, i)
            if path in index:
                i = index[path]
                if side == "before" and p["before"]:
                    cov["base_compared"] += 1
                    if normalise(p["before"]) == normalise(blocks[i].get("text")):
                        cov["base_matched"] += 1
                    else:
                        cov["mismatches"].append({"identifier": ident, "path": path,
                                                  "local": (blocks[i].get("text") or "")[:120],
                                                  "proposal": p["before"][:120]})
                if text == "":
                    if side == "after":
                        del blocks[i:_children_end(paths, i)]
                        cov["removed"] += 1
                        paths = block_paths(blocks)
                        anchor = i - 1 if i else None
                    continue
                if blocks[i].get("type") == "p":
                    blocks[i]["text"] = text
                else:
                    blocks[i] = {"type": "p", "text": text}
                cov["replaced"] += 1
                anchor = i
                continue
            if text == "":
                continue                                # struck where nothing stands: nothing to do
            is_new = (side == "after" and not p.get("before")) or any(path.startswith(a) for a in add_paths)
            if not is_new:
                cov["unmatched"].append({"identifier": ident, "path": path, "text": text[:120]})
                continue
            at = _insert_at(paths, path)
            if at is None:
                at = _children_end(paths, anchor) if anchor is not None else len(blocks)
            blocks.insert(at, {"type": "p", "text": text})
            cov["inserted"] += 1
            paths = block_paths(blocks)
            anchor = at

    if cov["base_compared"]:
        cov["base_match"] = round(cov["base_matched"] / cov["base_compared"], 3)
    for s in sections:
        s["as_of"] = "proposed"
    out["sections"] = sections
    out["as_of"] = "proposed"
    out["coverage"] = cov
    return out
