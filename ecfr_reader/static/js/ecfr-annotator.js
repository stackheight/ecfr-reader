// =====================================================================
// eCFR reader — annotation engine (round 2).
//
// Wraps @recogito/text-annotator (vendored UMD build, global RecogitoJS)
// and keeps it in sync with the highlights table. Loaded after app.js
// and before ecfr.js; ecfr.js calls ecfrAttachAnnotator() after it paints
// the reading frames.
//
// Two things are worth knowing before changing anything here:
//
//  1. ANCHORING. A highlight is stored twice over: character offsets into
//     the frame's text (start_pos/end_pos, the library's TextPositionSelector)
//     and the quoted text itself plus ~30 chars either side (quote/prefix/
//     suffix, its TextQuoteSelector). The library revives ranges from the
//     OFFSETS ALONE — it never checks the quote — so if the corpus text
//     shifts under a saved highlight it would silently paint the wrong
//     words. Everything the library is handed therefore goes through
//     ecfrRescueRow() first, which re-anchors by quote and repairs the row.
//     Offsets index the whole frame container, table-template whitespace
//     included, so treat ecfrRenderBlock()'s markup as frozen.
//
//  2. THE DB IS THE SOURCE OF TRUTH. Annotation ids are the library's own
//     (a nanoid, or "db-<id>" for rows we loaded); they are NOT database
//     ids, and the mapping changes across an undo/redo cycle. Always
//     resolve through ecfrAnnoMeta[annotationId].dbId — never parse an id.
// =====================================================================

const ECFR_HL_PALETTE = {
    yellow: "#facc15", green: "#4ade80", pink: "#f472b6", blue: "#60a5fa",
};
const ECFR_HL_DEFAULT_COLOR = "yellow";
const ECFR_HL_DEFAULT_KIND = "highlight";

// One RecogitoJS instance per (FRAME, SECTION), keyed "frameIndex:section_key":
//   "0:60:60.4230" -> {ann, key, frame, persists, container}
//
// There is no "the" annotator, because there is no one annotatable thing: a
// frame holds a whole unit, several sections of it are on screen at once, and
// each has its own container.
//
// Per SECTION is not a style choice — it's the safety property this whole
// design rests on. start_pos/end_pos are character offsets into ONE section's
// .ecfr-blocks text. One instance spanning a merged container would measure
// offsets against the whole unit, and every saved row would then "rescue"
// itself (ecfrLocateQuote) onto plausible but WRONG words, which
// ecfrPersistAnchor would PATCH back into the database. Silently, and
// unrecoverably. One container per section keeps the offset space exactly
// what's already stored: no migration, nothing to get wrong.
let ecfrAnnotators = new Map();

function ecfrAnnKey(frameIndex, sectionKey) {
    return `${frameIndex}:${sectionKey}`;
}
// The frame undo/redo act on: the one you last marked. With several
// annotatable frames, "undo" has to mean something specific.
let ecfrActiveFrame = null;
let ecfrAnnoMeta = {};           // annotation id -> {dbId, color, kind, comment}
let ecfrAttachToken = 0;         // guards against a slow attach clobbering a newer one

// The armed tool. Persists across sections (a PDF editor doesn't forget
// you picked the green highlighter when you turn the page). Stage 5's
// toolbar drives it; until then everything runs in "select".
let ecfrTool = { mode: "select", color: ECFR_HL_DEFAULT_COLOR };

// --- Text/offset helpers --------------------------------------------

// Mirror the library's own text walk exactly: same node order, same
// skipped subtrees. If these two ever disagree, every offset is wrong.
function ecfrTextWalker(container) {
    const skipSelector = (window.RecogitoJS && RecogitoJS.NOT_ANNOTATABLE_SELECTOR) || ".not-annotatable";
    return document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement && node.parentElement.closest(skipSelector))
            ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT,
    });
}

function ecfrContainerText(container) {
    const walker = ecfrTextWalker(container);
    let text = "", node;
    while ((node = walker.nextNode())) text += node.nodeValue;
    return text;
}

