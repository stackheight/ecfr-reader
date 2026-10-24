"""The reader's API: the local corpus (status, table of contents, a unit of
sections, search, the notify-only update check), live text from ecfr.gov
(a section or a subpart), and your notes / highlights / favorites.
"""
import re          # search tokenizer (ecfr_search)
import sqlite3     # FTS5 OperationalError handling (ecfr_search)

from flask import Blueprint, jsonify, request


bp = Blueprint("ecfr", __name__)

IMPORT_HINT = "python -m ecfr_reader fetch, then python -m ecfr_reader import"


def _ecfr_unavailable():
    return jsonify({"error": f"eCFR corpus not imported yet. Run: {IMPORT_HINT}"}), 503


@bp.route("/api/ecfr/status", methods=["GET"])
def ecfr_status():
    import json
    from .corpus.store import corpus_exists, read_meta, part_count as _part_count

    if not corpus_exists():
        return jsonify({"present": False})
    meta = read_meta()
    part_count = _part_count()
    return jsonify({
        "present": True,
        "snapshot_date": meta.get("snapshot_date"),
        "parts": meta.get("parts"),
        "imported_at": meta.get("imported_at"),
        "section_count": int(meta.get("section_count") or 0),
        "part_count": part_count,
        "last_check_at": meta.get("last_check_at"),
        "last_check": json.loads(meta["last_check_json"]) if meta.get("last_check_json") else None,
    })


@bp.route("/api/ecfr/toc", methods=["GET"])
def ecfr_toc():
    from .corpus.store import corpus_exists, list_parts

    if not corpus_exists():
        return _ecfr_unavailable()
    return jsonify({"parts": list_parts()})


@bp.route("/api/ecfr/toc/<part>", methods=["GET"])
def ecfr_toc_part(part):
    from .corpus.store import corpus_exists, get_part, list_subparts, list_part_sections

    if not corpus_exists():
        return _ecfr_unavailable()
    part_row = get_part(part)
    if not part_row:
        return jsonify({"error": f"Part {part} not found"}), 404
    return jsonify({"part": part_row, "subparts": list_subparts(part),
                    "sections": list_part_sections(part)})


@bp.route("/api/ecfr/updates", methods=["GET"])
def ecfr_updates():
    import json
    from datetime import datetime, timezone
    from .corpus.store import corpus_exists, read_meta, write_meta
    from .corpus.updates import check_updates, EcfrApiError

    if not corpus_exists():
        return _ecfr_unavailable()
    force = request.args.get("force") == "1"

    meta = read_meta()
    snapshot_date = meta.get("snapshot_date")
    parts_spec = meta.get("parts", "50-99")
    last_check_at = meta.get("last_check_at")
    last_check_json = meta.get("last_check_json")

    cache_fresh = False
    if last_check_at:
        try:
            age = datetime.now(timezone.utc) - datetime.fromisoformat(last_check_at)
            cache_fresh = age.total_seconds() < 24 * 3600
        except ValueError:
            cache_fresh = False

    if not force and cache_fresh and last_check_json:
        result = json.loads(last_check_json)
        result["cached"] = True
        result["stale"] = False
        return jsonify(result)

    try:
        result = check_updates(snapshot_date, parts_spec)
    except EcfrApiError as e:
        if last_check_json:
            cached = json.loads(last_check_json)
            cached["cached"] = True
            cached["stale"] = True
            return jsonify(cached)
        return jsonify({"error": str(e)}), 502

    result["checked_at"] = datetime.now(timezone.utc).isoformat()
    result["cached"] = False
    result["stale"] = False
    write_meta(last_check_at=result["checked_at"], last_check_json=json.dumps(result))
    return jsonify(result)


@bp.route("/api/ecfr/section", methods=["GET"])
def ecfr_section():
    import json
    from .corpus.store import corpus_exists, get_section

    if not corpus_exists():
        return _ecfr_unavailable()
    key = request.args.get("key", "")
    if not key:
        return jsonify({"error": "key is required"}), 400
    result = get_section(key)
    if not result:
        return jsonify({"error": f"Section {key!r} not found"}), 404
    result["blocks"] = json.loads(result.pop("blocks_json"))
    return jsonify(result)


