"""Marked paragraphs → the structure a proposal has: sections (by CFR
section number), amendatory instructions, and every paragraph keyed by its
enumerator path, with its before- and after-text.

    parse(extracted) -> {"sections": [{"identifier": "60.5398b", "part": "60", "subpart": "OOOOb"|None,
                                        "heading", "heading_before", "removed": bool,
                                        "instructions": [{"verb", "paths": [...]}],
                                        "paragraphs": [{"path", "before", "after", "kind"}]}],
                         "parts": ["60"], "front_matter": n}

Enumerator paths follow the CFR's six levels, (a) → (1) → (i) → (A) → (1)
→ (i), resolved against a stack so "(i)" after "(h)" is the letter and
"(i)" after "(1)" the numeral (PathResolver). The same resolver keys the
corpus side in compose.py, so a proposed "(b)(2)(i)" lands on the local
"(b)(2)(i)" whatever came between.
"""

import re

from .extract import paragraph_text

SECTION_RE = re.compile(r"^\s*§+\s*(\d+\.\d+[a-z]{0,2})\b\s*(\[.*?\])?\s*(.*)$")
AMEND_RE = re.compile(r"^\s*(?:Section|Sec\.|§)\s*(\d+\.\d+[a-z]{0,2})\s+(?:is|are)\s+(?:amended|revised|removed|added)",
                      re.I)
AMEND2_RE = re.compile(r"^\s*(?:\d+\.\s*)?(?:Amend|Revise|Remove|Add)\s+§\s*(\d+\.\d+[a-z]{0,2})\b", re.I)
PART_RE = re.compile(r"^\s*PART\s+(\d+)\b", re.I)
SUBPART_RE = re.compile(r"^\s*Subpart\s+([A-Z]{1,5})\b")
INSTR_RE = re.compile(r"^\s*(?:[a-z]|\d{1,3}|[ivx]{1,4})\.\s*(Revis\w*|Add\w*|Remov\w*|Reserv\w*|Redesignat\w*)\b(.*)$", re.I)
PATHS_RE = re.compile(r"((?:\([a-zA-Z0-9]{1,4}\))+)")
LEADERS_RE = re.compile(r"^\s*((?:\([a-zA-Z0-9]{1,4}\))+)")
REMOVED_RE = re.compile(r"\[(?:Removed|Reserved|Removed and Reserved)\]", re.I)

ROMAN = {"i": 1, "v": 5, "x": 10, "l": 50, "c": 100}


def _roman_value(s):
    total, prev = 0, 0
    for ch in reversed(s.lower()):
        v = ROMAN.get(ch)
        if v is None:
            return None
        total += -v if v < prev else v
        prev = max(prev, v)
    return total