// Character offset at which `el`'s text begins within `container`.
function ecfrBlockBaseOffset(container, el) {
    const walker = ecfrTextWalker(container);
    let pos = 0, node;
    while ((node = walker.nextNode())) {
        if (el.contains(node)) return pos;
        pos += node.nodeValue.length;
    }
    return -1;
}

function ecfrAllIndexesOf(haystack, needle) {
    const hits = [];
    if (!needle) return hits;
    let i = haystack.indexOf(needle);
    while (i !== -1) { hits.push(i); i = haystack.indexOf(needle, i + 1); }
    return hits;
}

// Find `quote` in `text`, using prefix/suffix to break ties. Returns
// {start, end} or null when it's missing or still ambiguous (which is what
// makes a highlight an orphan rather than a guess).
function ecfrLocateQuote(text, quote, prefix, suffix) {
    const hits = ecfrAllIndexesOf(text, quote);
    if (!hits.length) return null;
    if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };

    let candidates = hits;
    if (prefix) {
        const narrowed = candidates.filter(h =>
            text.slice(Math.max(0, h - prefix.length), h).endsWith(prefix));
        if (narrowed.length) candidates = narrowed;
    }
    if (suffix && candidates.length > 1) {
        const narrowed = candidates.filter(h =>
            text.slice(h + quote.length, h + quote.length + suffix.length).startsWith(suffix));
        if (narrowed.length) candidates = narrowed;
    }
    return candidates.length === 1
        ? { start: candidates[0], end: candidates[0] + quote.length }
        : null;
}

function ecfrContextAround(text, start, end) {
    return {
        prefix: text.slice(Math.max(0, start - 30), start),
        suffix: text.slice(end, end + 30),
    };
}

// --- Row <-> library mapping ----------------------------------------

function ecfrRowToW3C(row) {
    return {
        "@context": "http://www.w3.org/ns/anno.jsonld",
        id: `db-${row.id}`,
        type: "Annotation",
        body: [],
        target: {
            source: `ecfr:${row.section_key}`,
            selector: [
                { type: "TextQuoteSelector", exact: row.quote,
                  prefix: row.prefix || "", suffix: row.suffix || "" },
                { type: "TextPositionSelector", start: row.start_pos, end: row.end_pos },
            ],
        },
    };
}

function ecfrMetaFromRow(row) {
    return {
        dbId: row.id,
        color: row.color || ECFR_HL_DEFAULT_COLOR,
        kind: row.kind || ECFR_HL_DEFAULT_KIND,
        comment: row.comment || null,
    };
}

// --- Appearance ------------------------------------------------------

function ecfrIsDarkTheme() {
    // Dusk counts as dark: its mid-dark surfaces need the same screen
    // blend + brighter fills as the void theme (task #42).
    const t = document.documentElement.dataset.theme;
    return t === "dark" || t === "dusk";
}

// Called by the renderer for every annotation on every repaint.
//
// Blend-mode note: the overlay layer blends with mix-blend-mode:multiply,
// which is what makes a highlight read like a real marker pen on a light
// page. Multiply against a dark page would drive every fill to near-black,
// so dark theme switches the layer to `screen` (see style.css).
//
// The dark opacities were guessed in round 2 on the theory that `screen`
// lightens and would wash the text out. Seen in a browser at last, the
// guess was backwards: at 0.2 over the dark navy page `screen` yields a
// muddy low-chroma wash — yellow reads as olive, green as grey-sage, and
// the colour coding (the entire point of four colours) stops working.
// The values below were picked off a rendered sweep at 0.20/0.32/0.45/0.60:
// ~0.34 restores the hue while keeping body text crisp; 0.45+ starts
// costing contrast under the lighter pink. Still a taste call — the author may
// want them warmer.
function ecfrAnnotationStyle(annotation, state) {
    const meta = ecfrAnnoMeta[annotation.id] || {};
    const color = ECFR_HL_PALETTE[meta.color] || ECFR_HL_PALETTE[ECFR_HL_DEFAULT_COLOR];
    const selected = !!(state && state.selected);
    const kind = meta.kind || ECFR_HL_DEFAULT_KIND;
    const dark = ecfrIsDarkTheme();

    if (kind === "underline") {
        return { fill: color, fillOpacity: selected ? (dark ? 0.16 : 0.14) : 0,
                 underlineStyle: "solid", underlineColor: color, underlineThickness: 2 };
    }
    if (kind === "strike") {
        // The renderer has no strikethrough; the line itself comes from the
        // dynamic stylesheet below. Keep a faint fill so the span still
        // reads as marked.
        return { fill: color, fillOpacity: selected ? (dark ? 0.26 : 0.2) : (dark ? 0.12 : 0.08) };
    }
    return { fill: color,
             fillOpacity: selected ? (dark ? 0.5 : 0.45) : (dark ? 0.34 : 0.28) };
}