@bp.route("/api/ecfr/section/live", methods=["GET"])
def ecfr_section_live():
    from bs4 import BeautifulSoup
    from .corpus.render import render_standalone
    from .corpus.store import corpus_exists, get_section_locator
    from .corpus.updates import EcfrApiError, fetch_full_xml, latest_title_date

    if not corpus_exists():
        return _ecfr_unavailable()
    key = request.args.get("key", "")
    if not key:
        return jsonify({"error": "key is required"}), 400
    row = get_section_locator(key)
    if not row:
        return jsonify({"error": f"Section {key!r} not found"}), 404

    try:
        as_of = latest_title_date()
        xml = fetch_full_xml(as_of, row["part"], row["identifier"],
                             is_appendix=(row["type"] == "appendix"))
        rendered = render_standalone(BeautifulSoup(xml, "lxml-xml"))
        if rendered is None:
            raise EcfrApiError("ecfr.gov returned no section content.")
    except EcfrApiError as e:
        return jsonify({"error": str(e)}), 502

    rendered["section_key"] = key
    rendered["part"] = row["part"]
    rendered["as_of"] = as_of
    return jsonify(rendered)


@bp.route("/api/ecfr/section/versions", methods=["GET"])
def ecfr_section_versions():
    """The dates ecfr.gov amended this section — the reader's timeline.
    Cached 24 h (a section can be amended tomorrow); ?force=1 refetches."""
    from .corpus.store import cache_get, cache_put, corpus_exists, get_section_locator, read_meta
    from .corpus.updates import EcfrApiError, section_versions

    if not corpus_exists():
        return _ecfr_unavailable()
    key = request.args.get("key", "")
    if not key:
        return jsonify({"error": "key is required"}), 400
    row = get_section_locator(key)
    if not row:
        return jsonify({"error": f"Section {key!r} not found"}), 404
    force = request.args.get("force") == "1"
    cache_key = f"versions:{key}"
    result = None if force else cache_get(cache_key, max_age_s=24 * 3600)
    cached = result is not None
    if result is None:
        try:
            result = section_versions(row["part"], row["identifier"], is_appendix=(row["type"] == "appendix"))
        except EcfrApiError as e:
            return jsonify({"error": str(e)}), 502
        cache_put(cache_key, result)
    return jsonify({"section_key": key, "versions": result["versions"], "latest": result.get("latest"),
                    "local_snapshot_date": read_meta().get("snapshot_date"), "cached": cached})


def _past_date(raw):
    """Validate a ?date= for the point-in-time routes: (date, None) for a real
    YYYY-MM-DD not after today, else (None, a 400 response)."""
    import re
    from datetime import date
    when = (raw or "").strip()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", when):
        return None, (jsonify({"error": "date must be YYYY-MM-DD"}), 400)
    try:
        if date.fromisoformat(when) > date.today():
            return None, (jsonify({"error": "date is in the future"}), 400)
    except ValueError:
        return None, (jsonify({"error": "date must be a real calendar date"}), 400)
    return when, None