def _to_roman(n):
    out = ""
    for v, sym in ((100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")):
        while n >= v:
            out += sym
            n -= v
    return out


def _alpha_next(s):
    """a→b … z→aa (the CFR goes (aa), (bb) after (z))."""
    if len(s) > 1 and len(set(s)) == 1:
        c = s[0]
        return (c + c) if c == "z" else chr(ord(c) + 1) * len(s)
    return "aa" if s == "z" else chr(ord(s) + 1)


NEXT_KIND = {"alpha": "num", "num": "roman", "roman": "Alpha", "Alpha": "num"}
FIRST = {"alpha": "a", "num": "1", "roman": "i", "Alpha": "A"}


def _kinds(token):
    """Which levels a token could sit on: "i" is alpha or roman, "1" num."""
    out = set()
    if token.isdigit():
        out.add("num")
    if re.fullmatch(r"[a-z]{1,2}", token):
        out.add("alpha")
    if re.fullmatch(r"[ivxlc]{1,6}", token) and _roman_value(token):
        out.add("roman")
    if re.fullmatch(r"[A-Z]{1,2}", token):
        out.add("Alpha")
    return out


def _successor(prev, kind):
    if kind == "num":
        return str(int(prev) + 1)
    if kind == "alpha":
        return _alpha_next(prev)
    if kind == "roman":
        return _to_roman((_roman_value(prev) or 0) + 1)
    if kind == "Alpha":
        return _alpha_next(prev.lower()).upper()
    return None


def _guess_kind(token):
    """A token with no context: letters are the (a) level, digits the (1)
    level, capitals the (A) level; only an unambiguous numeral is roman."""
    kinds = _kinds(token)
    for k in ("alpha", "num", "Alpha", "roman"):
        if k in kinds:
            return k
    return "alpha"


class PathResolver:
    """Feed each paragraph's leading enumerators; get its path, e.g.
    "(b)(2)(i)". The stack remembers the kind of each level in use, so a
    section whose enumeration starts at (1) (a definitions section) keys
    as "(1)", "(2)" and the CFR order alpha → num → roman → Alpha → num →
    roman is followed from wherever it starts. Unenumerated paragraphs
    continue the previous path as "(b)(2)+1", "+2" …; a section's leading
    text is "intro"."""

    def __init__(self):
        self.stack = []        # [(token, kind)] one per level
        self.cont = 0
        self.seen_enum = False

    def path(self):
        return "".join(f"({t})" for t, _ in self.stack)

    def set_path(self, tokens):
        """Place the stack on an absolute path such as ["b", "1"]: kinds
        follow the CFR order from the first token's kind."""
        kind = _guess_kind(tokens[0])
        self.stack = []
        for t in tokens:
            self.stack.append((t, kind if kind in _kinds(t) else _guess_kind(t)))
            kind = NEXT_KIND[self.stack[-1][1]]
        self.seen_enum = True
        self.cont = 0
        return self.path()

    def next(self, leaders):
        if not leaders:
            if not self.seen_enum:
                return "intro"
            self.cont += 1
            return f"{self.path()}+{self.cont}"
        self.seen_enum = True
        self.cont = 0
        if len(leaders) > 1:
            return self.set_path(leaders)        # an absolute path like (b)(2)(i)
        t = leaders[0]
        kinds = _kinds(t)
        # a sibling of the current level?
        if self.stack:
            top, kind = self.stack[-1]
            if kind in kinds and _successor(top, kind) == t:
                self.stack[-1] = (t, kind)
                return self.path()
        # the first value of the next level?
        kind = NEXT_KIND[self.stack[-1][1]] if self.stack else "alpha"
        if kind in kinds and FIRST[kind] == t:
            self.stack.append((t, kind))
            return self.path()
        if not self.stack and FIRST.get(_guess_kind(t)) == t:
            self.stack.append((t, _guess_kind(t)))
            return self.path()
        # a sibling further up?
        for depth in range(len(self.stack) - 2, -1, -1):
            top, kind = self.stack[depth]
            if kind in kinds and _successor(top, kind) == t:
                self.stack = self.stack[:depth] + [(t, kind)]
                return self.path()
        # out of sequence (a gap, or a document that starts mid-section):
        # the deepest level of a matching kind, else a level of its own
        for depth in range(len(self.stack) - 1, -1, -1):
            kind = self.stack[depth][1]
            if kind in kinds:
                self.stack = self.stack[:depth] + [(t, kind)]
                return self.path()
        self.stack = [(t, _guess_kind(t))]
        return self.path()


def leaders_of(text):
    m = LEADERS_RE.match(text or "")
    return re.findall(r"\(([a-zA-Z0-9]{1,4})\)", m.group(1)) if m else []


def block_paths(blocks):
    """Paths for a corpus section's blocks (the twin of the proposal's)."""
    r = PathResolver()
    out = []
    for b in blocks:
        if b.get("type") == "table":
            out.append(r.next([]))
        else:
            out.append(r.next(leaders_of(b.get("text", ""))))
    return out


def parse(extracted: dict) -> dict:
    sections, parts = [], []
    cur, resolver = None, None
    part, subpart = None, None
    front = 0

    used_paths = set()

    def start(identifier, heading, heading_before, removed=False):
        nonlocal cur, resolver
        used_paths.clear()
        p = identifier.split(".")[0]
        if p not in parts:
            parts.append(p)
        cur = {"identifier": identifier, "part": p, "subpart": subpart, "heading": heading,
               "heading_before": heading_before, "removed": removed, "instructions": [], "paragraphs": []}
        resolver = PathResolver()
        sections.append(cur)

    for p in extracted["paragraphs"]:
        after, before = paragraph_text(p, "after"), paragraph_text(p, "before")
        full = re.sub(r"\s+", " ", "".join(t for t, _ in p["runs"])).strip()
        m = PART_RE.match(full)
        if m and p["kind"] == "p" and len(full) < 160:
            part = m.group(1)
            continue
        m = SUBPART_RE.match(full)
        if m and p["kind"] == "p" and len(full) < 200 and "—" in full:
            subpart = m.group(1)
            continue
        m = SECTION_RE.match(after) or SECTION_RE.match(before) or SECTION_RE.match(full)
        if m and p["kind"] == "p" and len(full) < 400:
            ident = m.group(1)
            tag = m.group(2) or ""
            # the heading on each side of the redline: a wholly inserted
            # heading has no "before", a wholly struck one no "after"
            heading = SECTION_RE.match(after).group(3).strip() if SECTION_RE.match(after) else ""
            hb = SECTION_RE.match(before).group(3).strip() if SECTION_RE.match(before) else ""
            if not after.strip():
                heading = ""
            if not before.strip():
                hb = ""
            if cur and cur["identifier"] == ident and not cur["paragraphs"]:
                cur["heading"], cur["heading_before"] = heading or cur["heading"], hb or cur["heading_before"]
            else:
                start(ident, heading, hb, removed=bool(REMOVED_RE.search(tag)))
            continue
        m = AMEND_RE.match(full) or AMEND2_RE.match(full)
        if m and p["kind"] == "p" and len(full) < 400:
            ident = m.group(1)
            if not (cur and cur["identifier"] == ident):
                start(ident, "", "")
            if re.search(r"\b(removed|remove)\b", full, re.I) and not re.search(r"paragraph", full, re.I):
                cur["removed"] = True
            continue
        if cur is None:
            front += 1
            continue
        m = INSTR_RE.match(full)
        if m and p["kind"] == "p" and len(full) < 400:
            verb = m.group(1).lower()
            verb = {"revis": "revise", "add": "add", "remov": "remove", "reserv": "reserve", "redesignat": "redesignate"}[
                next(k for k in ("revis", "add", "remov", "reserv", "redesignat") if verb.startswith(k))]
            paths = ["".join(f"({t})" for t in re.findall(r"\(([a-zA-Z0-9]{1,4})\)", g)) for g in PATHS_RE.findall(m.group(2))]
            target = "heading" if re.search(r"\bheading\b", m.group(2), re.I) and not paths else "paragraph"
            cur["instructions"].append({"verb": verb, "paths": paths, "target": target})
            continue
        leaders = leaders_of(after) or leaders_of(before)
        # A redline shows only the paragraphs that change, so "(1)" may
        # arrive with no "(b)" above it. The amendatory instruction names
        # the full path ("Revising paragraph (b)(1)"): when one instruction
        # path ends in this paragraph's enumerator and has not been used,
        # that is where it belongs.
        path = None
        if len(leaders) == 1:
            want = f"({leaders[0]})"
            for instr in cur["instructions"]:
                for ipath in instr["paths"]:
                    if ipath.endswith(want) and ipath not in used_paths and ipath != resolver.path():
                        if ipath.count("(") > 1:
                            path = resolver.set_path(re.findall(r"\(([a-zA-Z0-9]{1,4})\)", ipath))
                        used_paths.add(ipath)
                        break
                if path:
                    break
        if path is None:
            path = resolver.next(leaders)
            used_paths.add(path)
        cur["paragraphs"].append({"path": path, "before": before, "after": after,
                                  "kind": "table" if p["kind"] == "table" else "p"})

    return {"sections": sections, "parts": parts, "front_matter": front,
            "subparts": sorted({s["subpart"] for s in sections if s["subpart"]})}