// Strikethrough lines and comment dots can't come from the style function,
// so they're painted with one regenerated stylesheet keyed on the rendered
// spans' data-annotation attribute. Built only from the palette map and
// CSS.escape'd ids — no user text ever reaches it.
function ecfrRefreshDynamicStyles() {
    let el = document.getElementById("ecfr-annot-dynamic");
    if (!el) {
        el = document.createElement("style");
        el.id = "ecfr-annot-dynamic";
        document.head.appendChild(el);
    }
    const rules = [];
    Object.keys(ecfrAnnoMeta).forEach(id => {
        const meta = ecfrAnnoMeta[id];
        const color = ECFR_HL_PALETTE[meta.color] || ECFR_HL_PALETTE[ECFR_HL_DEFAULT_COLOR];
        const sel = `.r6o-annotation[data-annotation="${CSS.escape(id)}"]`;
        if (meta.kind === "strike") {
            rules.push(`${sel}::after{content:"";position:absolute;left:0;right:0;top:50%;`
                + `border-top:2px solid ${color};pointer-events:none;}`);
        }
        if (meta.comment) {
            rules.push(`${sel}::before{content:"";position:absolute;right:-2px;top:-2px;`
                + `width:6px;height:6px;border-radius:50%;background:${color};`
                + `border:1px solid rgba(0,0,0,.45);pointer-events:none;}`);
        }
    });
    el.textContent = rules.join("\n");
}

// --- Instance helpers -------------------------------------------------

function ecfrEachAnnotator(fn) {
    ecfrAnnotators.forEach((rec, i) => fn(rec.ann, i, rec));
}

// Any live instance — for the callers that just need "is anything armed".
function ecfrAnyAnnotator() {
    const first = ecfrAnnotators.values().next();
    return first.done ? null : first.value.ann;
}

// The instance that owns a painted annotation id.
function ecfrAnnotatorFor(annotationId) {
    for (const [, rec] of ecfrAnnotators) {
        try {
            if (rec.ann.getAnnotationById && rec.ann.getAnnotationById(annotationId)) return rec.ann;
        } catch (err) { /* the library may not expose it; fall through */ }
    }
    return ecfrAnyAnnotator();
}

// True when anything on screen can be marked at all.
function ecfrHasAnnotator() {
    return ecfrAnnotators.size > 0;
}

// True when an armed frame's marks would NOT be saved — drives the warning.
function ecfrHasScratchFrame() {
    for (const [, rec] of ecfrAnnotators) if (!rec.persists) return true;
    return false;
}

// --- Attach / detach -------------------------------------------------