@bp.route("/api/ecfr/section/at", methods=["GET"])
def ecfr_section_at():
    """One section as it stood on a date — the /section/live payload shape
    with as_of = that date. Cached for ever: a past version never changes."""
    from bs4 import BeautifulSoup
    from .corpus.render import render_standalone
    from .corpus.store import cache_get, cache_put, corpus_exists, get_section_locator
    from .corpus.updates import EcfrApiError, fetch_full_xml

    if not corpus_exists():
        return _ecfr_unavailable()
    key = request.args.get("key", "")
    if not key:
        return jsonify({"error": "key is required"}), 400
    when, bad = _past_date(request.args.get("date"))
    if bad:
        return bad
    row = get_section_locator(key)
    if not row:
        return jsonify({"error": f"Section {key!r} not found"}), 404
    cache_key = f"at:{key}:{when}"
    rendered = cache_get(cache_key)
    if rendered is None:
        try:
            xml = fetch_full_xml(when, row["part"], row["identifier"], is_appendix=(row["type"] == "appendix"))
            rendered = render_standalone(BeautifulSoup(xml, "lxml-xml"))
            if rendered is None:
                raise EcfrApiError(f"ecfr.gov returned no content for {key} as of {when}.")
        except EcfrApiError as e:
            return jsonify({"error": str(e)}), 502
        rendered["section_key"] = key
        rendered["part"] = row["part"]
        rendered["as_of"] = when
        cache_put(cache_key, rendered)
    return jsonify(rendered)


# Widest to narrowest. The reader's panel narrows automatically as you walk
# down the tree, so the order matters to the UI as well as to the buckets.
ECFR_SCOPES = ("title", "part", "subpart", "section")


def _ecfr_section_meta(keys):
    """section_key -> {part, subpart, citation, heading} from the corpus.

    Annotations reference sections by key; everything else about a section
    lives in ecfr.db. Missing keys (corpus not imported, or a section that
    disappeared in a re-import) simply don't appear in the result — callers
    fall back to what the key itself encodes."""
    from .corpus.store import corpus_exists, sections_meta

    if not corpus_exists():
        return {}
    return sections_meta(keys)


@bp.route("/api/ecfr/annotations", methods=["GET"])
def ecfr_annotations():
    """Notes + highlights for one scope, plus the count at every scope so the
    panel's filter can show them without four more round trips.

    `key` fixes the point in the tree everything is measured against; it's
    required for every scope except `title` (the reader with no section open
    still wants to list everything you've marked)."""
    from .annotations import all_annotations, favorite_id as _favorite_id

    key = request.args.get("key", "")
    scope = request.args.get("scope", "section")
    if scope not in ECFR_SCOPES:
        return jsonify({"error": f"scope must be one of {', '.join(ECFR_SCOPES)}"}), 400
    if scope != "title" and not key:
        return jsonify({"error": "key is required unless scope=title"}), 400

    data = all_annotations()
    referenced = {r["section_key"] for r in data["notes"] + data["highlights"]}
    meta = _ecfr_section_meta(referenced | ({key} if key else set()))

    current = meta.get(key, {})
    # A key is "<part>:<identifier>", so the part survives even when the
    # corpus has no row for it; the subpart genuinely needs the corpus.
    current_part = current.get("part") or (key.split(":")[0] if key else None)
    current_subpart = current.get("subpart")

    def scopes_containing(row):
        """Which scopes this row falls inside, relative to `key`."""
        row_meta = meta.get(row["section_key"], {})
        row_part = row_meta.get("part") or row["section_key"].split(":")[0]
        found = {"title"}
        if current_part and row_part == current_part:
            found.add("part")
            if current_subpart and row_meta.get("subpart") == current_subpart:
                found.add("subpart")
        if key and row["section_key"] == key:
            found.add("section")
        return found

    counts = {s: {"notes": 0, "highlights": 0} for s in ECFR_SCOPES}
    for kind in ("notes", "highlights"):
        for row in data[kind]:
            for s in scopes_containing(row):
                counts[s][kind] += 1

    def enrich(row):
        # Named section_* so a note's own stored `citation` isn't clobbered.
        row_meta = meta.get(row["section_key"], {})
        row["section_citation"] = row_meta.get("citation") or row["section_key"]
        row["section_heading"] = row_meta.get("heading") or ""
        # Where the row LIVES, not where you happen to be standing. The lookup
        # already had these and threw them away, which is why the panel could
        # only ever answer "what's in the part I'm in" — never "which part is
        # my note in". Grouping happens client-side; these are what it needs.
        row["part"] = row_meta.get("part") or row["section_key"].split(":")[0]
        row["subpart"] = row_meta.get("subpart")
        return row

    result = {kind: [enrich(r) for r in data[kind] if scope in scopes_containing(r)]
              for kind in ("notes", "highlights")}
    favorite_id = _favorite_id(key) if key else None
    result.update({
        "scope": scope, "counts": counts,
        "part": current_part, "subpart": current_subpart,
        "favorited": favorite_id is not None, "favorite_id": favorite_id,
    })
    return jsonify(result)