// Destroys every instance (or just one frame's). ecfr.js replaces the pane's
// innerHTML on every render, so a surviving instance would leak listeners and
// an overlay layer pointing at detached nodes.
// Destroys every instance, or just one (frameIndex, sectionKey). ecfr.js
// replaces the pane's innerHTML on every render, so a surviving instance
// would leak listeners and an overlay layer pointing at detached nodes.
function ecfrDetachAnnotator(frameIndex, sectionKey) {
    const kill = (id, rec) => {
        try { rec.ann.destroy(); } catch (err) { console.error("eCFR annotator teardown:", err); }
        ecfrAnnotators.delete(id);
        if (ecfrActiveFrame === id) ecfrActiveFrame = null;
        // Scratch marks die with their instance — they were never saved, so
        // there is nothing to come back to. Leaving their meta behind would
        // keep the "marks here are scratch" warning up over a frame that has
        // none, and leak an entry per mark for the life of the session.
        Object.keys(ecfrAnnoMeta).forEach(aid => {
            if (ecfrAnnoMeta[aid].owner === id) delete ecfrAnnoMeta[aid];
        });
    };
    if (frameIndex === undefined) {
        ecfrAnnotators.forEach((rec, id) => kill(id, rec));
        ecfrAnnotators.clear();
        // Meta describes marks that no longer exist; keeping it would let a
        // stale annotation id resolve to a live DB row.
        ecfrAnnoMeta = {};
        ecfrActiveFrame = null;
    } else {
        const id = ecfrAnnKey(frameIndex, sectionKey);
        if (ecfrAnnotators.has(id)) kill(id, ecfrAnnotators.get(id));
    }
    ecfrRefreshDynamicStyles();
}

function ecfrDetachSectionAnnotator(frameIndex, sectionKey) {
    ecfrDetachAnnotator(frameIndex, sectionKey);
}

// Bind ONE section of ONE frame. Driven by the observer, so only sections
// near the viewport ever hold an instance — part 81 subpart B is 246
// sections, and instantiating all of them (times every frame) is not a thing
// to do to a browser.
async function ecfrAttachSectionAnnotator(frameIndex, sectionKey) {
    if (!window.RecogitoJS || ecfrDiffMode) return;
    const id = ecfrAnnKey(frameIndex, sectionKey);
    if (ecfrAnnotators.has(id)) return;                  // already bound

    const frame = ecfrFrames[frameIndex];
    if (!frame) return;
    const src = ECFR_SOURCES[frame.source];
    if (!src.editable || !src.data(sectionKey)) return;

    const container = document.querySelector(
        `#ecfr-pane .ecfr-blocks[data-frame="${frameIndex}"][data-section-key="${CSS.escape(sectionKey)}"]`);
    if (!container || container.dataset.filled !== "1" || !container.firstChild) return;

    const persists = src.persists !== false;
    const token = ++ecfrAttachToken;

    // Saved rows belong to THIS section and are measured against THIS
    // container. ecfrAnnotations holds the open section's rows; a section
    // that isn't the open one has its own rows fetched with it (see
    // ecfrSectionRows), so nothing is anchored against the wrong text.
    let usable = [];
    if (persists) {
        const rows = ecfrSectionRows(sectionKey);
        if (rows.length) {
            const prepared = await ecfrPrepareRows(container, rows);
            // A repaint during the awaits means this container is detached —
            // installing on it would leak, and worse, would anchor to nothing.
            if (token !== ecfrAttachToken && !document.body.contains(container)) return;
            if (ecfrAnnotators.has(id)) return;
            usable = prepared.usable;
            if (sectionKey === ecfrCurrentKey) ecfrOrphanedHighlights = prepared.orphans;
            usable.forEach(row => { ecfrAnnoMeta[`db-${row.id}`] = ecfrMetaFromRow(row); });
        }
    }

    const ann = RecogitoJS.createTextAnnotator(container, {
        adapter: RecogitoJS.W3CTextFormat(`ecfr:${sectionKey}`, container),
        annotatingEnabled: ecfrIsPaintTool(ecfrTool.mode),
        style: ecfrAnnotationStyle,
    });
    ecfrAnnotators.set(id, { ann, key: sectionKey, frame: frameIndex, persists, container });
    if (usable.length) ann.setAnnotations(usable.map(ecfrRowToW3C));

    // Closures, because the library's events don't say which instance fired
    // them and every handler needs to know its section and whether to save.
    ann.on("createAnnotation", (a) => ecfrOnCreateAnnotation(a, id));
    ann.on("deleteAnnotation", (a) => ecfrOnDeleteAnnotation(a, id));
    ann.on("clickAnnotation", (a) => ecfrOnClickAnnotation(a, id));

    ecfrRefreshDynamicStyles();
    ecfrSyncAnnotatingAffordance();
}