@bp.route("/api/ecfr/notes", methods=["POST"])
def create_ecfr_note():
    from .annotations import add_note

    data = request.json or {}
    section_key = (data.get("section_key") or "").strip()
    note = (data.get("note") or "").strip()
    if not section_key:
        return jsonify({"error": "section_key is required"}), 400
    if not note:
        return jsonify({"error": "note text is required"}), 400
    return jsonify(add_note(section_key, data.get("citation", ""), note)), 201


@bp.route("/api/ecfr/notes/<int:note_id>", methods=["PATCH"])
def update_ecfr_note_route(note_id):
    from .annotations import update_note

    note = ((request.json or {}).get("note") or "").strip()
    if not note:
        return jsonify({"error": "note text is required"}), 400
    if not update_note(note_id, note):
        return jsonify({"error": "Note not found"}), 404
    return jsonify({"status": "updated"})


@bp.route("/api/ecfr/notes/<int:note_id>", methods=["DELETE"])
def delete_ecfr_note_route(note_id):
    from .annotations import delete_note

    if not delete_note(note_id):
        return jsonify({"error": "Note not found"}), 404
    return jsonify({"status": "deleted"})


# Highlight appearance vocabulary — shared by POST and PATCH. Kept in sync
# with the palette/tool set in static/js/ecfr-annotator.js.
ECFR_HL_COLORS = ("yellow", "green", "pink", "blue")
ECFR_HL_KINDS = ("highlight", "underline", "strike")


def _ecfr_highlight_appearance(data, fields):
    """Validate the colour/kind/comment/anchor fields shared by POST and
    PATCH, writing the ones present into `fields`. Returns an error string,
    or None when everything checks out."""
    if "color" in data:
        if data["color"] not in ECFR_HL_COLORS:
            return f"color must be one of {', '.join(ECFR_HL_COLORS)}"
        fields["color"] = data["color"]
    if "kind" in data:
        if data["kind"] not in ECFR_HL_KINDS:
            return f"kind must be one of {', '.join(ECFR_HL_KINDS)}"
        fields["kind"] = data["kind"]
    if "comment" in data:
        # "" clears the comment; the column stays NULL rather than empty.
        comment = (data.get("comment") or "").strip()
        fields["comment"] = comment or None
    if "start_pos" in data or "end_pos" in data:
        try:
            start_pos = int(data["start_pos"])
            end_pos = int(data["end_pos"])
        except (KeyError, TypeError, ValueError):
            return "start_pos and end_pos must both be integers"
        if start_pos < 0 or end_pos <= start_pos:
            return "Invalid highlight range (need 0 <= start_pos < end_pos)"
        fields["start_pos"] = start_pos
        fields["end_pos"] = end_pos
    for key in ("prefix", "suffix"):
        if key in data:
            fields[key] = data.get(key) or ""
    if "snapshot_date" in data:
        fields["snapshot_date"] = data.get("snapshot_date") or ""
    return None


@bp.route("/api/ecfr/highlights", methods=["POST"])
def create_ecfr_highlight():
    from .annotations import add_highlight

    data = request.json or {}
    section_key = (data.get("section_key") or "").strip()
    quote = data.get("quote") or ""
    if not section_key:
        return jsonify({"error": "section_key is required"}), 400
    if not quote.strip():
        return jsonify({"error": "quote is required"}), 400

    fields = {}
    error = _ecfr_highlight_appearance(data, fields)
    if error:
        return jsonify({"error": error}), 400

    if "start_pos" not in fields:
        return jsonify({"error": "start_pos and end_pos are required"}), 400
    # snapshot_date is a positional parameter, so take it back out of the
    # kwargs the shared validator collected it into.
    snapshot_date = fields.pop("snapshot_date", "")
    return jsonify(add_highlight(section_key, quote, snapshot_date, **fields)), 201


@bp.route("/api/ecfr/highlights/<int:highlight_id>", methods=["PATCH"])
def update_ecfr_highlight_route(highlight_id):
    """Recolour / change kind / attach a comment / re-anchor one highlight.
    Every field is optional; only what's present is written."""
    from .annotations import update_highlight

    data = request.json or {}
    fields = {}
    error = _ecfr_highlight_appearance(data, fields)
    if error:
        return jsonify({"error": error}), 400
    if "quote" in data:
        quote = data.get("quote") or ""
        if not quote.strip():
            return jsonify({"error": "quote can't be empty"}), 400
        fields["quote"] = quote
    if not fields:
        return jsonify({"error": "No updatable fields supplied"}), 400

    highlight = update_highlight(highlight_id, fields)
    if highlight is None:
        return jsonify({"error": "Highlight not found"}), 404
    return jsonify(highlight)


@bp.route("/api/ecfr/highlights/<int:highlight_id>", methods=["DELETE"])
def delete_ecfr_highlight_route(highlight_id):
    from .annotations import delete_highlight

    if not delete_highlight(highlight_id):
        return jsonify({"error": "Highlight not found"}), 404
    return jsonify({"status": "deleted"})


@bp.route("/api/ecfr/unit/live", methods=["GET"])
def ecfr_unit_live():
    """A whole unit's LIVE text from ecfr.gov, in one request.

    The live twin of /api/ecfr/unit. The reader shows a subpart at a time, so
    fetching live text a section at a time meant ~23 requests for one screen —
    which ecfr.gov answered with HTTP 429, and fairly. The versioner's /full
    endpoint takes `subpart` directly, so one request (~130 KB, <1s) returns
    the same sections.

    Only subparts can be fetched this way. An appendix is one section, and a
    part's loose sections aren't a division ecfr.gov knows about — both fall
    back to /api/ecfr/section/live, which is one request either way.
    """
    from bs4 import BeautifulSoup
    from .corpus.render import render_unit
    from .corpus.store import corpus_exists, subpart_exists
    from .corpus.updates import EcfrApiError, fetch_subpart_xml, latest_title_date

    if not corpus_exists():
        return _ecfr_unavailable()
    part = (request.args.get("part") or "").strip()
    subpart = (request.args.get("subpart") or "").strip()
    if not part or not subpart:
        return jsonify({"error": "part and subpart are required"}), 400

    if not subpart_exists(part, subpart):
        return jsonify({"error": f"Part {part} subpart {subpart} not found"}), 404

    try:
        as_of = latest_title_date()
        xml = fetch_subpart_xml(as_of, part, subpart)
        rendered = render_unit(BeautifulSoup(xml, "lxml-xml"), part)
        if rendered is None or not rendered["sections"]:
            raise EcfrApiError("ecfr.gov returned no content for that subpart.")
    except EcfrApiError as e:
        return jsonify({"error": str(e)}), 502

    for s in rendered["sections"]:
        s["as_of"] = as_of
    rendered["as_of"] = as_of
    rendered["part"] = part
    return jsonify(rendered)