// The saved highlights belonging to one section of the loaded unit.
function ecfrSectionRows(sectionKey) {
    if (sectionKey === ecfrCurrentKey && ecfrAnnotations) {
        return ecfrAnnotations.highlights || [];
    }
    // Sections of the unit you haven't made current: the panel's wider-scope
    // payload has them when it's loaded, filtered to this section.
    const p = ecfrPanel;
    if (p && p.highlights) return p.highlights.filter(h => h.section_key === sectionKey);
    return [];
}

// Kept for the callers that just mean "rebind everything on screen" — the
// observer does the real work now, section by section.
async function ecfrAttachAnnotator() {
    ecfrDetachAnnotator();
    if (!window.RecogitoJS || !ecfrUnitSections.length) return;
    ecfrObserveSections();
    renderEcfrAnnotationsPanel();
    ecfrRenderToolbar();
    ecfrSyncAnnotatingAffordance();
}

// --- Migration + rescue ----------------------------------------------

// Splits saved rows into ones the library can safely revive and orphans,
// repairing anchors (and persisting the repairs) along the way.
async function ecfrPrepareRows(container, rows) {
    const text = ecfrContainerText(container);
    const usable = [], orphans = [];

    // Iterate a copy: persisting a repair writes back into the very array
    // the caller passed in (ecfrAnnotations.highlights).
    for (const row of rows.slice()) {
        let fixed = null;
        try {
            fixed = (row.start_pos === null || row.start_pos === undefined)
                ? await ecfrMigrateLegacyRow(container, text, row)
                : await ecfrRescueRow(text, row);
        } catch (err) {
            console.error("eCFR highlight anchoring failed:", err);
        }
        if (fixed) usable.push(fixed); else orphans.push(row);
    }
    return { usable, orphans };
}

// Round-1 rows are anchored to one paragraph block (block_index +
// offsets into that block's text). Convert to container offsets once, then
// persist so this never runs again for that row.
async function ecfrMigrateLegacyRow(container, text, row) {
    const blockEl = container.querySelector(`.ecfr-block[data-block-index="${row.block_index}"]`);
    if (!blockEl) return null;

    const blockText = blockEl.textContent;
    let start = row.start_offset, end = row.end_offset;
    if (blockText.slice(start, end) !== row.quote) {
        // Text drifted since round 1 — fall back to a unique match inside
        // the same block (the block scoping is itself a disambiguator).
        const hits = ecfrAllIndexesOf(blockText, row.quote);
        if (hits.length !== 1) return null;
        start = hits[0];
        end = start + row.quote.length;
    }
    const base = ecfrBlockBaseOffset(container, blockEl);
    if (base < 0) return null;

    const startPos = base + start;
    const endPos = base + end;
    if (text.slice(startPos, endPos) !== row.quote) return null;   // math disagreed; don't guess

    const ctx = ecfrContextAround(text, startPos, endPos);
    return await ecfrPersistAnchor(row, {
        start_pos: startPos, end_pos: endPos, prefix: ctx.prefix, suffix: ctx.suffix,
        color: row.color || ECFR_HL_DEFAULT_COLOR, kind: row.kind || ECFR_HL_DEFAULT_KIND,
    });
}

// A v2 row whose offsets no longer land on its quote (corpus re-imported at
// a newer snapshot, say) gets re-anchored by quote; if that's ambiguous the
// row stays an orphan and keeps its quote rather than moving somewhere wrong.
async function ecfrRescueRow(text, row) {
    if (text.slice(row.start_pos, row.end_pos) === row.quote) return row;   // still good

    const found = ecfrLocateQuote(text, row.quote, row.prefix, row.suffix);
    if (!found) return null;
    const ctx = ecfrContextAround(text, found.start, found.end);
    return await ecfrPersistAnchor(row, {
        start_pos: found.start, end_pos: found.end, prefix: ctx.prefix, suffix: ctx.suffix,
    });
}