@bp.route("/api/ecfr/unit/versions", methods=["GET"])
def ecfr_unit_versions():
    """The dates ecfr.gov amended any section of a subpart — the timeline
    for a subpart opened whole, and the Compare tab's version list in that
    mode. One request upstream (the versions endpoint filters by subpart),
    cached 24 h like the per-section route; ?force=1 refetches."""
    from .corpus.store import cache_get, cache_put, corpus_exists, read_meta, subpart_exists
    from .corpus.updates import EcfrApiError, subpart_versions

    if not corpus_exists():
        return _ecfr_unavailable()
    part = (request.args.get("part") or "").strip()
    subpart = (request.args.get("subpart") or "").strip()
    if not part or not subpart:
        return jsonify({"error": "part and subpart are required"}), 400
    if not subpart_exists(part, subpart):
        return jsonify({"error": f"Part {part} subpart {subpart} not found"}), 404
    force = request.args.get("force") == "1"
    cache_key = f"versions:unit:{part}/{subpart}"
    result = None if force else cache_get(cache_key, max_age_s=24 * 3600)
    cached = result is not None
    if result is None:
        try:
            result = subpart_versions(part, subpart)
        except EcfrApiError as e:
            return jsonify({"error": str(e)}), 502
        cache_put(cache_key, result)
    return jsonify({"part": part, "subpart": subpart, "versions": result["versions"],
                    "latest": result.get("latest"), "local_snapshot_date": read_meta().get("snapshot_date"),
                    "cached": cached})


@bp.route("/api/ecfr/unit/at", methods=["GET"])
def ecfr_unit_at():
    """A whole subpart as it stood on a date: the /unit/live payload shape
    with as_of = that date. One request upstream, cached for ever — a past
    version never changes. Subparts only, for the reason /unit/live gives."""
    from bs4 import BeautifulSoup
    from .corpus.render import render_unit
    from .corpus.store import cache_get, cache_put, corpus_exists, subpart_exists
    from .corpus.updates import EcfrApiError, fetch_subpart_xml

    if not corpus_exists():
        return _ecfr_unavailable()
    part = (request.args.get("part") or "").strip()
    subpart = (request.args.get("subpart") or "").strip()
    if not part or not subpart:
        return jsonify({"error": "part and subpart are required"}), 400
    when, bad = _past_date(request.args.get("date"))
    if bad:
        return bad
    if not subpart_exists(part, subpart):
        return jsonify({"error": f"Part {part} subpart {subpart} not found"}), 404

    cache_key = f"at:unit:{part}/{subpart}:{when}"
    rendered = cache_get(cache_key)
    if rendered is None:
        try:
            xml = fetch_subpart_xml(when, part, subpart)
            rendered = render_unit(BeautifulSoup(xml, "lxml-xml"), part)
            if rendered is None or not rendered["sections"]:
                raise EcfrApiError(f"ecfr.gov returned no content for part {part} subpart {subpart} as of {when}.")
        except EcfrApiError as e:
            return jsonify({"error": str(e)}), 502
        for s in rendered["sections"]:
            s["as_of"] = when
        rendered["as_of"] = when
        rendered["part"] = part
        cache_put(cache_key, rendered)
    return jsonify(rendered)


@bp.route("/api/ecfr/unit", methods=["GET"])
def ecfr_unit():
    """Every section of one top-level division of a part, WITH its blocks.

    The reader's unit of work. Reading one section at a time made "what does
    this subpart actually say" a thirty-click job; a unit is the answer to
    that question, scrolled.

    Three shapes, because a part has three kinds of top-level division:
      ?part=60&subpart=JJJJ            a subpart
      ?part=60&appendix=Appendix%20B…  ONE appendix (they are siblings of
                                       subparts, not strays inside them)
      ?part=51                         the part's loose sections — the ones
                                       with neither (parts 50/51 mostly)

    Deliberately not paged. Measured over the corpus, a unit is a median 10
    sections / 37 KB, p90 33 / 241 KB. The whole of Title 40 would be 10,812
    sections / 73 MB and needs virtualisation; a unit does not. The frontend
    still fills blocks lazily as sections near the viewport, which covers the
    handful of outliers (part 52 subpart F is 57 sections / 8,894 blocks).
    """
    import json
    from .corpus.store import corpus_exists, unit_sections

    if not corpus_exists():
        return _ecfr_unavailable()
    part = (request.args.get("part") or "").strip()
    subpart = (request.args.get("subpart") or "").strip()
    appendix = (request.args.get("appendix") or "").strip()
    if not part:
        return jsonify({"error": "part is required"}), 400
    if subpart and appendix:
        return jsonify({"error": "pass subpart or appendix, not both"}), 400

    # store.unit_sections keeps the three shapes apart: an appendix with no
    # subpart is its own unit — that lumping is what made part 60 look like
    # a single 3.36 MB division.
    part_row, rows, heading = unit_sections(part, subpart or None, appendix or None)
    if not part_row:
        return jsonify({"error": f"Part {part} not found"}), 404

    if not rows:
        return jsonify({"error": "No sections found for that unit"}), 404
    for r in rows:
        r["blocks"] = json.loads(r.pop("blocks_json"))

    return jsonify({
        "part": dict(part_row),
        "subpart": subpart or None,
        "appendix": appendix or None,
        "heading": heading or (rows[0]["heading"] if appendix else None),
        "sections": rows,
    })