// PATCHes the repaired anchor and returns the merged row. Failing to save
// is not fatal: the row still paints this session, and the repair is simply
// recomputed next load.
async function ecfrPersistAnchor(row, fields) {
    const merged = Object.assign({}, row, fields);
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/highlights/${row.id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fields),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = await res.json();
        ecfrSyncPanelRow(saved);
        return saved;
    } catch (err) {
        console.error(`Couldn't persist re-anchored highlight ${row.id}:`, err);
        ecfrSyncPanelRow(merged);
        return merged;
    }
}

// Reverse lookup: DB row id -> the library's annotation id, or null when
// the row isn't currently painted (an orphan, or a different section).
function ecfrAnnotationIdForRow(dbId) {
    return Object.keys(ecfrAnnoMeta).find(id => ecfrAnnoMeta[id].dbId === dbId) || null;
}

// Push a row's saved colour/kind/comment onto its painted mark — in every
// frame showing it, since two local frames paint the same row.
function ecfrApplyRowAppearance(row) {
    const annoId = ecfrAnnotationIdForRow(row.id);
    if (!annoId) return;
    ecfrAnnoMeta[annoId] = ecfrMetaFromRow(row);
    ecfrRefreshDynamicStyles();
    ecfrEachAnnotator((ann) => ann.redraw());
}

// Keep the annotations panel's copy of a row in step with the DB.
function ecfrSyncPanelRow(row) {
    ecfrUpsertRow("highlights", row);
}

// --- Event sync ------------------------------------------------------

// Fires when the user drags out a new span with a paint tool armed, and
// again when an undone create/delete is replayed by undo/redo (the library
// re-adds with LOCAL origin). A replayed annotation already has meta, so
// reuse it — otherwise a re-done highlight would silently adopt whatever
// colour happens to be armed now.
async function ecfrOnCreateAnnotation(annotation, annId) {
    const rec = ecfrAnnotators.get(annId);
    if (!rec) return;
    ecfrActiveFrame = annId;

    const known = ecfrAnnoMeta[annotation.id];
    const color = known ? known.color : ecfrTool.color;
    const kind = known ? known.kind : (ecfrTool.mode === "select" || ecfrTool.mode === "eraser"
        ? ECFR_HL_DEFAULT_KIND : ecfrTool.mode);
    const comment = known ? known.comment : null;

    const sel = (annotation.target && annotation.target.selector || [])[0];
    if (!sel || sel.start === undefined || sel.end === undefined) {
        console.error("eCFR: new annotation has no usable selector", annotation);
        return;
    }
    const text = ecfrContainerText(rec.container);
    const quote = sel.quote || text.slice(sel.start, sel.end);
    if (!quote.trim()) { rec.ann.removeAnnotation(annotation.id); return; }

    ecfrAnnoMeta[annotation.id] = { dbId: null, color, kind, comment,
                                    persists: rec.persists,
                                    owner: rec.persists ? null : annId };
    ecfrRefreshDynamicStyles();
    rec.ann.redraw();

    await ecfrPersistNewMark(annotation.id, quote, sel.start, sel.end, annId);
}

// Saves a mark that has just been painted, and reconciles the DB's answer
// back onto it. The caller owns putting the appearance in ecfrAnnoMeta and
// getting it on screen first; this is only the persistence half.
//
// Two callers, because there are two ways a mark gets made: the library's
// own createAnnotation event (drag with a tool armed), and
// ecfrApplyToolToSelection() below, which the library never sees.
async function ecfrPersistNewMark(annotationId, quote, start, end, annId) {
    const meta = ecfrAnnoMeta[annotationId];
    const rec = ecfrAnnotators.get(annId);
    if (!meta || !rec) return;

    // THE GATE. A frame whose source doesn't persist gets no POST, ever.
    //
    // Offsets index text we don't store and don't control: ecfr.gov can amend
    // it between now and the next load, and nothing would tell us. A saved
    // mark would silently drift onto the wrong words — the exact failure the
    // whole anchoring design exists to prevent. So live marks are scratch:
    // real while you're reading, gone when you navigate, never written down.
    if (!rec.persists) {
        ecfrRenderToolbar();          // undo just became available
        return;
    }

    const text = ecfrContainerText(rec.container);
    const ctx = ecfrContextAround(text, start, end);

    try {
        const res = await fetch(`${API_BASE}/api/ecfr/highlights`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                section_key: rec.key, quote,
                color: meta.color, kind: meta.kind, comment: meta.comment,
                start_pos: start, end_pos: end,
                prefix: ctx.prefix, suffix: ctx.suffix,
                snapshot_date: (ecfrStatus && ecfrStatus.snapshot_date) || "",
            }),
        });
        const saved = await res.json();
        if (!res.ok) throw new Error(saved.error || `HTTP ${res.status}`);
        if (ecfrAnnoMeta[annotationId]) ecfrAnnoMeta[annotationId].dbId = saved.id;
        ecfrSyncPanelRow(saved);
        ecfrBumpCounts("highlights", 1);
        renderEcfrAnnotationsPanel();
        ecfrRenderToolbar();          // undo just became available
    } catch (err) {
        console.error("Error saving highlight:", err);
        toast("Couldn't save the highlight.");
        // Don't leave a mark on screen that isn't in the database.
        rec.ann.removeAnnotation(annotationId);
        delete ecfrAnnoMeta[annotationId];
        ecfrRefreshDynamicStyles();
    }
}

// --- Select-first painting -------------------------------------------

// Paints the armed tool onto text the user has ALREADY selected, and
// returns whether it made a mark.
//
// The library only ever creates on a *selection that ends while annotating
// is enabled* — so "select the text, then reach for a colour", which is how
// every PDF editor works and how the author actually reads, produced nothing at
// all. This is the missing half: we build the mark ourselves from the live
// selection when a paint tool is armed.
//
// Two consequences worth knowing:
//   - addAnnotation() is treated by the library as origin REMOTE, so no
//     createAnnotation event fires and we must persist by hand (below).
//   - REMOTE also means the mark never enters the library's undo stack, so
//     Ctrl+Z won't reach a select-first mark. The eraser and the panel's ✕
//     both still remove it. Accepted deliberately — see the round-3 plan.
function ecfrApplyToolToSelection() {
    if (!ecfrHasAnnotator() || !window.RecogitoJS) return false;
    if (!ecfrIsPaintTool(ecfrTool.mode)) return false;

    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
    const raw = sel.getRangeAt(0);

    // WHICH frame did they select in? intersectsNode answers it, and it has
    // to: trimRangeToContainer CLAMPS a range to the container rather than
    // rejecting it, so handed a selection made in another frame it returns
    // that container's ENTIRE text and would silently highlight the whole
    // section. (Verified against the vendored bundle in a browser — it does
    // not collapse.) With several annotatable frames this guard stops being
    // just a safety net and becomes the routing.
    let annId = null, rec = null;
    for (const [id, r] of ecfrAnnotators) {
        if (raw.intersectsNode(r.container)) { annId = id; rec = r; break; }
    }
    if (!rec) return false;                    // selection wasn't in an annotatable section

    const container = rec.container;
    const range = RecogitoJS.trimRangeToContainer(raw.cloneRange(), container);
    if (!range || range.collapsed) return false;

    const selector = RecogitoJS.rangeToSelector(range, container);
    if (!selector || !selector.quote || !selector.quote.trim()) return false;   // whitespace-only

    const text = ecfrContainerText(container);
    const ctx = ecfrContextAround(text, selector.start, selector.end);
    const id = `sel-${Math.random().toString(36).slice(2, 11)}`;

    ecfrAnnoMeta[id] = {
        dbId: null, color: ecfrTool.color, kind: ecfrTool.mode, comment: null,
        persists: rec.persists,
        // A scratch mark lives in exactly one instance, so it can be owned —
        // which is what lets the detach below take its meta with it. Saved
        // marks are deliberately shared (one row, one look, every frame).
        owner: rec.persists ? null : annId,
    };
    ecfrActiveFrame = annId;

    // Drop the selection BEFORE the caller arms the annotator: an armed
    // instance that still sees a live selection would create a second mark
    // over the same words.
    sel.removeAllRanges();

    rec.ann.addAnnotation({
        "@context": "http://www.w3.org/ns/anno.jsonld",
        id,
        type: "Annotation",
        body: [],
        target: {
            source: `ecfr:${rec.key}`,
            selector: [
                { type: "TextQuoteSelector", exact: selector.quote,
                  prefix: ctx.prefix, suffix: ctx.suffix },
                { type: "TextPositionSelector", start: selector.start, end: selector.end },
            ],
        },
    });
    ecfrRefreshDynamicStyles();
    ecfrPersistNewMark(id, selector.quote, selector.start, selector.end, annId);
    return true;
}