@bp.route("/api/ecfr/search", methods=["GET"])
def ecfr_search():
    """Full-text search across the local corpus.

    The query is rebuilt from scratch rather than escaped. FTS5's MATCH
    syntax is a language: punctuation operators (* " : parens) make a stray
    quote a syntax error, and `body:x` is a working query nobody meant to
    write.

    Pulling out [A-Za-z0-9]+ handles the punctuation — but NOT the whole
    problem, and it's worth being precise about why. AND, OR, NOT and NEAR
    are bare alphanumeric words, so they survive that filter untouched and
    arrive at FTS5 as live operators: searching for "spark AND NOT ignition"
    is a 500, and there is nothing unreasonable about typing it.

    So each token is then wrapped in double quotes, making it a literal
    phrase. "AND" is just the word and. Tokens are [A-Za-z0-9]+ by
    construction and so can never contain a quote to break back out with.
    Result: any input at all is a valid query.
    """
    from .corpus.store import corpus_exists, search as corpus_search

    if not corpus_exists():
        return _ecfr_unavailable()

    raw = request.args.get("q") or ""
    tokens = re.findall(r"[A-Za-z0-9]+", raw)[:12]       # 12 is plenty; bounds the query
    if not tokens:
        return jsonify({"query": raw, "total": 0, "results": [], "offset": 0})
    # Quoted phrases: neutralises the bareword operators the token filter
    # above cannot. Adjacent phrases are an implicit AND, which is what a
    # search box is expected to do anyway.
    match = " ".join(f'"{t}"' for t in tokens)

    part = (request.args.get("part") or "").strip()
    try:
        limit = max(1, min(int(request.args.get("limit", 25)), 100))
        offset = max(0, int(request.args.get("offset", 0)))
    except ValueError:
        return jsonify({"error": "limit and offset must be integers"}), 400

    try:
        total, rows = corpus_search(match, part, limit, offset)
    except sqlite3.OperationalError as err:
        # The FTS table only exists in a corpus imported since round 3.
        if "no such table" in str(err):
            return jsonify({"error": "The search index is missing from this corpus. "
                                     f"Re-run: {IMPORT_HINT}"}), 503
        raise

    return jsonify({"query": raw, "match": match, "total": total,
                    "offset": offset, "limit": limit, "results": rows})


@bp.route("/api/ecfr/favorites", methods=["GET"])
def list_ecfr_favorites():
    from .annotations import favorites
    return jsonify(favorites())


@bp.route("/api/ecfr/favorites", methods=["POST"])
def toggle_ecfr_favorite_route():
    from .annotations import NODE_TYPES, toggle_favorite

    data = request.json or {}
    node_type = (data.get("node_type") or "").strip()
    node_key = (data.get("node_key") or "").strip()
    if node_type not in NODE_TYPES:
        return jsonify({"error": f"node_type must be one of {', '.join(NODE_TYPES)}"}), 400
    if not node_key:
        return jsonify({"error": "node_key is required"}), 400
    return jsonify(toggle_favorite(node_type, node_key, data.get("citation", ""), data.get("label", "")))