// Crosshair on EVERY annotatable frame while a paint tool is armed — the only
// on-page cue that dragging will now mark the text up.
function ecfrSyncAnnotatingAffordance() {
    document.querySelectorAll("#ecfr-pane .ecfr-frame-body.annotating")
        .forEach(el => el.classList.remove("annotating"));
    if (!ecfrHasAnnotator() || !ecfrIsPaintTool(ecfrTool.mode)) return;
    ecfrAnnotators.forEach((rec) => {
        const body = rec.container.closest(".ecfr-frame-body");
        if (body) body.classList.add("annotating");
    });
}

async function ecfrOnDeleteAnnotation(annotation, annId) {
    const meta = ecfrAnnoMeta[annotation.id];
    if (!meta) return;
    if (annId !== undefined) ecfrActiveFrame = annId;
    // A scratch mark has no dbId and never had one — erasing it is just
    // erasing it. Nothing to DELETE, nothing to un-count.
    if (!meta.dbId) {
        delete ecfrAnnoMeta[annotation.id];
        ecfrRefreshDynamicStyles();
        ecfrRenderToolbar();
        return;
    }
    const dbId = meta.dbId;
    meta.dbId = null;                 // an undo may re-create it under a new row
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/highlights/${dbId}`, { method: "DELETE" });
        if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
        console.error("Error deleting highlight:", err);
        toast("Couldn't remove the highlight.");
    }
    ecfrRemoveRow("highlights", dbId);
    ecfrBumpCounts("highlights", -1);
    if (ecfrHighlightEditingId === dbId) ecfrHighlightEditingId = null;
    // The same row may be painted in a second local frame; drop it there too,
    // or the mark outlives the row it stands for.
    ecfrAnnotators.forEach((rec, id) => {
        if (id === annId) return;
        try { rec.ann.removeAnnotation(annotation.id); } catch (err) { /* not in this one */ }
    });
    ecfrRefreshDynamicStyles();
    renderEcfrAnnotationsPanel();
    ecfrRenderToolbar();
}

// Eraser removes what you click; any other tool opens the mark's comment
// editor in the annotations panel (ecfrShowHighlightEditor lives there).
// A scratch mark has no DB row, so there's no comment editor to open.
function ecfrOnClickAnnotation(annotation, annId) {
    if (annId !== undefined) ecfrActiveFrame = annId;
    if (ecfrTool.mode === "eraser") {
        const rec = ecfrAnnotators.get(annId);
        if (rec) rec.ann.removeAnnotation(annotation.id);
        return;
    }
    const meta = ecfrAnnoMeta[annotation.id];
    if (meta && meta.dbId) ecfrShowHighlightEditor(meta.dbId);
}
