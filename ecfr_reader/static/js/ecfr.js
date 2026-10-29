// =====================================================================
// ecfr-reader — dashboard (local corpus snapshot + upstream update check)
// and reader (Title 40 parts 50-99). The reading area is one to six
// side-by-side FRAMES, each pointing at a source (the local snapshot or
// live ecfr.gov) so two versions of a section can be read against each
// other. Notes / highlights / favorites are yours, kept in annotations.db.
//
// Loaded after app.js — uses its esc()/escAttr()/escJs()/toast()/API_BASE
// and the showScreen()/syncHash()/restoreFromHash() hooks defined there.
// =====================================================================

let ecfrStatus = null;          // GET /api/ecfr/status payload
let ecfrPartsList = null;       // GET /api/ecfr/toc "parts" array (independent of ecfrStatus —
                                 // a deep link into the reader never loads the dashboard)
let ecfrPartCache = {};         // part -> {part, subparts, sections} (GET /api/ecfr/toc/<part>)
let ecfrExpanded = new Set();   // part ids expanded in the TOC sidebar
let ecfrCurrentKey = null;      // section_key currently open in the reader, or null (dashboard)
let ecfrCurrentPart = null;     // part of the currently open section (drives sidebar scroll/highlight)
let ecfrSection = null;         // the open section's payload — an alias into
                                 // ecfrLocalCache, kept for the panel and the star,
                                 // which all still speak about ONE section

// --- The reading unit -------------------------------------------------
// The reader loads a top-level division of a part and scrolls it, rather than
// one section at a time: "what does this subpart actually say" was a
// thirty-click question. A unit is a subpart, a single appendix, or the part's
// loose sections — the same three shapes ecfrTocGroups() produces and
// /api/ecfr/unit serves.
//
// Not the whole of Title 40: that's 10,812 sections / 73 MB / 229,910 blocks
// and needs virtualisation. A unit is a median 10 sections / 37 KB.
let ecfrUnit = null;            // {part, subpart, appendix} — what's loaded
let ecfrUnitSections = [];      // its sections in document order (metadata + blocks)
let ecfrLocalCache = {};        // section_key -> local payload, filled by the unit load
let ecfrUnitLoading = false;
let ecfrUnitHeading = "";       // the subpart/appendix heading, for the frame header
// What the reader is focused on: one section (the default — a section row, a
// search hit, a #ecfr/read/<key> link) or the whole subpart (its heading in
// the tree, a subpart favorite, #ecfr/read/<part>/<subpart>). The timeline
// and the Compare tab follow it; scrolling, which moves the current section,
// never changes it. Only a subpart can be the focus: ecfr.gov serves a
// subpart whole, not an appendix or a part's loose sections.
let ecfrFocus = "section";      // "section" | "unit"
let ecfrSectionObserver = null; // lazy block fill + annotator lifecycle
let ecfrLoading = false;
let ecfrLiveCache = {};         // section_key -> GET /api/ecfr/section/live payload (survives
                                 // section nav, so flipping back is instant and doesn't re-hit ecfr.gov)
let ecfrAnnotations = null;     // scope=section payload for ecfrCurrentKey. Stays
                                 // section-scoped whatever the panel is showing —
                                 // it's what the annotator anchors, and a foreign
                                 // section's offsets mean nothing in this container.
let ecfrOrphanedHighlights = []; // highlights whose quote no longer matches the rendered text
let ecfrNoteEditingId = null;   // note id currently open for inline editing, or null
let ecfrHighlightEditingId = null; // highlight id whose comment editor is open, or null

// --- Panel scope -----------------------------------------------------
// The annotations panel filters to a level of the tree and narrows as you
// walk down it: all of Title 40 with nothing open, then the section you
// opened. Widening is a click; opening a different section re-narrows.
let ecfrScope = "title";        // title | part | subpart | section
let ecfrPanel = null;           // payload the panel renders. === ecfrAnnotations
                                 // at section scope, so the two can't diverge.
let ecfrPanelLoading = false;

// --- The annotation tree ---------------------------------------------
// Every annotation in Title 40, grouped part > subpart > section, browsable
// without moving the reader.
//
// The old scope bar could only offer levels reachable from the section you
// already had open, so "I know my note is in Part 63, show me Part 63" was
// unanswerable unless you were already in Part 63 — which is the one case
// where you don't need to ask.
let ecfrAllAnnotations = null;      // {notes, highlights} across Title 40
let ecfrAllAnnotationsLoading = false;
let ecfrTreeOpen = {};              // node id -> expanded

async function ecfrEnsureAllAnnotations(force) {
    if (ecfrAllAnnotations && !force) return ecfrAllAnnotations;
    if (ecfrAllAnnotationsLoading) return ecfrAllAnnotations;
    ecfrAllAnnotationsLoading = true;
    renderEcfrAnnotationsPanel();
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/annotations?scope=title`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        ecfrAllAnnotations = d;
    } catch (err) {
        console.error("Error loading the annotation tree:", err);
        toast("Couldn't load your annotations.");
    } finally {
        ecfrAllAnnotationsLoading = false;
        renderEcfrAnnotationsPanel();
    }
    return ecfrAllAnnotations;
}

// Rows -> part > subpart > section, in document order where we know it.
// Sections with no subpart hang off the part, mirroring the reader's units.
function ecfrAnnoTree() {
    const rows = [];
    const d = ecfrAllAnnotations || { notes: [], highlights: [] };
    (d.highlights || []).forEach(r => rows.push({ ...r, kind: "highlight" }));
    (d.notes || []).forEach(r => rows.push({ ...r, kind: "note" }));

    const parts = new Map();
    rows.forEach(r => {
        const partId = r.part || (r.section_key || "").split(":")[0];
        if (!parts.has(partId)) parts.set(partId, { id: partId, n: 0, subparts: new Map() });
        const part = parts.get(partId);
        part.n++;
        // null subpart is a real grouping ("directly under the part"), not a
        // missing value — 258 corpus sections have none.
        const spId = r.subpart || "";
        if (!part.subparts.has(spId)) {
            part.subparts.set(spId, { id: spId, n: 0, sections: new Map() });
        }
        const sp = part.subparts.get(spId);
        sp.n++;
        if (!sp.sections.has(r.section_key)) {
            sp.sections.set(r.section_key, {
                key: r.section_key,
                citation: r.section_citation || r.section_key,
                heading: r.section_heading || "",
                rows: [],
            });
        }
        sp.sections.get(r.section_key).rows.push(r);
    });

    const byNum = (a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0)
        || String(a.id).localeCompare(String(b.id));
    return [...parts.values()].sort(byNum).map(p => ({
        ...p,
        subparts: [...p.subparts.values()].sort((a, b) => a.id.localeCompare(b.id)).map(sp => ({
            ...sp, sections: [...sp.sections.values()],
        })),
    }));
}

function ecfrTreeToggle(id) {
    ecfrTreeOpen[id] = !ecfrTreeOpen[id];
    renderEcfrAnnotationsPanel();
}

function ecfrPartLabel(partId) {
    const p = (ecfrPartsList || []).find(x => x.part === partId);
    return p ? ecfrPartSubject(p.heading) : "";
}

function ecfrAnnoTreeHtml() {
    if (ecfrAllAnnotationsLoading && !ecfrAllAnnotations) {
        return `<p class="hint" style="padding:8px 12px;">Loading…</p>`;
    }
    if (!ecfrAllAnnotations) {
        return `<p class="hint" style="padding:8px 12px;">
            <button class="ecfr-btn" onclick="ecfrEnsureAllAnnotations()">Browse all annotations</button></p>`;
    }
    const tree = ecfrAnnoTree();
    if (!tree.length) {
        return `<p class="hint" style="padding:8px 12px;">Nothing marked or noted anywhere
            in Title 40 yet.</p>`;
    }
    return tree.map(part => {
        const pid = `p:${part.id}`;
        const open = ecfrTreeOpen[pid];
        return `<div class="ecfr-tree-part">
            <button class="ecfr-tree-node ${part.id === ecfrCurrentPart ? "here" : ""}"
                onclick="ecfrTreeToggle(${escJs(pid)})">
                <span class="ecfr-tree-caret">${open ? "▾" : "▸"}</span>
                <span class="ecfr-tree-label">Part ${esc(part.id)}<span
                    class="ecfr-tree-sub">${esc(ecfrPartLabel(part.id))}</span></span>
                <span class="ecfr-tree-n">${part.n}</span>
            </button>
            ${open ? part.subparts.map(sp => ecfrTreeSubpartHtml(part, sp)).join("") : ""}
        </div>`;
    }).join("");
}

function ecfrTreeSubpartHtml(part, sp) {
    const sid = `s:${part.id}/${sp.id}`;
    const open = ecfrTreeOpen[sid];
    const label = sp.id ? `Subpart ${sp.id}` : "Sections & appendices";
    return `<div class="ecfr-tree-subpart">
        <button class="ecfr-tree-node" onclick="ecfrTreeToggle(${escJs(sid)})">
            <span class="ecfr-tree-caret">${open ? "▾" : "▸"}</span>
            <span class="ecfr-tree-label">${esc(label)}</span>
            <span class="ecfr-tree-n">${sp.n}</span>
        </button>
        ${open ? sp.sections.map(sec => `
            <div class="ecfr-tree-section">
                <button class="ecfr-tree-node ${sec.key === ecfrCurrentKey ? "here" : ""}"
                    title="${escAttr(sec.heading || sec.key)}"
                    onclick="openEcfrSection(${escJs(sec.key)})">
                    <span class="ecfr-tree-caret">§</span>
                    <span class="ecfr-tree-label">${esc(sec.citation)}<span
                        class="ecfr-tree-sub">${esc(sec.heading)}</span></span>
                    <span class="ecfr-tree-n">${sec.rows.length}</span>
                </button>
                ${sec.rows.map(r => ecfrTreeRowHtml(r)).join("")}
            </div>`).join("") : ""}
    </div>`;
}

// One annotation, under its section. Clicking goes to it — which is the whole
// point: you came here because you knew roughly where it was, not exactly.
function ecfrTreeRowHtml(r) {
    const color = ECFR_HL_PALETTE[r.color || "yellow"] || ECFR_HL_PALETTE.yellow;
    const text = r.kind === "note" ? r.note : r.quote;
    return `<button class="ecfr-tree-row"
        title="${escAttr(text || "")}"
        onclick="ecfrTreeGoTo(${escJs(r.section_key)}, ${r.kind === "note" ? "null" : r.id})">
        <span class="ecfr-tree-dot ${r.kind === "note" ? "note" : ""}"
            style="${r.kind === "note" ? "" : `background:${color}`}">${
            r.kind === "note" ? "✎" : ""}</span>
        <span class="ecfr-tree-quote">${esc((text || "").slice(0, 70))}${
            (text || "").length > 70 ? "…" : ""}</span>
    </button>`;
}

// Open the section, then put the mark under your eyes. The reader loads the
// whole unit, so this is a scroll when you're already in the right subpart.
async function ecfrTreeGoTo(key, highlightId) {
    await openEcfrSection(key);
    if (highlightId != null) {
        // The annotator attaches as the section comes into view; give it a
        // beat, then focus. Failing to focus is harmless — you're on the
        // right section either way, which is what you asked for.
        setTimeout(() => ecfrFocusHighlight(highlightId), 400);
    }
}
// --- Favorites ------------------------------------------------------
// Any node of the tree can be starred, not just a section. One list, mixed
// node types; node_key's format says which is which and the three formats
// are disjoint:
//   part     "60"
//   subpart  "60/JJJJ"
//   section  "60:60.4230"
// ecfrFavKeys is the same data as a Set, because every row of the TOC asks
// "am I starred?" on every render and a linear scan per row is silly.
let ecfrFavorites = [];         // GET /api/ecfr/favorites
let ecfrFavKeys = new Set();
let ecfrFavoritesLoaded = false;

function ecfrFavKey(nodeType, a, b) {
    if (nodeType === "part") return String(a);
    if (nodeType === "subpart") return `${a}/${b}`;
    return String(a);           // section: the section_key already is the node key
}

function ecfrSyncFavKeys() {
    ecfrFavKeys = new Set(ecfrFavorites.map(f => f.node_key));
}

// Open state for the two collapsible groups in the sidebar. Same rule as
// ecfrAccOpen: ontoggle records, render reads, neither renders from ontoggle.
let ecfrTocRootOpen = true;
let ecfrFavsGroupOpen = true;

// --- Search ----------------------------------------------------------
// null results = not searching (the tree shows). An empty array is a real
// answer ("no hits"), so the two can't be collapsed into one falsy check.
let ecfrSearchQuery = "";
let ecfrSearchResults = null;
let ecfrSearchTotal = 0;
let ecfrSearchLoading = false;
let ecfrSearchTimer = null;
let ecfrSearchSeq = 0;          // only the newest query may paint
const ECFR_SEARCH_PAGE = 25;
const ECFR_SEARCH_MIN = 2;

function ecfrSearching() {
    return ecfrSearchResults !== null;
}

// --- Right-panel accordion -------------------------------------------
// Which sections are open. Written by ontoggle and read when rendering —
// but the panel is NEVER re-rendered from the toggle handler: <details>
// fires ontoggle on the freshly-parsed element during a render, so
// rendering from it would loop.
// `tree` starts closed: expanding it is what fetches every annotation in
// Title 40, and that shouldn't happen just because you opened a section.
let ecfrAccOpen = { bookmarks: true, notes: true, tree: false };

function ecfrAccToggled(id, open) {
    ecfrAccOpen[id] = open;
    // The tree costs a fetch of every annotation in Title 40, so it loads when
    // you first ask for it rather than on every section open.
    //
    // This is the one place ontoggle is allowed to cause a render, and it
    // terminates: ecfrEnsureAllAnnotations sets the loading flag BEFORE
    // rendering, so the fresh <details> re-fires ontoggle straight into the
    // guard below and stops.
    if (id === "tree" && open && !ecfrAllAnnotations && !ecfrAllAnnotationsLoading) {
        ecfrEnsureAllAnnotations();
    }
}

function ecfrAccHtml(id, title, count, body) {
    return `<details class="ecfr-acc" ${ecfrAccOpen[id] ? "open" : ""}
        ontoggle="ecfrAccToggled(${escJs(id)}, this.open)">
        <summary>${esc(title)}${count === null ? ""
            : `<span class="ecfr-acc-n">${count}</span>`}</summary>
        <div class="ecfr-acc-body">${body}</div>
    </details>`;
}

// --- Reading frames -------------------------------------------------
// Registry of things a frame can display. Adding a state's rules later
// means adding one entry here (label + fetch + whether it's annotatable);
// nothing else in the reader needs to know the source exists.
//   label(data)  -> the provenance string shown in the frame header. It must
//                   name the exact version on screen, never just the source.
//   editable     -> you may mark this frame up.
//   persists     -> those marks are SAVED. Two different questions, and
//                   conflating them is why live text couldn't be marked at
//                   all until round 4. A saved mark anchors to character
//                   offsets, so it can only be trusted against text we store
//                   and control; ecfr.gov can amend live text between one
//                   load and the next with nothing to tell us, and the mark
//                   would drift silently onto the wrong words. So live is
//                   editable but scratch: real while you read, gone when you
//                   navigate, never written down. Default true if absent.
//   ensure(key)  -> resolves once the frame's data for `key` is available.
//   data(key)    -> the payload to render, or null if not loaded yet.
//   name         -> short label for the source picker (the registry drives it,
//                   so a new source needs no change to the option loop).
const ECFR_SOURCES = {
    local: {
        name: "Local snapshot",
        label: () => { const a = ecfrLocalAmendment();
            return `Local snapshot — eCFR as of ${(ecfrStatus && ecfrStatus.snapshot_date) || "date unknown"}${a ? ` · text as amended ${a}` : ""}`; },
        editable: true,
        persists: true,
        // Keyed like live, not a single global section. That symmetry is what
        // lets a frame render a whole unit: the renderer walks the unit's
        // section keys and asks each source for that key, and a source that
        // hasn't got it yet says so and fetches when the section scrolls near.
        // The local unit arrives in one /api/ecfr/unit call, so ensure() has
        // nothing left to do; live fetches page by page as you reach them.
        ensure: async () => {},
        data: (key) => ecfrLocalCache[key] || null,
    },
    live: {
        name: "Live ecfr.gov",
        label: (d) => (d && d.as_of) ? `Live ecfr.gov — as of ${d.as_of}` : "Live ecfr.gov — today",
        editable: true,
        persists: false,
        ensure: (key) => ecfrEnsureLiveData(key),
        data: (key) => ecfrLiveCache[key] || null,
    },
};

// --- Dated versions ---------------------------------------------------
// A frame can show a section as it stood on any date ecfr.gov holds (its
// point-in-time history starts 2017-01-01). Each date becomes a source of
// its own, "version:<date>", registered here the first time it's asked for
// — so the frame machinery, the picker and the annotator (scratch, like
// live) all work on it unchanged. The text arrives whole for a subpart
// (/api/ecfr/unit/at, one request per subpart and date) and per section
// otherwise (/api/ecfr/section/at); both are cached for ever on the server.
let ecfrVersionCache = {};        // date -> { section_key -> payload }

function ecfrVersionSource(date) {
    const id = `version:${date}`;
    if (!ECFR_SOURCES[id]) {
        ECFR_SOURCES[id] = {
            name: `As of ${date}`,
            label: () => `As of ${date} — fetched from ecfr.gov`,
            editable: true,
            persists: false,
            ensure: (key) => ecfrEnsureVersionData(date, key),
            data: (key) => (ecfrVersionCache[date] || {})[key] || null,
        };
    }
    return id;
}

let ecfrVersionFetches = {};      // "date|key" -> in-flight promise (the frame loader and the
                                  // scroll observer can ask for the same text in one tick)

async function ecfrEnsureVersion(date, key) {
    const have = (ecfrVersionCache[date] || {})[key];
    if (have) return have;
    const id = `${date}|${key}`;
    if (!ecfrVersionFetches[id]) {
        ecfrVersionFetches[id] = (async () => {
            const params = new URLSearchParams({ key, date });
            const res = await fetch(`${API_BASE}/api/ecfr/section/at?${params.toString()}`);
            const d = await res.json();
            if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
            (ecfrVersionCache[date] = ecfrVersionCache[date] || {})[key] = d;
            return d;
        })().finally(() => { delete ecfrVersionFetches[id]; });
    }
    return ecfrVersionFetches[id];
}

let ecfrUnitVersionCache = {};    // "part/subpart|date" -> the /api/ecfr/unit/at payload
let ecfrUnitVersionFetches = {};  // the same key -> in-flight promise

// The dated twin of ecfrEnsureLiveData: a subpart as of a date is ONE
// request, which seeds every section of it in ecfrVersionCache. A section
// the subpart didn't have on that date resolves to null rather than asking
// ecfr.gov again for text it has already said wasn't there; appendices and
// loose sections take the per-section route as before.
async function ecfrEnsureVersionData(date, key) {
    const have = (ecfrVersionCache[date] || {})[key];
    if (have) return have;
    const unit = ecfrUnitOf(key);
    if (unit && unit.subpart) {
        await ecfrEnsureUnitVersion(date, unit);
        return (ecfrVersionCache[date] || {})[key] || null;
    }
    return ecfrEnsureVersion(date, key);
}

async function ecfrEnsureUnitVersion(date, unit) {
    const id = `${unit.part}/${unit.subpart}|${date}`;
    if (ecfrUnitVersionCache[id]) return ecfrUnitVersionCache[id];
    if (!ecfrUnitVersionFetches[id]) {
        ecfrUnitVersionFetches[id] = (async () => {
            const params = new URLSearchParams({ part: unit.part, subpart: unit.subpart, date });
            const res = await fetch(`${API_BASE}/api/ecfr/unit/at?${params.toString()}`);
            const d = await res.json();
            if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
            const bucket = (ecfrVersionCache[date] = ecfrVersionCache[date] || {});
            (d.sections || []).forEach(s => { bucket[s.section_key] = s; });
            ecfrUnitVersionCache[id] = d;
            return d;
        })().finally(() => { delete ecfrUnitVersionFetches[id]; });
    }
    return ecfrUnitVersionFetches[id];
}

// --- Proposed text ----------------------------------------------------
// A docket file read as proposed regulatory text (ecfr_reader/proposals/)
// is a source like a dated version: "proposal:<id>" is the subpart as it
// would read under the proposal, composed on the local snapshot;
// "proposal:<id>:before" is the base EPA marked up, composed the same way,
// so diffing it against Local says whether EPA redlined the text you have.
// The list comes from /api/dockets/proposals?part= when a unit loads.
let ecfrProposals = [];           // [{id, title, kind, parts, subparts, stats}] for the open part
let ecfrProposalsPart = null;
let ecfrProposalCache = {};       // source -> { section_key -> section }
let ecfrProposalUnits = {};       // "<source>|<part>/<subpart>" -> the composed unit (with coverage)
let ecfrProposalFetches = {};

function ecfrProposalId(source) { return source.split(":")[1]; }
function ecfrProposalSide(source) { return source.endsWith(":before") ? "before" : "after"; }
function ecfrProposalOf(source) { return ecfrProposals.find(p => String(p.id) === ecfrProposalId(source)) || null; }

function ecfrCoverageText(cov) {
    if (!cov) return "";
    const bits = [`${cov.sections_touched} section${cov.sections_touched === 1 ? "" : "s"} touched`,
                  `${cov.replaced} replaced`, `${cov.inserted} inserted`, `${cov.removed} removed`];
    if (cov.added_sections && cov.added_sections.length) bits.push(`${cov.added_sections.length} section${cov.added_sections.length === 1 ? "" : "s"} added`);
    if (cov.removed_sections && cov.removed_sections.length) bits.push(`${cov.removed_sections.length} section${cov.removed_sections.length === 1 ? "" : "s"} removed`);
    if (cov.unmatched && cov.unmatched.length) bits.push(`${cov.unmatched.length} unmatched`);
    if (cov.base_match != null) bits.push(`base matches the snapshot ${Math.round(cov.base_match * 100)}%`);
    return bits.join(" · ");
}

function ecfrProposalCoverage(source) {
    const u = ecfrUnit && ecfrUnit.subpart ? ecfrProposalUnits[`${source}|${ecfrUnit.part}/${ecfrUnit.subpart}`] : null;
    if (u) return u.coverage;
    const d = (ecfrProposalCache[source] || {})[ecfrCurrentKey];
    return d ? d.coverage : null;
}

function ecfrProposalSource(id, side = "after") {
    const source = `proposal:${id}${side === "before" ? ":before" : ""}`;
    if (!ECFR_SOURCES[source]) {
        const title = () => { const p = ecfrProposalOf(source); return p ? p.title : `proposal ${id}`; };
        ECFR_SOURCES[source] = {
            name: side === "before" ? `Base of proposal — ${title()}` : `Proposed — ${title()}`,
            label: () => {
                const cov = ecfrProposalCoverage(source);
                const what = side === "before" ? "Base of proposal" : "Proposed";
                return `${what} — ${title()} · composed on the local snapshot${cov ? ` · ${ecfrCoverageText(cov)}` : ""}`;
            },
            hint: () => {
                const cov = ecfrProposalCoverage(source);
                if (!cov) return "";
                const lines = [];
                if (cov.unmatched && cov.unmatched.length) lines.push("Unmatched (no paragraph at that path in the snapshot, listed, not dropped):\n" +
                    cov.unmatched.map(u => `  § ${u.identifier} ${u.path}: ${u.text}`).join("\n"));
                if (cov.mismatches && cov.mismatches.length) lines.push("Base paragraphs that differ from the snapshot:\n" +
                    cov.mismatches.map(m => `  § ${m.identifier} ${m.path}`).join("\n"));
                return lines.join("\n\n");
            },
            editable: false,
            persists: false,
            ensure: (key) => ecfrEnsureProposalData(source, key),
            data: (key) => (ecfrProposalCache[source] || {})[key] || null,
        };
    }
    return source;
}

async function ecfrEnsureProposalData(source, key) {
    const have = (ecfrProposalCache[source] || {})[key];
    if (have) return have;
    const unit = ecfrUnitOf(key);
    if (unit && unit.subpart) {
        await ecfrEnsureProposalUnit(source, unit);
        return (ecfrProposalCache[source] || {})[key] || null;
    }
    const id = `${source}|${key}`;
    if (!ecfrProposalFetches[id]) {
        ecfrProposalFetches[id] = (async () => {
            const params = new URLSearchParams({ key, side: ecfrProposalSide(source) });
            const res = await fetch(`${API_BASE}/api/dockets/proposals/${ecfrProposalId(source)}/section?${params.toString()}`);
            const d = await res.json();
            if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
            (ecfrProposalCache[source] = ecfrProposalCache[source] || {})[key] = d;
            return d;
        })().finally(() => { delete ecfrProposalFetches[id]; });
    }
    return ecfrProposalFetches[id];
}

async function ecfrEnsureProposalUnit(source, unit) {
    const id = `${source}|${unit.part}/${unit.subpart}`;
    if (ecfrProposalUnits[id]) return ecfrProposalUnits[id];
    if (!ecfrProposalFetches[id]) {
        ecfrProposalFetches[id] = (async () => {
            const params = new URLSearchParams({ part: unit.part, subpart: unit.subpart, side: ecfrProposalSide(source) });
            const res = await fetch(`${API_BASE}/api/dockets/proposals/${ecfrProposalId(source)}/unit?${params.toString()}`);
            const d = await res.json();
            if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
            const bucket = (ecfrProposalCache[source] = ecfrProposalCache[source] || {});
            (d.sections || []).forEach(s => { bucket[s.section_key] = s; });
            ecfrProposalUnits[id] = d;
            ecfrRefreshProvenance();        // the header's coverage line waits on this
            return d;
        })().finally(() => { delete ecfrProposalFetches[id]; });
    }
    return ecfrProposalFetches[id];
}

// The proposals that cover a part, fetched once per part; the pickers
// (frames and Compare) list them as soon as they arrive.
async function ecfrLoadProposals(part, force = false) {
    if (ecfrProposalsPart === part && !force) return;
    ecfrProposalsPart = part;
    try {
        const res = await fetch(`${API_BASE}/api/dockets/proposals?part=${encodeURIComponent(part)}`);
        const d = await res.json();
        ecfrProposals = res.ok ? (d.proposals || []) : [];
    } catch (e) {
        ecfrProposals = [];
    }
    ecfrProposals.forEach(p => { ecfrProposalSource(p.id, "after"); ecfrProposalSource(p.id, "before"); });
    ecfrRefreshFrameSelects();
    if (typeof cmpRenderControls === "function" && document.getElementById("ecfr-compare")) cmpRenderControls();
}

// After a file is (re)read as a proposal in the Dockets tab: forget what
// was composed from the old reading.
function ecfrForgetProposals() {
    ecfrProposalsPart = null;
    ecfrProposalCache = {};
    ecfrProposalUnits = {};
}

// --- The timeline ----------------------------------------------------
// Across the top of the pane: every date ecfr.gov amended the open section,
// plus Local (the snapshot) and Live (today) on the same rail. It is the
// viewer's reading aid — a click opens that version in a frame beside what
// you have; comparing two versions is the pane's Compare tab (compare.js),
// which the rail links to.
let ecfrVersions = null;          // {key, versions:[{date,…}], latest, local_snapshot_date} | {key, error}

async function ecfrLoadVersions(key) {
    ecfrVersions = { key, loading: true };
    ecfrRenderTimeline();
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/section/versions?key=${encodeURIComponent(key)}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        if (ecfrCurrentKey !== key) return;
        ecfrVersions = { key, ...d };
    } catch (err) {
        if (ecfrCurrentKey !== key) return;
        ecfrVersions = { key, error: err.message || "Couldn't load the version history." };
    }
    ecfrRenderTimeline();
    ecfrRefreshFrameSelects();
    ecfrRefreshProvenance();       // the Local header names the amendment it holds, known only now
}

// The subpart's history: every date ANY of its sections changed, from
// /api/ecfr/unit/versions (one request upstream). Shown while the subpart is
// the focus; each tick knows which sections it touched.
async function ecfrLoadUnitVersions(unit) {
    const unitId = ecfrUnitId(unit);
    if (!unitId) return;
    ecfrVersions = { unitId, loading: true };
    ecfrRenderTimeline();
    try {
        const params = new URLSearchParams({ part: unit.part, subpart: unit.subpart });
        const res = await fetch(`${API_BASE}/api/ecfr/unit/versions?${params.toString()}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        if (ecfrUnitId() !== unitId) return;
        ecfrVersions = { unitId, ...d };
    } catch (err) {
        if (ecfrUnitId() !== unitId) return;
        ecfrVersions = { unitId, error: err.message || "Couldn't load the version history." };
    }
    ecfrRenderTimeline();
    ecfrRefreshFrameSelects();
    ecfrRefreshProvenance();       // the Local header names the amendment it holds, known only now
}

// The timeline for what's in focus — the subpart's history or the current
// section's — fetched only when it isn't already the one on screen.
function ecfrEnsureTimeline() {
    if (!ecfrCurrentKey) return;
    if (ecfrUnitFocused()) {
        if (!ecfrVersions || ecfrVersions.unitId !== ecfrUnitId()) ecfrLoadUnitVersions(ecfrUnit);
    } else if (!ecfrVersions || ecfrVersions.key !== ecfrCurrentKey) {
        ecfrLoadVersions(ecfrCurrentKey);
    }
}

function ecfrTimelineTicks() {
    const v = ecfrVersions;
    if (!v || !v.versions) return [];
    const today = new Date().toISOString().slice(0, 10);
    const ticks = v.versions.map(x => ({ id: `version:${x.date}`, date: x.date, kind: "version",
        substantive: x.substantive, removed: x.removed, issue: x.issue_date, sections: x.sections }));
    const local = v.local_snapshot_date || (ecfrStatus && ecfrStatus.snapshot_date);
    if (local) ticks.push({ id: "local", date: local, kind: "local" });
    ticks.push({ id: "live", date: today, kind: "live" });
    ticks.sort((p, q) => p.date < q.date ? -1 : p.date > q.date ? 1 : (p.kind === "version" ? -1 : 1));
    return ticks;
}

// The amendment a snapshot's text corresponds to: the last amendment date
// on or before the snapshot's own date. "Local snapshot 2026-07-28" names
// the day the picture was taken; the text in it is whatever ecfr.gov had
// published by then, which is this amendment.
function ecfrAmendmentFor(ticks, date) {
    let best = null;
    ticks.forEach(t => { if (t.kind === "version" && t.date <= date) best = t; });
    return best;
}

function ecfrLocalAmendment() {
    const ticks = ecfrTimelineTicks();
    const local = ticks.find(t => t.kind === "local");
    const a = local && ecfrAmendmentFor(ticks, local.date);
    return a ? a.date : null;
}

function ecfrRenderTimeline() {
    const el = document.getElementById("ecfr-timeline");
    if (!el) return;
    const v = ecfrVersions;
    const unit = ecfrUnitFocused();
    const matches = v && (unit ? v.unitId === ecfrUnitId() : v.key === ecfrCurrentKey);
    if (!matches) { el.innerHTML = ""; return; }
    if (v.loading) { el.innerHTML = `<span class="ecfr-timeline-note">Loading the version history…</span>`; return; }
    if (v.error) { el.innerHTML = `<span class="ecfr-timeline-note">Version history unavailable: ${esc(v.error)}</span>`; return; }
    const ticks = ecfrTimelineTicks();
    if (!ticks.length) { el.innerHTML = ""; return; }
    const showing = new Set(ecfrFrames.map(f => f.source));
    const holds = t => { const a = ecfrAmendmentFor(ticks, t.date); return a ? ` — holds the text as amended ${a.date}` : ""; };
    // The legend's extra entries: which amendment Local (and Live) hold,
    // drawn as the leads on the rail are drawn.
    const held = {};            // amendment date -> ["Local", "Live"]
    ticks.filter(t => t.kind !== "version").forEach(t => {
        const a = ecfrAmendmentFor(ticks, t.date);
        if (a) (held[a.date] = held[a.date] || []).push(t.kind === "local" ? "Local" : "Live");
    });
    const leadLegend = Object.keys(held).map(date => {
        const who = held[date];
        const cls = who.length === 2 ? "lead-both" : who[0] === "Local" ? "lead-local" : "lead-live";
        return `<i class="lg ${cls}"></i>${esc(who.join(" & "))} = as amended ${esc(date)}`;
    }).join("");
    const tickHtml = ticks.map(t => {
        const label = t.kind === "local" ? "Local" : t.kind === "live" ? "Live" : t.date.slice(0, 7);
        const title = (t.kind === "local" ? `Your local snapshot: the eCFR as it stood on ${t.date} (what \`ecfr_reader fetch\` downloaded)${holds(t)}`
            : t.kind === "live" ? `Live ecfr.gov: the text as it stands today, ${t.date}${holds(t)}`
            : `Amended ${t.date}${t.issue && t.issue !== t.date ? ` (in effect ${t.issue})` : ""}${
                t.sections ? ` — ${t.sections.length} section${t.sections.length === 1 ? "" : "s"}: ${t.sections.join(", ")}` : ""}${
                t.removed ? " — removed" : t.substantive ? " — substantive" : ""}`)
            + " — click to open this version in a new frame beside this one (fetched from ecfr.gov once, then kept)";
        return `<button class="ecfr-tick ${t.kind} ${showing.has(t.id) ? "on" : ""} ${t.removed ? "removed" : ""}"
            data-id="${escAttr(t.id)}" data-date="${escAttr(t.date)}" title="${escAttr(title)}"
            onclick="ecfrOpenVersionFrame(${escJs(t.id)})">
            <span class="ecfr-tick-mark"></span><span class="ecfr-tick-label">${esc(label)}</span></button>`;
    }).join("");
    const n = v.versions.length;
    el.innerHTML = `<div class="ecfr-timeline-caption">
            <span class="ecfr-timeline-title">Amendment history${unit ? ` — Subpart ${esc(ecfrUnit.subpart)}, whole subpart` : ""}</span>
            <span class="ecfr-timeline-note">${n} amendment${n === 1 ? "" : "s"} on record since 2017${
                unit ? " across its sections" : ""} · click a date to open that version in a new frame beside this one — fetched from ecfr.gov once, then kept; or pick it from a frame's source menu</span>
            <span class="ecfr-timeline-legend"><i class="lg version"></i>amendment <i class="lg local"></i>Local <i class="lg live"></i>Live${leadLegend}</span>
        </div>
        <div class="ecfr-timeline-rail">${tickHtml}${ecfrTimelineLinksHtml(ticks)}</div>`;
    ecfrLayoutTimeline();
}

// On the rail line itself, a lead from each snapshot back to the amendment
// whose text it holds — the answer to "which of these dates is my Local
// copy?". Amber and dashed for Local, green and dotted for Live. When both
// hold the same amendment the Local lead runs to Local and the Live lead
// carries on from there, so the two never overlap.
function ecfrTimelineLinksHtml(ticks) {
    const local = ticks.find(t => t.kind === "local"), live = ticks.find(t => t.kind === "live");
    const aLocal = local && ecfrAmendmentFor(ticks, local.date);
    const aLive = live && ecfrAmendmentFor(ticks, live.date);
    const lead = (cls, from, to, what, amend) => `<div class="ecfr-tick-link ${cls}" data-from="${escAttr(from.id)}" data-to="${escAttr(to.id)}"
        title="${escAttr(`${what} holds the text as amended ${amend.date}`)}"></div>`;
    let html = "";
    if (aLocal) html += lead("local", aLocal, local, "Local", aLocal);
    if (aLive) html += lead("live", aLocal && aLocal.id === aLive.id ? local : aLive, live, "Live", aLive);
    return html;
}

// A tick opens that version in a reading frame beside the ones you have
// (or swaps the last frame to it when the row is full). A version already
// on screen just gets scrolled to.
function ecfrOpenVersionFrame(id) {
    const source = id.startsWith("version:") ? ecfrVersionSource(id.slice(8)) : id;
    const have = ecfrFrames.findIndex(f => f.source === source);
    if (have >= 0) {
        const fr = document.querySelector(`#ecfr-pane .ecfr-frame[data-frame="${have}"]`);
        if (fr) fr.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
        return;
    }
    if (ecfrFrames.length >= ECFR_MAX_FRAMES) ecfrFrames[ecfrFrames.length - 1] = { source };
    else ecfrFrames.push({ source });
    renderEcfrReader();
    ecfrLoadFrames();
}

// Ticks sit where their dates fall along the rail, but never closer than a
// label's width: a run of amendments weeks apart on a ten-year rail would
// otherwise print on top of each other. Pixels, measured, so the minimum
// gap is real; the rail grows (and scrolls) when the ticks need more room.
const ECFR_TICK_GAP = 84;

function ecfrLayoutTimeline() {
    const rail = document.querySelector("#ecfr-timeline .ecfr-timeline-rail");
    if (!rail) return;
    const ticks = [...rail.querySelectorAll(".ecfr-tick")];
    if (!ticks.length) return;
    const dates = ticks.map(t => Date.parse(t.dataset.date));
    const t0 = dates[0], span = Math.max(dates[dates.length - 1] - t0, 1);
    const pad = ECFR_TICK_GAP / 2;
    const need = pad * 2 + (ticks.length - 1) * ECFR_TICK_GAP;
    const box = rail.parentElement, cs = getComputedStyle(box);
    const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const width = Math.max(avail, need);           // wider than the box only when the ticks need it
    rail.style.width = `${width}px`;
    const inner = width - pad * 2;
    const xs = dates.map(d => pad + inner * (d - t0) / span);
    for (let i = 1; i < xs.length; i++) xs[i] = Math.max(xs[i], xs[i - 1] + ECFR_TICK_GAP);     // push right
    xs[xs.length - 1] = Math.min(xs[xs.length - 1], width - pad);                               // the end stays on the rail…
    for (let i = xs.length - 2; i >= 0; i--) xs[i] = Math.min(xs[i], xs[i + 1] - ECFR_TICK_GAP);  // …and the rest keep their gap
    const shift = Math.max(0, pad - xs[0]);
    ticks.forEach((t, i) => { t.style.left = `${(xs[i] + shift).toFixed(1)}px`; });
    const xOf = {};
    ticks.forEach((t, i) => { xOf[t.dataset.id] = xs[i] + shift; });
    rail.querySelectorAll(".ecfr-tick-link").forEach(l => {
        const a = xOf[l.dataset.from], b = xOf[l.dataset.to];
        if (a === undefined || b === undefined || b <= a) { l.style.display = "none"; return; }
        l.style.left = `${a.toFixed(1)}px`;
        l.style.width = `${(b - a).toFixed(1)}px`;
    });
}

window.addEventListener("resize", () => { clearTimeout(window._ecfrTlResize);
    window._ecfrTlResize = setTimeout(ecfrLayoutTimeline, 120); });

// One entry per open frame. The layout persists across section navigation.
// More than two is the point: three frames sit at ~2.5 visible and the row
// scrolls horizontally, so versions can be lined up side by side.
const ECFR_MAX_FRAMES = 6;
let ecfrFrames = [{ source: "local" }];

// Index of the frame currently being dragged, or null. Also the guard that
// tells our dragover handler to ignore drags that aren't ours (a text
// selection dragged across the pane fires the same events).
let ecfrDragFrame = null;

async function goEcfr() {
    showScreen("ecfr");
    if (ecfrCurrentKey) {
        renderEcfrReader();
    } else {
        await renderEcfrDashboard();
    }
}

// --- Dashboard ---

async function renderEcfrDashboard() {
    ecfrCurrentKey = null;
    ecfrSection = null;
    const container = document.getElementById("ecfr-workspace");
    if (!container) return;
    container.innerHTML = `<p class="hint" style="padding:20px;">Loading eCFR corpus status…</p>`;
    try {
        const [statusRes, favRes] = await Promise.all([
            fetch(`${API_BASE}/api/ecfr/status`),
            fetch(`${API_BASE}/api/ecfr/favorites`),
        ]);
        if (!statusRes.ok) throw new Error(`HTTP ${statusRes.status}`);
        ecfrStatus = await statusRes.json();
        if (favRes.ok) { ecfrFavorites = await favRes.json(); ecfrFavoritesLoaded = true; }
        ecfrSyncFavKeys();
    } catch (err) {
        console.error("Error loading eCFR status:", err);
        container.innerHTML = `<p class="hint" style="padding:20px;">Couldn't load the eCFR corpus status.</p>`;
        return;
    }
    paintEcfrDashboard();
    // Non-forced: the backend only actually hits ecfr.gov if the cached
    // check is >24h old (or missing) — otherwise this just re-reads the
    // cache, so it's safe to fire on every dashboard open.
    if (ecfrStatus.present) ecfrCheckUpdates(false);
}

function paintEcfrDashboard() {
    const container = document.getElementById("ecfr-workspace");
    if (!container) return;
    const s = ecfrStatus || {};

    let html = `<div class="home-title">${wsGlyph("ecfr")}eCFR — Title 40 Air Regulations</div>`;

    if (!s.present) {
        html += `<div class="fac-table-card"><div style="padding:20px;">
            <p class="hint">No local eCFR corpus has been imported yet. From the project
            root, run:</p>
            <pre class="ecfr-code">ecfr-reader fetch, then ecfr-reader import</pre>
            <p class="hint">This reads the Title 40 parts 50–99 XML already in
            <code>data/reference/federal/title40/</code> into a local
            <code>data/ecfr.db</code> — it does not touch the network.</p>
        </div></div>`;
        container.innerHTML = html;
        return;
    }

    html += `<div class="kpis">
        <div class="kpi" title="The eCFR as it stood on this date, downloaded by ecfr_reader fetch. The eCFR has no releases — it is amended continuously — so a snapshot is a picture taken on a day; fetch again to take a newer one."><div class="kpi-label">Local Snapshot</div>
            <div class="kpi-value">${esc(s.snapshot_date || "—")}</div>
            <div class="kpi-sub">the eCFR as of that day · Title 40, parts ${esc(s.parts || "50-99")}</div></div>
        <div class="kpi"><div class="kpi-label">Sections &amp; Appendices</div>
            <div class="kpi-value">${(s.section_count || 0).toLocaleString()}</div>
            <div class="kpi-sub">across ${s.part_count || 0} parts</div></div>
        <div class="kpi"><div class="kpi-label">Imported</div>
            <div class="kpi-value" style="font-size:16px;">${esc(fmtDate(s.imported_at))}</div>
            <div class="kpi-sub">local import timestamp</div></div>
        <div class="kpi" id="ecfr-update-kpi"><div class="kpi-label">Upstream</div>
            <div class="kpi-value" style="font-size:16px;">${ecfrUpdateSummary(s)}</div>
            <div class="kpi-sub">${s.last_check_at ? "last checked " + esc(fmtDate(s.last_check_at)) : "not checked yet"}</div></div>
    </div>
    <div class="home-toolbar">
        <button class="btn btn-primary" onclick="openEcfrReader()">Browse Title 40 →</button>
    </div>
    <div class="home-toolbar ecfr-update-toolbar">
        <button class="btn" onclick="ecfrCheckUpdates(true)" id="ecfr-check-btn">Check for updates</button>
        <span class="hint">Notify-only — refreshing the corpus is a manual
            script run (<code>ecfr-reader fetch, then ecfr-reader import</code>), never automatic.</span>
    </div>`;

    html += ecfrUpdateCardHtml(s);
    html += ecfrFavoritesCardHtml();
    container.innerHTML = html;
}

// The dashboard's jump-back list. Every node type, not just sections —
// a starred subpart is as much a place you want to get back to.
function ecfrFavoritesCardHtml() {
    if (!ecfrFavorites.length) return "";
    const typeLabel = { part: "Part", subpart: "Subpart", section: "Section" };
    return `<div class="comp-section-head">Favorites</div>
    <div class="fac-table-card"><table class="fac-table"><thead><tr>
        <th>Type</th><th>Citation</th><th>Name</th>
    </tr></thead><tbody>
    ${ecfrFavorites.map(f => `<tr onclick="openEcfrFavorite(${escJs(f.node_type)}, ${escJs(f.node_key)})">
        <td class="muted">${esc(typeLabel[f.node_type] || f.node_type)}</td>
        <td class="muted">${esc(f.citation || "")}</td>
        <td><div class="fac-name">${esc(f.label || f.node_key)}</div></td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

// One entry point for "go to whatever this favorite points at". Sections
// open directly; a subpart expands its part and opens its first section;
// a part expands and scrolls to its anchor.
// A favorite does two things: opens the node in the reader, and brings its
// row into view in the tree below — the star is a bookmark into the
// contents as much as into the text.
async function openEcfrFavorite(nodeType, nodeKey) {
    if (nodeType === "section") {
        await openEcfrSection(nodeKey);
        ecfrRevealInToc(`.ecfr-toc-section[data-key="${CSS.escape(nodeKey)}"], .ecfr-toc-appendix[data-key="${CSS.escape(nodeKey)}"]`);
        return;
    }
    if (nodeType === "subpart") {
        const [part, code] = nodeKey.split("/");
        await openEcfrSubpart(part, code);
        ecfrRevealInToc(`.ecfr-toc-subpart[data-subpart="${CSS.escape(nodeKey)}"] > summary`);
        return;
    }
    await openEcfrPart(nodeKey);
}

// Scroll the tree so the row matching `selector` sits in view, once the
// tree has painted it (the part expands and re-renders on open).
function ecfrRevealInToc(selector) {
    const tree = document.querySelector("#ecfr-toc-tree .ecfr-toc-root");
    const row = tree && tree.querySelector(selector);
    if (!row) return;
    const open = row.closest("details.ecfr-toc-subpart");
    if (open) open.open = true;
    row.scrollIntoView({ block: "center", behavior: "smooth" });
}

function ecfrUpdateSummary(s) {
    if (!s.last_check) return "Not checked";
    if (s.last_check.up_to_date) return "Up to date";
    const n = (s.last_check.changed_parts || []).length;
    return n ? `${n} part${n === 1 ? "" : "s"} changed` : "Unknown";
}

// Filled in by the update-check card (see ecfrCheckUpdates below); returns
// "" until a check has ever run so the dashboard doesn't show a stale card.
let ecfrUpdateError = null;     // why the last update check failed (shown in the card, not a toast)

function ecfrUpdateCardHtml(s) {
    const base = _ecfrUpdateCardHtml(s);
    if (!ecfrUpdateError) return base;
    return base + `<p class="hint ecfr-update-error" style="text-align:left;margin:6px 0 0;">${esc(ecfrUpdateError)}</p>`;
}

function _ecfrUpdateCardHtml(s) {
    if (!s.last_check) return "";
    const lc = s.last_check;
    if (lc.up_to_date) {
        return `<div class="fac-table-card"><p class="hint" style="padding:16px;">
            eCFR title 40 is current to ${esc(lc.latest || s.snapshot_date)} — matches the local
            snapshot. No action needed.</p></div>`;
    }
    const parts = lc.changed_parts || [];
    if (!parts.length) {
        return `<div class="fac-table-card"><p class="hint" style="padding:16px;">
            eCFR title 40 is now current to ${esc(lc.latest || "")}, ahead of the local snapshot
            (${esc(s.snapshot_date || "")}), but no changes fall within parts 50–99.</p></div>`;
    }
    return `<div class="comp-section-head">Upstream changes since ${esc(s.snapshot_date || "")}
        <span class="comp-section-sub">eCFR is current to ${esc(lc.latest || "")} — re-run the
        import after refreshing the source XML to pick these up</span></div>
    <div class="fac-table-card"><table class="fac-table"><thead><tr>
        <th>Part</th><th>Sections changed</th><th>Amended</th>
    </tr></thead><tbody>
    ${parts.map(p => `<tr>
        <td>Part ${esc(p.part)}</td>
        <td>${p.count} (${esc((p.sample || []).join(", "))}${p.count > (p.sample || []).length ? " …" : ""})</td>
        <td class="muted">${esc(p.dates || "")}</td>
    </tr>`).join("")}
    </tbody></table></div>`;
}

async function ecfrCheckUpdates(force) {
    const btn = document.getElementById("ecfr-check-btn");
    if (btn) { btn.disabled = true; btn.textContent = "Checking…"; }
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/updates${force ? "?force=1" : ""}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        if (ecfrStatus) {
            ecfrStatus.last_check = d;
            ecfrStatus.last_check_at = d.checked_at || ecfrStatus.last_check_at;
        }
        ecfrUpdateError = null;
        paintEcfrDashboard();
        if (d.stale) toast("eCFR.gov didn't respond — showing the last cached check.", "error");
    } catch (err) {
        // The reason lands in the card (an unset ECFR_CONTACT is the usual
        // one on a first run); a toast only when you asked for the check.
        ecfrUpdateError = err.message || "Couldn't check ecfr.gov for updates.";
        paintEcfrDashboard();
        if (force) toast("Couldn't check ecfr.gov for updates.");
        if (btn) { btn.disabled = false; btn.textContent = "Check for updates"; }
    }
}

// --- Reader ---

async function openEcfrReader() {
    showScreen("ecfr");
    if (!ecfrCurrentKey) {
        renderEcfrReaderShell();
        // Nothing open yet: the panel shows everything marked across Title 40.
        ecfrLoadPanel("title");
        ecfrEnsureFavorites().then(renderEcfrAnnotationsPanel);
    }
}

// Loads the annotations panel at `scope`. Section scope reuses the payload
// the annotator already has rather than refetching it.
async function ecfrLoadPanel(scope) {
    ecfrScope = scope;
    ecfrHighlightEditingId = null;
    if (scope === "section" && ecfrAnnotations) {
        ecfrPanel = ecfrAnnotations;
        renderEcfrAnnotationsPanel();
        return;
    }
    ecfrPanelLoading = true;
    renderEcfrAnnotationsPanel();
    try {
        const params = new URLSearchParams({ scope });
        if (ecfrCurrentKey) params.set("key", ecfrCurrentKey);
        const res = await fetch(`${API_BASE}/api/ecfr/annotations?${params.toString()}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        if (ecfrScope !== scope) return;   // a faster click won
        ecfrPanel = d;
    } catch (err) {
        console.error("Error loading annotations:", err);
        toast("Couldn't load annotations for that scope.");
    } finally {
        ecfrPanelLoading = false;
        renderEcfrAnnotationsPanel();
    }
}

function ecfrSetScope(scope) {
    if (scope === ecfrScope) return;
    ecfrLoadPanel(scope);
}

// --- Keeping the two lists in step -----------------------------------
// ecfrAnnotations (the section, what the annotator anchors) and ecfrPanel
// (what's on screen) are the same object at section scope and different
// objects at any wider one. Mutations go through these so both stay right.

function ecfrStores() {
    const stores = [];
    if (ecfrAnnotations) stores.push(ecfrAnnotations);
    if (ecfrPanel && ecfrPanel !== ecfrAnnotations) stores.push(ecfrPanel);
    return stores;
}

function ecfrUpsertRow(kind, row) {
    ecfrStores().forEach(store => {
        const list = store[kind];
        if (!list) return;
        const i = list.findIndex(r => r.id === row.id);
        if (i >= 0) list[i] = Object.assign({}, list[i], row);
        else list.push(row);       // always the open section, so it's in every scope
    });
}

function ecfrRemoveRow(kind, id) {
    ecfrStores().forEach(store => {
        if (store[kind]) store[kind] = store[kind].filter(r => r.id !== id);
    });
}

// Anything added to or removed from the open section also lands inside the
// subpart, part and title above it — so every counter moves together.
function ecfrBumpCounts(kind, delta) {
    ecfrStores().forEach(store => {
        if (!store.counts) return;
        Object.keys(store.counts).forEach(scope => {
            if (scope === "subpart" && !store.subpart) return;
            store.counts[scope][kind] = Math.max(0, (store.counts[scope][kind] || 0) + delta);
        });
    });
}

// Which unit a section belongs to. Reads the part's TOC, so it needs
// loadEcfrPart() to have run — the same grouping the sidebar shows, because a
// reader that disagreed with the tree about what a subpart contains would be
// worse than no grouping at all.
function ecfrUnitOf(key) {
    const part = key.split(":")[0];
    const cached = ecfrPartCache[part];
    if (!cached) return null;
    const sec = (cached.sections || []).find(s => s.section_key === key);
    if (!sec) return null;
    if (sec.subpart) return { part, subpart: sec.subpart, appendix: null };
    if (sec.type === "appendix") return { part, subpart: null, appendix: sec.identifier };
    return { part, subpart: null, appendix: null };      // the part's loose sections
}

function ecfrSameUnit(a, b) {
    return !!a && !!b && a.part === b.part && a.subpart === b.subpart
        && a.appendix === b.appendix;
}

// "<part>/<subpart>" for a subpart unit (the favorites' node_key form, and
// the hash's), null for an appendix or loose sections.
function ecfrUnitId(unit = ecfrUnit) {
    return unit && unit.subpart ? `${unit.part}/${unit.subpart}` : null;
}

function ecfrUnitFocused() {
    return ecfrFocus === "unit" && !!ecfrUnitId();
}

// The focus changed without the unit changing (the subpart heading clicked
// while one of its sections was open, or the reverse): everything that reads
// the focus repaints, nothing is refetched.
function ecfrApplyFocus() {
    syncHash(false);
    renderEcfrToc();
    ecfrRenderPaneTabs();
    ecfrEnsureTimeline();
    if (ecfrPaneTab === "compare" && typeof cmpShow === "function") cmpShow();
}

// Open a section: make sure its UNIT is on screen, then go to it.
//
// The unit is the page now, so clicking a sibling section is a scroll, not a
// reload — which is the whole point. Only crossing into another unit fetches.
async function openEcfrSection(key, opts = {}) {
    if (!key) return;
    showScreen("ecfr");
    const refocused = !opts.keepFocus && ecfrFocus !== "section";
    if (!opts.keepFocus) ecfrFocus = "section";
    const part = key.split(":")[0];
    ecfrCurrentPart = part;
    ecfrExpanded.add(part);
    ecfrNoteEditingId = null;

    // Already showing the unit that holds it? Then this is just a scroll.
    // Without this early-out every TOC click would refetch, re-render and
    // re-attach every annotator — the thing that made navigation feel clunky.
    // "Showing" means the reader is on screen: a cached unit behind the
    // dashboard (back to a section from #ecfr) still needs the full paint.
    if (ecfrLocalCache[key] && ecfrSameUnit(ecfrUnit, ecfrUnitOf(key))
            && document.querySelector(".ecfr-reader")) {
        await ecfrSetCurrentSection(key, { scroll: true });
        if (refocused) ecfrApplyFocus();
        return;
    }

    ecfrLoading = true;
    renderEcfrReaderShell();  // paint the sidebar/shell immediately, pane shows a spinner
    try {
        await loadEcfrPart(part);
        const unit = ecfrUnitOf(key);
        if (!unit) throw new Error(`${key} is not in part ${part}'s table of contents`);
        await Promise.all([
            ecfrLoadUnit(unit),
            ecfrEnsureStatus(),  // the local frame's header names the snapshot date,
                                 // which a deep link into the reader hasn't loaded yet
            ecfrEnsureFavorites(),
        ]);
        if (!ecfrLocalCache[key]) throw new Error(`${key} was not in its own unit`);
    } catch (err) {
        console.error("Error loading eCFR section:", err);
        toast(`Couldn't load ${key}.`);
        ecfrUnit = null;
        ecfrUnitSections = [];
        ecfrSection = null;
        ecfrCurrentKey = null;
        ecfrAnnotations = null;
        ecfrPanel = null;
        ecfrLoading = false;
        renderEcfrReader();
        return;
    }
    ecfrLoading = false;
    await ecfrSetCurrentSection(key, { scroll: true, render: true });
}

// Fetch one unit's sections, with blocks, in document order.
async function ecfrLoadUnit(unit) {
    const params = new URLSearchParams({ part: unit.part });
    if (unit.subpart) params.set("subpart", unit.subpart);
    else if (unit.appendix) params.set("appendix", unit.appendix);

    ecfrUnitLoading = true;
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/unit?${params.toString()}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        // A new unit replaces the cache rather than growing it: keeping every
        // unit you ever visited would pile the whole corpus into memory a
        // subpart at a time.
        ecfrLocalCache = {};
        (d.sections || []).forEach(s => { ecfrLocalCache[s.section_key] = s; });
        ecfrUnitSections = d.sections || [];
        ecfrUnit = unit;
        ecfrUnitHeading = d.heading || "";
    } finally {
        ecfrUnitLoading = false;
    }
    ecfrLoadProposals(unit.part);      // the proposals that cover this part, for the pickers
}

// Point the panel, the star and the URL at one section of
// the loaded unit. This is what "the current section" means now — it changes
// as you scroll, without anything being fetched or re-rendered.
async function ecfrSetCurrentSection(key, opts = {}) {
    const changed = ecfrCurrentKey !== key;
    ecfrCurrentKey = key;
    ecfrSection = ecfrLocalCache[key] || null;
    ecfrCurrentPart = key.split(":")[0];
    if (opts.render) renderEcfrReader();
    if (opts.scroll) ecfrScrollToSection(key);
    if (!changed && !opts.render) return;

    syncHash(false);
    if (!opts.render) renderEcfrToc();          // move the .current highlight
    if (ecfrPaneTab === "compare" && typeof cmpShow === "function") cmpShow();   // the Compare tab follows the section
    await ecfrLoadSectionSidecars(key);
}

// The per-section extra: its annotations. Kept out of the unit fetch
// because they follow the section you're reading, not the unit you loaded.
async function ecfrLoadSectionSidecars(key) {
    ecfrEnsureTimeline();                       // in parallel; it paints itself
    const annRes = await fetch(`${API_BASE}/api/ecfr/annotations?scope=section&key=${encodeURIComponent(key)}`)
        .catch(() => null);
    if (ecfrCurrentKey !== key) return;         // a faster scroll won
    ecfrAnnotations = (annRes && annRes.ok) ? await annRes.json()
        : { notes: [], highlights: [], counts: null, favorited: false, favorite_id: null };
    // Orphans belong to the section we just left. The attach below refills
    // this for the new one — but only if it HAS rows, so without clearing
    // here a §60.112b orphan would follow you into part 77 and claim to be
    // unlocatable in text it was never part of.
    ecfrOrphanedHighlights = [];
    // Reading a section narrows the panel to it, whatever was showing before.
    ecfrScope = "section";
    ecfrPanel = ecfrAnnotations;
    renderEcfrAnnotationsPanel();

    // Rebind this section's annotators now that its rows are here. The
    // observer attaches as soon as a section's TEXT lands, which is well
    // before this fetch returns — so without this the marks would be bound to
    // an empty row set and simply never appear.
    ecfrFrames.forEach((f, i) => {
        if (!ecfrAnnotators.has(ecfrAnnKey(i, key))) return;
        ecfrDetachSectionAnnotator(i, key);
        ecfrAttachSectionAnnotator(i, key);
    });

    ecfrLoadFrames();     // let any live frame fetch this section's upstream text
}

// Put EVERY frame on the section, not just the first.
//
// Frames scroll independently once you're reading — that's deliberate — but
// they have to START on the same section, or opening Compare shows you
// §60.112b beside §60.110b and invites you to compare two different rules.
// It only became possible to get this wrong when live frames started holding
// the whole unit too; before that they had one section and no choice.
function ecfrScrollToSection(key) {
    document.querySelectorAll(
        `#ecfr-pane .ecfr-section[data-section-key="${CSS.escape(key)}"]`)
        .forEach(el => el.scrollIntoView({ block: "start" }));
}

// The TOC's stars and the panel's Favorites list both need these; a deep
// link into a section never passes through the dashboard, which used to be
// the only loader.
async function ecfrEnsureFavorites() {
    if (ecfrFavoritesLoaded) return ecfrFavorites;
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/favorites`);
        if (res.ok) {
            ecfrFavorites = await res.json();
            ecfrFavoritesLoaded = true;
            ecfrSyncFavKeys();
        }
    } catch (err) {
        console.error("Error loading eCFR favorites:", err);
    }
    return ecfrFavorites;
}

// Status carries the snapshot date the local frame header shows. Cheap and
// cached in ecfrStatus; only ever fetched once per session.
async function ecfrEnsureStatus() {
    if (ecfrStatus) return ecfrStatus;
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/status`);
        if (res.ok) ecfrStatus = await res.json();
    } catch (err) {
        console.error("Error loading eCFR status:", err);
    }
    return ecfrStatus;
}

// Live text for one section — but fetched a SUBPART at a time.
//
// the author's call, and it's what makes a live frame able to show a unit at all.
// One section per request meant ~23 requests to ecfr.gov for one screenful,
// which they answer with HTTP 429 and deserve to. The versioner's /full
// endpoint takes `subpart` directly, so the whole subpart is ONE request
// (~130 KB, <1s) and fills the cache for every section in it at once.
//
// Only subparts. An appendix is a single section, and a part's loose sections
// aren't a division ecfr.gov knows about — for those the per-section fetch IS
// one request, so there's nothing to save.
let ecfrLiveUnitFetches = {};       // "part/subpart" -> in-flight promise

async function ecfrEnsureLiveData(key) {
    if (ecfrLiveCache[key]) return ecfrLiveCache[key];

    const unit = ecfrUnitOf(key);
    if (unit && unit.subpart) {
        const id = `${unit.part}/${unit.subpart}`;
        // De-dupe: the observer can ask for six sections of the same subpart
        // in one tick, and six identical 130 KB requests is exactly the
        // behaviour this replaced.
        if (!ecfrLiveUnitFetches[id]) {
            ecfrLiveUnitFetches[id] = ecfrFetchLiveUnit(unit)
                .finally(() => { delete ecfrLiveUnitFetches[id]; });
        }
        await ecfrLiveUnitFetches[id];
        if (ecfrLiveCache[key]) return ecfrLiveCache[key];
        // Fell through: the subpart fetch failed or didn't contain it. The
        // per-section path below is the honest fallback.
    }
    return ecfrEnsureLiveSection(key);
}

async function ecfrFetchLiveUnit(unit) {
    const params = new URLSearchParams({ part: unit.part, subpart: unit.subpart });
    const res = await fetch(`${API_BASE}/api/ecfr/unit/live?${params.toString()}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    (d.sections || []).forEach(s => { ecfrLiveCache[s.section_key] = s; });
    return d;
}

async function ecfrEnsureLiveSection(key) {
    if (ecfrLiveCache[key]) return ecfrLiveCache[key];
    const res = await fetch(`${API_BASE}/api/ecfr/section/live?key=${encodeURIComponent(key)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    ecfrLiveCache[key] = d;
    return d;
}

// Loads whatever the currently-open frames need for the current section
// (only live frames actually fetch — the local payload arrives with the
// section itself). Re-renders as each frame resolves.
// Make sure every frame has the CURRENT section's text.
//
// A frame renders a whole unit and the observer fetches each section as you
// reach it — so this is only about the one section you're on right now, which
// has to be there immediately rather than a frame later. Everything else the
// unit needs arrives lazily.
async function ecfrLoadFrames() {
    if (!ecfrCurrentKey) return;
    const key = ecfrCurrentKey;
    await Promise.all(ecfrFrames.map(async (frame) => {
        const src = ECFR_SOURCES[frame.source];
        if (!src || src.data(key)) return;
        frame.error = null;
        try {
            await src.ensure(key);
        } catch (err) {
            console.error(`Error loading eCFR frame source ${frame.source}:`, err);
            toast("Couldn't reach ecfr.gov for the live text.");
            return;
        }
        if (ecfrCurrentKey !== key) return;
        // Fill just this section in each frame rather than re-rendering the
        // pane: a re-render would throw away every other section's filled
        // blocks and re-attach every annotator.
        document.querySelectorAll(
            `#ecfr-pane .ecfr-section[data-section-key="${CSS.escape(key)}"]`)
            .forEach(art => ecfrFillSection(art, key, Number(art.dataset.frame)));
    }));
    // The nav and the headers name versions that only exist once the text
    // has arrived, so they are asked again now.
    ecfrRenderPaneNav();
    ecfrRefreshProvenance();
    ecfrRenderTimeline();          // a version just opened is drawn filled on the rail
}

// A frame header must name the exact version on screen, never just the source
// — that's the whole reason it exists. But the live label only knows its date
// once the text arrives, and the header paints before that: rendered once, it
// would sit there reading "Live ecfr.gov" with no date forever, which is
// exactly the claim it isn't allowed to make.
function ecfrRefreshProvenance() {
    ecfrFrames.forEach((f, i) => {
        const src = ECFR_SOURCES[f.source];
        const el = document.querySelector(
            `#ecfr-pane .ecfr-frame[data-frame="${i}"] .ecfr-frame-provenance`);
        if (!el) return;
        const d = src.data(ecfrCurrentKey);
        el.textContent = src.label(d);
        el.title = src.hint ? src.hint(d) : "";
    });
}

async function loadEcfrPart(part) {
    if (ecfrPartCache[part]) return ecfrPartCache[part];
    const res = await fetch(`${API_BASE}/api/ecfr/toc/${encodeURIComponent(part)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    ecfrPartCache[part] = d;
    return d;
}

async function ecfrToggleTocPart(part) {
    if (ecfrExpanded.has(part)) {
        ecfrExpanded.delete(part);
        renderEcfrReader();
        return;
    }
    ecfrExpanded.add(part);
    renderEcfrReader();  // show it expanded (with a loading row) right away
    try {
        await loadEcfrPart(part);
        renderEcfrReader();
    } catch (err) {
        toast(`Couldn't load part ${part}'s table of contents.`);
        ecfrExpanded.delete(part);
        renderEcfrReader();
    }
}

function renderEcfrReaderShell() {
    const container = document.getElementById("ecfr-workspace");
    if (!container) return;
    if (!container.querySelector(".ecfr-reader")) {
        container.innerHTML = `<div class="ecfr-reader">
            <div class="ecfr-toc" id="ecfr-toc"></div>
            <div class="ecfr-toc-resizer" title="Drag to resize the contents; double-click to reset"
                onpointerdown="ecfrTocResizeStart(event)" ondblclick="ecfrTocResize(null)"></div>
            <div class="ecfr-pane" id="ecfr-pane"></div>
            <div class="ecfr-annotations" id="ecfr-annotations"></div>
        </div>`;
        const saved = ecfrTocWidth();
        if (saved) ecfrTocResize(saved);
    }
    renderEcfrReader();
}

// --- The contents rail's width ----------------------------------------
// Dragged from its right edge and remembered; null is the stylesheet's
// default. Headings in the tree are long ("Subpart OOOOb—Standards of
// Performance for Crude Oil and Natural Gas Facilities for Which…"), and
// how much of them you want to see depends on the window.
const ECFR_TOC_MIN = 220;

function ecfrTocWidth() {
    try { const w = Number(localStorage.getItem("ecfr.tocWidth")); return w >= ECFR_TOC_MIN ? w : null; }
    catch (e) { return null; }
}

function ecfrTocResize(px) {
    const reader = document.querySelector(".ecfr-reader");
    if (!reader) return;
    if (px === null) {
        reader.style.removeProperty("--toc-w");
        try { localStorage.removeItem("ecfr.tocWidth"); } catch (e) { /* private mode */ }
        return;
    }
    const w = Math.round(Math.max(ECFR_TOC_MIN, Math.min(px, window.innerWidth * 0.6)));
    reader.style.setProperty("--toc-w", `${w}px`);
    try { localStorage.setItem("ecfr.tocWidth", String(w)); } catch (e) { /* private mode */ }
}

function ecfrTocResizeStart(e) {
    const toc = document.getElementById("ecfr-toc");
    if (!toc || e.button !== 0) return;
    e.preventDefault();
    const left = toc.getBoundingClientRect().left;
    const handle = e.currentTarget;
    handle.classList.add("dragging");
    document.body.classList.add("ecfr-resizing");
    const move = ev => ecfrTocResize(ev.clientX - left);
    const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        handle.classList.remove("dragging");
        document.body.classList.remove("ecfr-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
}

function renderEcfrReader() {
    const container = document.getElementById("ecfr-workspace");
    if (!container || !container.querySelector(".ecfr-reader")) {
        renderEcfrReaderShell();
        return;
    }
    renderEcfrToc();
    renderEcfrPane();
    renderEcfrAnnotationsPanel();
}

function renderEcfrToc() {
    const el = document.getElementById("ecfr-toc");
    if (!el) return;
    if (!ecfrPartsList) {
        el.innerHTML = `<p class="hint" style="padding:12px;">Loading table of contents…</p>`;
        fetch(`${API_BASE}/api/ecfr/toc`).then(r => r.json()).then(d => {
            ecfrPartsList = d.parts || [];
            renderEcfrToc();
        }).catch(() => { el.innerHTML = `<p class="hint" style="padding:12px;">Couldn't load parts.</p>`; });
        return;
    }

    const rows = ecfrPartsList.map(p => {
        const isOpen = ecfrExpanded.has(p.part);
        const cached = ecfrPartCache[p.part];
        let children = "";
        if (isOpen) {
            if (!cached) {
                children = `<div class="ecfr-toc-loading">Loading…</div>`;
            } else {
                children = ecfrTocSections(cached);
            }
        }
        const hasFavBelow = ecfrFavDescendants(p.part);
        return `<div class="ecfr-toc-part" id="ecfr-part-${escAttr(p.part)}">
            <div class="ecfr-toc-row">
                <button class="ecfr-toc-part-head ${p.part === ecfrCurrentPart ? "current" : ""}"
                    onclick="ecfrToggleTocPart(${escJs(p.part)})">
                    <span class="ecfr-toc-caret">${isOpen ? "▾" : "▸"}</span>
                    <span class="ecfr-toc-num">Part ${esc(p.part)}</span>
                    <span class="ecfr-toc-title">${esc(ecfrPartSubject(p.heading))}</span>
                    ${hasFavBelow ? `<span class="ecfr-fav-below" title="Contains favorites">●</span>` : ""}
                </button>
                ${ecfrStarHtml("part", p.part)}
            </div>
            ${isOpen ? `<div class="ecfr-toc-children">${children}</div>` : ""}
        </div>`;
    }).join("");

    // Searching replaces the tree rather than filtering it: a hit list across
    // 10,812 sections has no useful shape as a tree.
    const hidden = ecfrSearching() ? ` style="display:none;"` : "";
    const searchState = ecfrCaptureSearchInput();   // before the innerHTML below
    // The tree is rebuilt on every navigation, which would put its scroll
    // back at the top — and part 60 is a long way down. Remember where each
    // scrolling band was and put it back once the new markup is in.
    const scrolled = {};
    el.querySelectorAll(".ecfr-toc-root, .ecfr-toc-favs, #ecfr-search-results").forEach(n => {
        if (n.scrollTop) scrolled[n.className || n.id] = n.scrollTop;
    });
    // The whole tree collapses, so a long favorites list can own the sidebar.
    el.innerHTML = ecfrSearchBarHtml()
        + `<div id="ecfr-search-results">${ecfrSearchResultsHtml()}</div>`
        + `<div id="ecfr-toc-tree"${hidden}>`
        + ecfrFavoritesGroupHtml()
        + `<details class="ecfr-toc-root" ${ecfrTocRootOpen ? "open" : ""}
             ontoggle="ecfrTocRootToggled(this.open)">
            <summary class="ecfr-toc-head">Title 40 — Parts 50–99${
                ecfrFavKeys.size ? ` <span class="ecfr-fav-below" title="Contains favorites">●</span>` : ""}</summary>
            ${rows}
        </details></div>`;
    ecfrRestoreSearchInput(searchState);
    el.querySelectorAll(".ecfr-toc-root, .ecfr-toc-favs, #ecfr-search-results").forEach(n => {
        const top = scrolled[n.className || n.id];
        if (top) n.scrollTop = top;
    });
}

// --- Search UI -------------------------------------------------------

function ecfrSearchBarHtml() {
    return `<div class="ecfr-search">
        <input type="search" id="ecfr-search-input" class="ecfr-search-input"
            placeholder="Search Title 40…" autocomplete="off"
            value="${escAttr(ecfrSearchQuery)}"
            oninput="ecfrSearchInput(this.value)">
        ${ecfrSearching() ? `<button class="ecfr-search-x" title="Clear search"
            onclick="ecfrClearSearch()">✕</button>` : ""}
    </div>`;
}

// The TOC re-renders for reasons that have nothing to do with typing — a
// star toggle, a section opening — and it rebuilds the input along with
// everything else. Losing focus mid-word would be maddening, so read the
// live caret straight off the DOM immediately before the innerHTML and put
// it back after.
//
// Read, don't cache: arrow keys, clicks and selections all move the caret
// without firing `input`, so a value stashed at keystroke time is stale the
// moment the user does anything else.
function ecfrCaptureSearchInput() {
    const input = document.getElementById("ecfr-search-input");
    if (!input) return null;
    return { focused: document.activeElement === input, caret: input.selectionStart };
}

function ecfrRestoreSearchInput(state) {
    if (!state || !state.focused) return;
    const input = document.getElementById("ecfr-search-input");
    if (!input) return;
    input.focus();
    if (state.caret != null) {
        try { input.setSelectionRange(state.caret, state.caret); } catch (e) {}
    }
}

function ecfrSearchInput(value) {
    ecfrSearchQuery = value;
    clearTimeout(ecfrSearchTimer);
    const q = value.trim();
    if (q.length < ECFR_SEARCH_MIN) {
        // Below the threshold, drop back to the tree — but don't fire a query.
        ecfrSearchResults = null;
        ecfrSearchTotal = 0;
        ecfrSearchSeq++;                    // orphan any in-flight response
        ecfrPaintSearch();
        return;
    }
    ecfrSearchTimer = setTimeout(() => ecfrRunSearch(0), 300);
}

async function ecfrRunSearch(offset) {
    const q = ecfrSearchQuery.trim();
    if (q.length < ECFR_SEARCH_MIN) return;
    const seq = ++ecfrSearchSeq;
    ecfrSearchLoading = true;
    ecfrPaintSearch();
    try {
        const params = new URLSearchParams({ q, limit: ECFR_SEARCH_PAGE, offset });
        const res = await fetch(`${API_BASE}/api/ecfr/search?${params.toString()}`);
        const d = await res.json();
        if (seq !== ecfrSearchSeq) return;   // a later keystroke already won
        if (!res.ok) {
            // 503 = the corpus predates the search index. Say so plainly;
            // it's fixable with one command.
            ecfrSearchResults = [];
            ecfrSearchTotal = 0;
            toast(d.error || `Search failed (HTTP ${res.status}).`);
            return;
        }
        ecfrSearchResults = offset ? (ecfrSearchResults || []).concat(d.results) : d.results;
        ecfrSearchTotal = d.total;
    } catch (err) {
        if (seq !== ecfrSearchSeq) return;
        console.error("Error searching eCFR:", err);
        ecfrSearchResults = [];
        ecfrSearchTotal = 0;
        toast("Couldn't run the search.");
    } finally {
        if (seq === ecfrSearchSeq) {
            ecfrSearchLoading = false;
            ecfrPaintSearch();
        }
    }
}

// Update ONLY the results div and the tree's visibility. Re-rendering the
// whole TOC on every keystroke would rebuild ~2,000 rows and fight the
// caret restore above.
function ecfrPaintSearch() {
    const box = document.getElementById("ecfr-search-results");
    if (box) box.innerHTML = ecfrSearchResultsHtml();
    const tree = document.getElementById("ecfr-toc-tree");
    if (tree) tree.style.display = ecfrSearching() ? "none" : "";
    const bar = document.querySelector(".ecfr-search");
    if (bar) {
        const x = bar.querySelector(".ecfr-search-x");
        if (ecfrSearching() && !x) {
            bar.insertAdjacentHTML("beforeend",
                `<button class="ecfr-search-x" title="Clear search" onclick="ecfrClearSearch()">✕</button>`);
        } else if (!ecfrSearching() && x) {
            x.remove();
        }
    }
}

function ecfrClearSearch() {
    clearTimeout(ecfrSearchTimer);
    ecfrSearchSeq++;
    ecfrSearchQuery = "";
    ecfrSearchResults = null;
    ecfrSearchTotal = 0;
    renderEcfrToc();
}

function ecfrSearchResultsHtml() {
    if (!ecfrSearching()) return "";
    if (ecfrSearchLoading && !ecfrSearchResults.length) {
        return `<p class="hint" style="padding:8px 12px;">Searching…</p>`;
    }
    if (!ecfrSearchResults.length) {
        return `<p class="hint" style="padding:8px 12px;">No sections match
            “${esc(ecfrSearchQuery)}”.</p>`;
    }
    const shown = ecfrSearchResults.length;
    let html = `<div class="ecfr-search-count">${ecfrSearchTotal.toLocaleString()}
        section${ecfrSearchTotal === 1 ? "" : "s"} match${ecfrSearchTotal === 1 ? "es" : ""}</div>`;
    html += ecfrSearchResults.map(r => `<button
        class="ecfr-search-hit ${r.section_key === ecfrCurrentKey ? "current" : ""}"
        title="${escAttr(r.heading || r.section_key)}"
        onclick="openEcfrSection(${escJs(r.section_key)})">
        <span class="ecfr-search-head">${esc(r.heading || r.section_key)}</span>
        <span class="ecfr-search-snip">${ecfrSnippetHtml(r.snippet)}</span>
    </button>`).join("");
    if (shown < ecfrSearchTotal) {
        html += `<button class="ecfr-search-more" ${ecfrSearchLoading ? "disabled" : ""}
            onclick="ecfrRunSearch(${shown})">${ecfrSearchLoading ? "Loading…"
            : `Show more (${(ecfrSearchTotal - shown).toLocaleString()} left)`}</button>`;
    }
    return html;
}

// The server marks hits with \x01/\x02 rather than HTML, so the snippet can
// be escaped FIRST and the tags injected after. Escaping afterwards would
// eat our own <b>; injecting before escaping would let a section containing
// "<script>" write markup into the sidebar.
function ecfrSnippetHtml(snippet) {
    return esc(snippet || "")
        .replaceAll("\u0001", "<b>")
        .replaceAll("\u0002", "</b>");
}

function ecfrTocRootToggled(open) {
    ecfrTocRootOpen = open;      // recorded only — see ecfrAccToggled
}

// A star for any node. Takes ONLY the type and key: no heading text ever
// goes through an attribute, so no escaping question arises. The label is
// looked up from the caches when the star is actually clicked.
// Does anything BELOW this part carry a star? Subpart favorites look like
// "60/JJJJ", section favorites like "60:60.4230" — both prefix on the
// part id. (The part's own star shows on its row already; this marker is
// strictly "there are favorites inside".)
function ecfrFavDescendants(part) {
    for (const k of ecfrFavKeys) {
        if (k.startsWith(part + "/") || k.startsWith(part + ":")) return true;
    }
    return false;
}

function ecfrStarHtml(nodeType, a, b) {
    const key = ecfrFavKey(nodeType, a, b);
    const on = ecfrFavKeys.has(key);
    // A <span role=button>, not a <button>: subpart stars live inside a
    // <summary> and section/part stars sit next to a button — nesting one
    // button inside another is invalid HTML and swallows the click.
    return `<span role="button" tabindex="0" class="ecfr-star ${on ? "on" : ""}"
        title="${on ? "Remove from favorites" : "Add to favorites"}"
        onclick="event.stopPropagation(); event.preventDefault(); ecfrToggleFavorite(${escJs(nodeType)}, ${escJs(key)})"
        >${on ? "★" : "☆"}</span>`;
}

// Starred nodes, pinned above the tree — the point of the whole feature is
// that the eight parts you actually work in aren't 50 rows apart.
function ecfrFavoritesGroupHtml() {
    if (!ecfrFavorites.length) return "";
    const icon = { part: "▣", subpart: "◈", section: "§" };
    const rows = ecfrFavorites.map(f => `<div class="ecfr-toc-row">
        <button class="ecfr-toc-fav ${f.node_key === ecfrCurrentKey ? "current" : ""}"
            title="${escAttr(f.citation || f.node_key)}"
            onclick="openEcfrFavorite(${escJs(f.node_type)}, ${escJs(f.node_key)})">
            <span class="ecfr-toc-fav-icon">${esc(icon[f.node_type] || "§")}</span>
            <span class="ecfr-toc-fav-label">${esc(f.label || f.node_key)}</span>
        </button>
        ${f.node_type === "subpart"
            ? ecfrStarHtml("subpart", ...f.node_key.split("/"))
            : ecfrStarHtml(f.node_type, f.node_key)}
    </div>`).join("");
    return `<details class="ecfr-toc-favs" ${ecfrFavsGroupOpen ? "open" : ""}
        ontoggle="ecfrFavsGroupToggled(this.open)">
        <summary class="ecfr-toc-head"><span style="color:var(--star)">★</span>&nbsp;Favorites<span
            class="ecfr-acc-n">${ecfrFavorites.length}</span></summary>
        ${rows}
    </details>`;
}

function ecfrFavsGroupToggled(open) {
    ecfrFavsGroupOpen = open;
}

function ecfrPartSubject(heading) {
    const idx = (heading || "").indexOf("—");  // em dash separates "PART 60" from subject
    let subject = idx >= 0 ? heading.slice(idx + 1) : (heading || "");
    subject = subject.trim();
    return subject && subject === subject.toUpperCase() ? ecfrTitleCase(subject) : subject;
}

function ecfrTitleCase(s) {
    const small = new Set(["a", "an", "the", "of", "and", "or", "for", "to", "in", "on", "at", "by"]);
    return s.toLowerCase().split(" ").map((w, i) =>
        (i > 0 && small.has(w)) ? w : (w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}

// The part's TOP-LEVEL DIVISIONS, in document order. Three kinds, and an
// appendix is one of them — a sibling of Subpart A, not a stray section
// inside the part. That's how the CFR is actually structured and how eCFR
// itself presents it.
//
// Lumping appendices in with the loose sections buried 116 of them across the
// corpus, and invented divisions that don't exist: part 60's "no-subpart
// group" was 18 appendices and nothing else.
function ecfrTocGroups(partData) {
    const subpartHeadings = {};
    (partData.subparts || []).forEach(sp => { subpartHeadings[sp.subpart] = sp.heading; });

    const groups = [];   // [{kind, subpart, appendix, heading, items: []}]
    const bySubpart = {};
    let loose = null;
    (partData.sections || []).forEach(sec => {
        if (sec.subpart) {
            if (!bySubpart[sec.subpart]) {
                bySubpart[sec.subpart] = { kind: "subpart", subpart: sec.subpart,
                    heading: subpartHeadings[sec.subpart] || "", items: [] };
                groups.push(bySubpart[sec.subpart]);
            }
            bySubpart[sec.subpart].items.push(sec);
        } else if (sec.type === "appendix") {
            // Its own division, alone. Appendix B to Part 60 is 2,366 blocks;
            // it has no business sharing a node with §60.1.
            groups.push({ kind: "appendix", appendix: sec.identifier,
                          heading: sec.heading || sec.identifier, items: [sec] });
        } else {
            if (!loose) { loose = { kind: "loose", heading: "", items: [] }; groups.push(loose); }
            loose.items.push(sec);
        }
    });
    return groups;
}

function ecfrTocSections(partData) {
    const groups = ecfrTocGroups(partData);

    return groups.map(g => {
        const items = g.items.map(sec => {
            const label = ecfrSectionLabel(sec);
            return `<div class="ecfr-toc-row">
                <button
                    class="ecfr-toc-section ${sec.section_key === ecfrCurrentKey ? "current" : ""} ${sec.type === "appendix" ? "appendix" : ""}"
                    data-key="${escAttr(sec.section_key)}"
                    title="${escAttr(label)}"
                    onclick="openEcfrSection(${escJs(sec.section_key)})">
                    ${esc(label)}
                </button>
                ${ecfrStarHtml("section", sec.section_key)}
            </div>`;
        }).join("");
        // Loose sections hang straight off the part — there's no division to
        // name, so a wrapper would be inventing one.
        if (g.kind === "loose") return items;

        // An appendix IS one section, so it gets a row rather than a
        // disclosure containing a single child.
        if (g.kind === "appendix") {
            const sec = g.items[0];
            const label = ecfrSectionLabel(sec);
            return `<div class="ecfr-toc-row ecfr-toc-appendix-row">
                <button class="ecfr-toc-appendix ${sec.section_key === ecfrCurrentKey ? "current" : ""}" data-key="${escAttr(sec.section_key)}"
                    title="${escAttr(label)}"
                    onclick="openEcfrSection(${escJs(sec.section_key)})">${esc(label)}</button>
                ${ecfrStarHtml("section", sec.section_key)}
            </div>`;
        }

        const label = ecfrSubpartLabel(g.heading, g.subpart);
        const hasFavChild = g.items.some(sec => ecfrFavKeys.has(sec.section_key));
        const focused = ecfrUnitFocused() && ecfrUnit.part === partData.part.part && ecfrUnit.subpart === g.subpart;
        return `<details class="ecfr-toc-subpart" data-subpart="${escAttr(`${partData.part.part}/${g.subpart}`)}"
            ${focused || g.items.some(i => i.section_key === ecfrCurrentKey) ? "open" : ""}>
            <summary class="${focused ? "current" : ""}" title="${escAttr(label)} — open the whole subpart"
                onclick="event.preventDefault(); openEcfrSubpart(${escJs(partData.part.part)}, ${escJs(g.subpart)})">
                <span class="ecfr-toc-caret-btn" role="button" tabindex="0" title="Show or hide its sections"
                    onclick="event.preventDefault(); event.stopPropagation(); ecfrSubpartCaretClicked(this)"></span>
                <span class="ecfr-toc-subpart-label">${esc(label)}</span>
                ${hasFavChild ? `<span class="ecfr-fav-below" title="Contains favorites">●</span>` : ""}
                ${ecfrStarHtml("subpart", partData.part.part, g.subpart)}
            </summary>
            ${items}
        </details>`;
    }).join("");
}

// The subpart heading itself opens the subpart whole (openEcfrSubpart, one
// fetch); only the caret in front of it expands or collapses the section
// list — so a heading click always means "show me this subpart", never
// "hide it".
function ecfrSubpartCaretClicked(caretEl) {
    const det = caretEl.closest("details");
    if (det) det.open = !det.open;
}

// Open a subpart WHOLE: expand its part, load the TOC if needed, show the
// unit from its first section, and make the subpart the focus — so the
// timeline shows every date any of its sections changed, dated frames hold
// all of it, and the Compare tab diffs all of it at once. The tree's subpart
// headings, the favorites band and #ecfr/read/<part>/<subpart> come here.
async function openEcfrSubpart(part, code) {
    showScreen("ecfr");
    ecfrExpanded.add(part);
    try {
        const data = await loadEcfrPart(part);
        const first = (data.sections || []).find(s => s.subpart === code);
        if (!first) { toast(`Couldn't find subpart ${code} in part ${part}.`); return; }
        ecfrFocus = "unit";
        await openEcfrSection(first.section_key, { keepFocus: true });
        if (!ecfrUnit || ecfrUnit.part !== part || ecfrUnit.subpart !== code) return;   // the load failed, or another click won
        ecfrApplyFocus();     // the hash, the tree's highlight, the unit timeline, the Compare tab
    } catch (err) {
        console.error("Error opening eCFR subpart:", err);
        toast(`Couldn't open part ${part} subpart ${code}.`);
    }
}

// Open a part: expand it in the tree and scroll its anchor into view. Parts
// have no page either, and jumping to §1 of a 200-section part is worse
// than showing you the part's contents.
async function openEcfrPart(part) {
    showScreen("ecfr");
    ecfrExpanded.add(part);
    if (!ecfrCurrentKey) renderEcfrReaderShell();
    try {
        await loadEcfrPart(part);
    } catch (err) {
        toast(`Couldn't load part ${part}'s table of contents.`);
    }
    renderEcfrToc();
    const el = document.getElementById(`ecfr-part-${part}`);
    if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
}

// The full heading, subject and all ("Subpart E—Standards of Performance for
// Incinerators") — knowing what a subpart covers is the whole point of the
// sidebar. The corpus already stores these title-cased, and the ones without
// an em dash ("Subpart Ca [Reserved]") read correctly whole. A handful run
// past 250 chars, so CSS clamps the display to three lines and the full text
// lives in the title tooltip.
function ecfrSubpartLabel(heading, subpart) {
    return heading || `Subpart ${subpart}`;
}

// The corpus stores section headings with the number already on the front
// ("§ 60.21 Definitions."), and appendix headings likewise — so the stored
// heading is the label. Fall back to the bare identifier if one is missing.
function ecfrSectionLabel(sec) {
    if (sec.heading) return sec.heading;
    return sec.type === "appendix" ? sec.identifier : `§ ${sec.identifier}`;
}

// Prev/next now step within the LOADED UNIT, so they're a scroll rather than
// a fetch. They come from the unit's own ordering; the old /api/ecfr/section
// prev/next stopped at the part boundary anyway, and the unit is the page.
function ecfrUnitNeighbours() {
    const i = ecfrUnitSections.findIndex(s => s.section_key === ecfrCurrentKey);
    if (i < 0) return { prev: null, next: null };
    return { prev: ecfrUnitSections[i - 1] || null, next: ecfrUnitSections[i + 1] || null };
}

// The pane's nav renders on its own, because its prev/next controls change
// as you scroll — later than the pane itself is painted.
// The prev/next pair both tabs share, plus whatever the tab puts at the
// right end (Read: "+ Add frame"; Compare: nothing).
function ecfrPaneNavHtml(extra = "") {
    const { prev, next } = ecfrUnitNeighbours();
    return `
        <button class="ecfr-btn ecfr-btn-nav" ${prev ? "" : "disabled"}
            title="${prev ? escAttr(prev.heading || prev.section_key) : ""}"
            onclick="${prev ? `openEcfrSection(${escJs(prev.section_key)})` : ""}">
            ‹ ${prev ? esc(ecfrShortLabel(prev)) : "Start of this subpart"}</button>
        <button class="ecfr-btn ecfr-btn-nav" ${next ? "" : "disabled"}
            title="${next ? escAttr(next.heading || next.section_key) : ""}"
            onclick="${next ? `openEcfrSection(${escJs(next.section_key)})` : ""}">
            ${next ? esc(ecfrShortLabel(next)) : "End of this subpart"} ›</button>
        ${extra}`;
}

function ecfrRenderPaneNav() {
    const el = document.getElementById("ecfr-pane-nav");
    if (el) {
        el.innerHTML = ecfrPaneNavHtml(`<button class="ecfr-btn ecfr-add-frame"
            ${ecfrFrames.length >= ECFR_MAX_FRAMES ? "disabled" : ""}
            title="Open another frame to compare versions side by side"
            onclick="ecfrAddFrame()">+ Add frame</button>`);
    }
    // The Compare tab's copy of the same row. An invisible "+ Add frame" holds
    // the right end so the next button sits exactly where Read's does.
    const cmp = document.getElementById("cmp-nav");
    if (cmp) cmp.innerHTML = ecfrPaneNavHtml(`<button class="ecfr-btn ecfr-add-frame" style="visibility:hidden"
            tabindex="-1" aria-hidden="true">+ Add frame</button>`);
}

// --- The pane's two tabs: Read and Compare ----------------------------
// The pane holds both, one visible at a time, and each keeps its state
// across a swap: the Read tab is what renderEcfrPane paints, the Compare
// tab is compare.js's control bar and terminal, mounted once. The contents
// sidebar feeds whichever tab is showing.
let ecfrPaneTab = "read";

// Build the pane's skeleton once (a re-render must not wipe the terminal),
// apply the current tab, and return the Read tab's element to paint into.
function ecfrPaneSkeleton() {
    const el = document.getElementById("ecfr-pane");
    if (!el) return null;
    if (!document.getElementById("ecfr-read")) {
        el.innerHTML = `<div class="ecfr-pane-tabs" id="ecfr-pane-tabs"></div>
            <div class="ecfr-read" id="ecfr-read"></div>
            <div class="ecfr-compare" id="ecfr-compare"></div>`;
    }
    ecfrRenderPaneTabs();
    document.getElementById("ecfr-read").hidden = ecfrPaneTab !== "read";
    document.getElementById("ecfr-compare").hidden = ecfrPaneTab !== "compare";
    if (typeof cmpMount === "function") cmpMount();
    return document.getElementById("ecfr-read");
}

function ecfrRenderPaneTabs() {
    const el = document.getElementById("ecfr-pane-tabs");
    if (!el) return;
    const tab = (name, label, title) => `<button class="ws-btn ${ecfrPaneTab === name ? "active" : ""}"
        title="${escAttr(title)}" onclick="ecfrSetPaneTab(${escJs(name)})">${label}</button>`;
    el.innerHTML = `<nav class="workspace-nav">${
        tab("read", "Read", "The section's text, in frames")}${
        tab("compare", "Compare", ecfrUnitFocused() ? "Two versions of the whole subpart, as a diff"
                                                    : "Two versions of this section, as a diff")}</nav>
        <span class="ecfr-pane-tabs-hint"></span>`;
}

async function ecfrSetPaneTab(tab) {
    const changed = ecfrPaneTab !== tab;
    ecfrPaneTab = tab;
    ecfrRenderPaneTabs();
    const read = document.getElementById("ecfr-read");
    const cmp = document.getElementById("ecfr-compare");
    if (read) read.hidden = tab !== "read";
    if (cmp) cmp.hidden = tab !== "compare";
    if (tab === "compare" && typeof cmpShow === "function") await cmpShow();
    syncHash(changed);
}

function renderEcfrPane() {
    const el = ecfrPaneSkeleton();
    if (!el) return;
    if (ecfrLoading) {
        el.innerHTML = `<p class="hint" style="padding:20px;">Loading…</p>`;
        return;
    }
    if (!ecfrUnitSections.length) {
        el.innerHTML = `<div class="ecfr-empty">
            <p class="hint">Select a section from the table of contents to start reading.</p>
        </div>`;
        return;
    }
    el.innerHTML = `
        <div class="ecfr-pane-nav" id="ecfr-pane-nav"></div>
        <div class="ecfr-timeline" id="ecfr-timeline"></div>
        <div class="ecfr-toolbar" id="ecfr-toolbar"></div>
        <div class="ecfr-frames" data-count="${ecfrFrames.length}">${
            ecfrFrames.map((f, i) => ecfrFrameHtml(f, i)).join("")}</div>`;
    ecfrRenderTimeline();

    // Put the reader back where it was BEFORE anything can observe the fresh
    // DOM. A re-render (add a frame, change a source, toggle diff) rebuilds
    // the body with scrollTop 0 — and the topmost-visible rule would then
    // conclude the FIRST section of the unit is what you're reading and
    // silently teleport you to the top of the subpart, taking the panel and
    // the URL with it. Synchronous, and before ecfrObserveSections below, so
    // the observer's first callback sees the true position.
    if (ecfrCurrentKey) ecfrScrollToSection(ecfrCurrentKey);

    ecfrRenderPaneNav();
    ecfrRenderToolbar();
    // Rebinds section by section as they come into view: the observer
    // fills the text and attaches an annotator to each container.
    ecfrAttachAnnotator();
    ecfrSyncAnnotatingAffordance();
}

// One section inside a frame: its own header, its own star, and — the part
// that matters — its OWN .ecfr-blocks container, which is the unit of
// annotation anchoring.
//
// Blocks are left EMPTY until the section nears the viewport
// (ecfrObserveSections fills them). Most units are tiny, but part 52's
// subpart F is 57 sections / 8,894 blocks, and a live frame would otherwise
// fetch every section of a subpart from ecfr.gov the moment you opened it.
function ecfrSectionHtml(sec, frameIndex, src) {
    const key = sec.section_key;
    const data = src.data(key);
    const isCurrent = key === ecfrCurrentKey;

    // Authority/Source are per section and come from the local corpus row;
    // the live payload has no equivalent. They used to be hoisted into the
    // frame header, which stops meaning anything with many sections in view.
    const metaBits = [];
    if (src.persists !== false && sec.authority) {
        metaBits.push(`<div><b>Authority:</b> ${esc(sec.authority)}</div>`);
    }
    if (src.persists !== false && sec.source) {
        metaBits.push(`<div><b>Source:</b> ${esc(sec.source)}</div>`);
    }

    let inner;
    if (!data) {
        // Not fetched yet (a live frame you haven't scrolled to), or not
        // filled yet. min-height keeps the scrollbar from lurching as
        // sections resolve.
        inner = `<p class="hint ecfr-section-pending">Loading${
            src.persists === false ? " from ecfr.gov" : ""}…</p>`;
    } else {
        inner = "";       // filled by the observer; see ecfrFillSection
    }

    return `<article class="ecfr-section ${isCurrent ? "current" : ""}"
        data-section-key="${escAttr(key)}" data-frame="${frameIndex}">
        <div class="ecfr-section-head">
            <div class="ecfr-citation">${esc(sec.citation || key)}</div>
            ${src.persists !== false ? ecfrStarHtml("section", key) : ""}
        </div>
        <h2 class="ecfr-heading">${esc((data && data.heading) || sec.heading || "")}</h2>
        <div class="ecfr-meta">${metaBits.join("")}</div>
        <div class="ecfr-blocks" data-frame="${frameIndex}"
             data-section-key="${escAttr(key)}"
             data-filled="0">${inner}</div>
    </article>`;
}

// One reading frame: a header naming exactly which version is on screen,
// over an independently-scrolling body holding the whole unit.
function ecfrFrameHtml(frame, index) {
    const src = ECFR_SOURCES[frame.source];
    const key = ecfrCurrentKey;
    const data = src.data(key);
    const s = ecfrSection || {};

    // WHICH SECTIONS THIS FRAME SHOWS.
    //
    // Every frame shows the whole unit, live and dated ones included — because
    // a subpart is ONE request (/api/ecfr/unit/live, /unit/at), not 23. It was 23
    // before, which earned a real HTTP 429 and forced live frames down to a
    // single section; the author's fix removed the reason.
    //
    // The exception is a unit ecfr.gov has no name for: an appendix is one
    // section, and a part's loose sections aren't a division upstream. Those
    // fall back to per-section fetching, so a live frame shows only what
    // you're reading rather than firing one request per loose section.
    const liveUnitFetchable = !!(ecfrUnit && ecfrUnit.subpart);
    const unitFrame = src.persists !== false || liveUnitFetchable;
    const sections = unitFrame
        ? ecfrUnitSections
        : ecfrUnitSections.filter(s => s.section_key === ecfrCurrentKey);

    // Each article carries its own text container, and that is a safety
    // property, not a layout choice: highlight offsets index one section's
    // text. Merge the unit into a single container and every saved offset
    // would resolve — via ecfrLocateQuote's fallback — onto plausible but
    // WRONG words, which ecfrPersistAnchor would then PATCH back into the
    // database. Silently.
    //
    // So: one container per section, offsets unchanged, no migration.
    const bodyHtml = frame.error
        ? `<p class="hint">${esc(frame.error)}</p>`
        : sections.map(sec => ecfrSectionHtml(sec, index, src)).join("");

    const options = ecfrFrameSourceOptions(frame);

    // Marks on this frame won't be saved — say so on the frame itself, where
    // the marks are, rather than in the shared toolbar which couldn't name a
    // frame. Persistent, and not a toast: a toast fades and the mark outlives
    // it, at which point a scratch mark looks exactly like a saved one.
    //
    // In diff mode nothing is annotatable at all (the annotator detaches), so
    // the warning would be answering a question nobody asked.
    // Compact, and on the header's ONE line: a warning that wrapped to a
    // second line made this frame's header taller than the local frame's, so
    // the two bodies started at different heights and the text no longer lined
    // up — which is the entire point of reading them side by side. The full
    // sentence lives in the tooltip.
    const scratchWarn = (src.editable && src.persists === false)
        ? `<span class="ecfr-scratch-warn"
             title="Marks here are scratch: they are never saved and are gone when you navigate away. Live text isn't stored and can change upstream at any time, so a saved mark's position couldn't be trusted later — mark the local snapshot to keep it."
             >⚠ Scratch</span>`
        : "";

    // A frame in a row of several gets a close button; the only frame has
    // nothing to close ("+ Add frame" in the nav opens the next one).
    const action = ecfrFrames.length === 1 ? ""
        : `<button class="ecfr-annot-x" title="Close this frame" onclick="ecfrCloseFrame(${index})">✕</button>`;


    // draggable on the HEAD only: the body has to stay selectable, since
    // selecting text is how you annotate it.
    return `<div class="ecfr-frame ${src.persists === false ? "live" : ""}" data-frame="${index}"
        ondragover="ecfrFrameDragOver(event, ${index})"
        ondrop="ecfrFrameDrop(event, ${index})">
        <div class="ecfr-frame-head" draggable="true"
            ondragstart="ecfrFrameDragStart(event, ${index})"
            ondragend="ecfrFrameDragEnd(event)"
            title="Drag to reorder">
            <span class="ecfr-frame-grip" aria-hidden="true">⠿</span>
            <select class="spec-select ecfr-frame-source"
                onmousedown="event.stopPropagation()"
                onchange="ecfrSetFrameSource(${index}, this.value)">
                ${options}
            </select>
            <span class="ecfr-frame-provenance" title="${escAttr(src.hint ? src.hint(data) : "")}">${esc(src.label(data))}</span>
            ${scratchWarn}
            ${action}
        </div>
        ${ecfrUnitLabel(unitFrame)}
        <div class="ecfr-frame-body"
             onscroll="${unitFrame ? `ecfrOnFrameScroll(${index})` : ""}">
            ${bodyHtml}
        </div>
    </div>`;
}

// The source picker offers exactly what the rail above shows: the two
// snapshots, then every amendment date on record for what's in focus. It
// used to list only the sources already registered, so a date appeared in
// it only after its tick had been clicked and then never left — the picker
// looked arbitrary, and after a few sections it offered dates from other
// rules' histories. The dates come from ecfrTimelineTicks, the rail's own
// source of truth, so section and whole-subpart focus both work.
function ecfrFrameSourceOptions(frame) {
    const opt = (id, label) => `<option value="${escAttr(id)}" ${id === frame.source ? "selected" : ""}>${esc(label)}</option>`;
    // Short labels: the picker is deliberately narrow and the provenance
    // label beside it spells the version out in full.
    let html = `<optgroup label="Snapshots">${opt("local", "Local snapshot")}${opt("live", "Live ecfr.gov")}</optgroup>`;
    const v = ecfrVersions;
    const ticks = ecfrTimelineTicks().filter(t => t.kind === "version");
    let dated = ticks.map(t => opt(t.id, `As of ${t.date}${t.sections ? ` — ${t.sections.length} section${t.sections.length === 1 ? "" : "s"}` : ""}${
        t.removed ? ", removed" : t.substantive ? ", substantive" : ""}`)).join("");
    // A date this frame is on that the rail no longer lists (you moved to
    // another section) stays selectable, so the header never names a version
    // the picker doesn't show.
    if (frame.source.startsWith("version:") && !ticks.some(t => t.id === frame.source)) {
        dated += opt(frame.source, `As of ${frame.source.slice(8)} (another section's history)`);
    }
    if (!dated) {
        dated = `<option disabled>${v && v.loading ? "amendment dates loading…"
            : v && v.error ? "amendment dates unavailable" : "no amendments on record since 2017"}</option>`;
    }
    html += `<optgroup label="Amendments on record">${dated}</optgroup>`;
    let proposals = ecfrProposals.map(p => opt(`proposal:${p.id}`, `Proposed — ${p.title}`)
        + opt(`proposal:${p.id}:before`, `Base of proposal — ${p.title}`)).join("");
    if (frame.source.startsWith("proposal:") && !ecfrProposalOf(frame.source)) {
        proposals += opt(frame.source, `${frame.source.endsWith(":before") ? "Base of proposal" : "Proposed"} (another part's)`);
    }
    if (proposals) html += `<optgroup label="Proposals (from the Dockets tab)">${proposals}</optgroup>`;
    return html;
}

// Rewrite each frame's picker in place when the rail's dates arrive — the
// pane itself isn't re-rendered, so filled sections and annotators stay.
function ecfrRefreshFrameSelects() {
    ecfrFrames.forEach((f, i) => {
        const sel = document.querySelector(`#ecfr-pane .ecfr-frame[data-frame="${i}"] .ecfr-frame-source`);
        if (sel) sel.innerHTML = ecfrFrameSourceOptions(f);
    });
}

// What you're reading, pinned at the top of the frame's scroll — with a whole
// subpart in the body, the frame header alone no longer says where you are.
function ecfrUnitLabel(unitFrame) {
    if (!ecfrUnit) return "";
    const what = ecfrUnit.subpart ? `Subpart ${ecfrUnit.subpart}`
        : ecfrUnit.appendix ? ecfrUnit.appendix
        : "Sections";
    // A live frame shows one section, so saying "23 sections" over it would
    // be a lie about what's underneath.
    const count = unitFrame
        ? `${ecfrUnitSections.length} section${ecfrUnitSections.length === 1 ? "" : "s"}`
        : "this section only";
    return `<div class="ecfr-unit-label">
        <span class="ecfr-unit-part">40 CFR Part ${esc(ecfrUnit.part)}</span>
        <span class="ecfr-unit-name">${esc(ecfrUnitHeading || what)}</span>
        <span class="ecfr-unit-count">${esc(count)}</span>
    </div>`;
}

// --- Lazy fill + annotator lifecycle ---------------------------------
//
// ONE IntersectionObserver does both jobs, because they have the same
// trigger: a section coming near the viewport needs its text, and only a
// section with text on screen needs an annotator.
//
// Both jobs are needed. Filling: part 52 subpart F is 8,894 blocks, and a
// live frame would otherwise fetch all 57 of its sections from ecfr.gov the
// instant you opened it. Attaching: part 81 subpart B is 246 sections, and
// 246 RecogitoJS instances (x frames) is not a thing to do to a browser.
//
// rootMargin gives a screenful of runway either side, so text is there before
// you reach it rather than popping in under your eyes.
function ecfrObserveSections() {
    if (ecfrSectionObserver) ecfrSectionObserver.disconnect();
    const pane = document.getElementById("ecfr-pane");
    if (!pane || !ecfrUnitSections.length) return;

    ecfrSectionObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            const art = entry.target;
            const key = art.dataset.sectionKey;
            const frameIndex = Number(art.dataset.frame);
            if (entry.isIntersecting) {
                ecfrFillSection(art, key, frameIndex);
                ecfrAttachSectionAnnotator(frameIndex, key);
            } else {
                // Detach, don't just skip attaching: an observer that only
                // ever adds is how you end up with 246 live instances after a
                // long scroll.
                ecfrDetachSectionAnnotator(frameIndex, key);
            }
        });
        // Debounced, like the scroll handler. Every current-section change
        // costs a live fetch from ecfr.gov, and firing one per boundary as you
        // flick through a subpart earns an HTTP 429 — which it did.
        ecfrQueueCurrentUpdate();
    }, { root: null, rootMargin: "600px 0px", threshold: 0 });

    pane.querySelectorAll(".ecfr-section[data-section-key]")
        .forEach(el => ecfrSectionObserver.observe(el));
}

// Put a section's blocks in, once. Fetches first if the source hasn't got it
// (a live frame you've just scrolled to).
async function ecfrFillSection(article, key, frameIndex) {
    const frame = ecfrFrames[frameIndex];
    if (!frame) return;
    const src = ECFR_SOURCES[frame.source];
    const holder = article.querySelector(".ecfr-blocks");
    if (!holder || holder.dataset.filled === "1") return;

    let data = src.data(key);
    if (!data) {
        holder.dataset.filled = "1";          // claim it before the await, or a
                                              // second observer tick double-fetches
        try {
            await src.ensure(key);
        } catch (err) {
            console.error(`Error loading ${frame.source} text for ${key}:`, err);
            holder.innerHTML = `<p class="hint">Couldn't load this version of ${esc(key)}.</p>`;
            return;
        }
        data = src.data(key);
        // The pane may have re-rendered under us while ecfr.gov answered.
        if (!document.body.contains(holder)) return;
        if (!data) {
            // The source answered and hasn't got this section: it wasn't in
            // the subpart on that date (or isn't upstream today).
            holder.innerHTML = `<p class="hint">Not in this version of the subpart.</p>`;
            return;
        }
    }
    holder.dataset.filled = "1";
    holder.innerHTML = (data.blocks || []).map(ecfrRenderBlock).join("");
    const h = article.querySelector(".ecfr-heading");
    if (h && data.heading) h.textContent = data.heading;
    // Text just appeared, so this section can now be annotated.
    ecfrAttachSectionAnnotator(frameIndex, key);
}

// The section at the top of the reading frame is "the one you're reading":
// it drives the panel, the star and the URL. With a whole
// subpart on screen, "current" has to mean something, and this is the honest
// answer — the thing your eyes are on.
let ecfrScrollTimer = null;
function ecfrQueueCurrentUpdate() {
    clearTimeout(ecfrScrollTimer);
    ecfrScrollTimer = setTimeout(ecfrUpdateCurrentFromScroll, 150);
}

function ecfrOnFrameScroll(frameIndex) {
    ecfrQueueCurrentUpdate();
}

function ecfrUpdateCurrentFromScroll() {
    const body = document.querySelector("#ecfr-pane .ecfr-frame:not(.live) .ecfr-frame-body")
        || document.querySelector("#ecfr-pane .ecfr-frame-body");
    if (!body || !ecfrUnitSections.length) return;
    const top = body.getBoundingClientRect().top;
    let best = null, bestDist = Infinity;
    body.querySelectorAll(".ecfr-section[data-section-key]").forEach(art => {
        const r = art.getBoundingClientRect();
        // The section whose start is nearest the top of the frame, counting
        // one already scrolled past (negative) as still current until the next
        // one reaches the top.
        const dist = r.top - top;
        const score = dist > 0 ? dist : Math.abs(dist) * 0.001;
        if (r.bottom > top && score < bestDist) { bestDist = score; best = art; }
    });
    if (!best) return;
    const key = best.dataset.sectionKey;
    if (key === ecfrCurrentKey) return;
    // scroll:false — we're here BECAUSE of a scroll; scrolling again would
    // fight the user for control of their own viewport.
    ecfrSetCurrentSection(key, { scroll: false });
    document.querySelectorAll("#ecfr-pane .ecfr-section.current")
        .forEach(el => el.classList.remove("current"));
    document.querySelectorAll(
        `#ecfr-pane .ecfr-section[data-section-key="${CSS.escape(key)}"]`)
        .forEach(el => el.classList.add("current"));
    ecfrRepaintNonUnitFrames();
}

// Re-render the frames that can only track the current section, leaving unit
// frames' filled blocks and attached annotators alone.
//
// Only reachable for a unit ecfr.gov can't serve whole — an appendix (one
// section anyway) or a part's loose sections. For a subpart the live frame
// holds the unit like any other, because /api/ecfr/unit/live fetches it in
// one request.
function ecfrRepaintNonUnitFrames() {
    if (ecfrUnit && ecfrUnit.subpart) return;     // live frames hold the unit too
    ecfrFrames.forEach((f, i) => {
        const src = ECFR_SOURCES[f.source];
        if (src.persists !== false) return;
        const frameEl = document.querySelector(`#ecfr-pane .ecfr-frame[data-frame="${i}"]`);
        if (!frameEl) return;
        const shown = frameEl.querySelector(".ecfr-section[data-section-key]");
        if (shown && shown.dataset.sectionKey === ecfrCurrentKey) return;
        ecfrDetachAnnotator(i, shown ? shown.dataset.sectionKey : "");
        const body = frameEl.querySelector(".ecfr-frame-body");
        const sec = ecfrUnitSections.find(s => s.section_key === ecfrCurrentKey);
        if (!body || !sec) return;
        body.innerHTML = ecfrUnitLabel(false)
            + ecfrSectionHtml(sec, i, src, false, null);
        body.querySelectorAll(".ecfr-section[data-section-key]")
            .forEach(el => ecfrSectionObserver && ecfrSectionObserver.observe(el));
        ecfrLoadFrames();
    });
}

async function ecfrSetFrameSource(index, source) {
    const frame = ecfrFrames[index];
    if (source.startsWith("version:")) ecfrVersionSource(source.slice(8));   // a date from the picker: register it like a tick click
    if (source.startsWith("proposal:")) ecfrProposalSource(ecfrProposalId(source), ecfrProposalSide(source));
    if (!frame || !ECFR_SOURCES[source] || frame.source === source) return;
    frame.source = source;
    frame.error = null;
    renderEcfrReader();      // repaint immediately: the header must never lag the text
    await ecfrLoadFrames();
}

// Open another frame, defaulting to the opposite source of the last one —
// comparing a version against itself is never what's wanted.
function ecfrAddFrame() {
    if (ecfrFrames.length >= ECFR_MAX_FRAMES) return;
    const last = ecfrFrames[ecfrFrames.length - 1];
    ecfrFrames.push({ source: last && last.source === "local" ? "live" : "local" });
    renderEcfrReader();
    ecfrLoadFrames();
}

function ecfrCloseFrame(index) {
    if (ecfrFrames.length <= 1) return;
    ecfrFrames.splice(index, 1);
    renderEcfrReader();
}

// --- Frame drag-reorder ----------------------------------------------

function ecfrFrameDragStart(e, index) {
    ecfrDragFrame = index;
    // Firefox won't start a drag at all without data on the transfer.
    if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", String(index));
    }
    const frame = e.currentTarget.closest(".ecfr-frame");
    if (frame) frame.classList.add("dragging");
}

function ecfrFrameDragEnd(e) {
    ecfrDragFrame = null;
    document.querySelectorAll("#ecfr-pane .ecfr-frame.dragging, #ecfr-pane .ecfr-frame.drag-over")
        .forEach(el => el.classList.remove("dragging", "drag-over"));
}

function ecfrFrameDragOver(e, index) {
    if (ecfrDragFrame === null) return;   // not our drag — e.g. dragged text
    e.preventDefault();                   // "yes, you may drop here"
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    if (index !== ecfrDragFrame) {
        const frame = e.currentTarget;
        if (frame && !frame.classList.contains("drag-over")) frame.classList.add("drag-over");
    }
}

function ecfrFrameDrop(e, index) {
    if (ecfrDragFrame === null) return;
    e.preventDefault();
    const from = ecfrDragFrame;
    ecfrDragFrame = null;
    if (from === index) { ecfrFrameDragEnd(e); return; }
    const [moved] = ecfrFrames.splice(from, 1);
    ecfrFrames.splice(index, 0, moved);
    // A full re-render is what makes this safe, not a nicety. Frames are
    // identified by index everywhere, so reordering invalidates every one of
    // them; renderEcfrPane re-runs ecfrAttachAnnotator, which finds the local
    // frame afresh (findIndex, not a stored index) and re-attaches under its
    // token guard. Don't optimise this into a DOM node swap — the annotator
    // would stay bound to the old element.
    renderEcfrReader();
}

// --- Annotation toolbar ---------------------------------------------
// A PDF-editor-style armed-tool bar: pick a tool, then drag over text.
// `ecfrTool` (declared in ecfr-annotator.js) is the single source of truth
// for what's armed; the engine reads it when a new mark is created.

const ECFR_TOOLS = [
    { mode: "select",    label: "↖", title: "Select (V) — click a mark to comment on it",
      hint: "Click a mark to comment on it." },
    { mode: "highlight", label: "▬", title: "Highlighter (H) — drag across text",
      hint: "Drag across text — or select first, then click a tool or colour." },
    { mode: "underline", label: "U", title: "Underline (U) — drag across text",
      hint: "Drag across text — or select first, then click a tool or colour." },
    { mode: "strike",    label: "S", title: "Strikethrough (S) — drag across text",
      hint: "Drag across text — or select first, then click a tool or colour." },
    { mode: "eraser",    label: "⌫", title: "Eraser (E) — click a mark to remove it",
      hint: "Click a mark to remove it." },
];

function ecfrIsPaintTool(mode) {
    return mode === "highlight" || mode === "underline" || mode === "strike";
}

function ecfrRenderToolbar() {
    const el = document.getElementById("ecfr-toolbar");
    if (!el) return;
    if (!ecfrHasAnnotatableFrame()) {
        el.innerHTML = `<span class="hint">Nothing on screen can be marked up.</span>`;
        return;
    }
    // onmousedown preventDefault on every control: pressing a toolbar button
    // otherwise moves focus and COLLAPSES the text selection before the
    // click handler ever runs — which is exactly why "select the text, then
    // click a colour" silently did nothing. Standard rich-text-toolbar trick.
    const tools = ECFR_TOOLS.map(t => `<button class="ecfr-tool tool-${t.mode}
        ${ecfrTool.mode === t.mode ? "armed" : ""}" title="${escAttr(t.title)}"
        onmousedown="event.preventDefault()"
        onclick="ecfrSetTool(${escJs(t.mode)})">${esc(t.label)}</button>`).join("");
    const swatches = Object.keys(ECFR_HL_PALETTE).map(c => `<button
        class="ecfr-swatch ${ecfrTool.color === c ? "armed" : ""}"
        style="background:${ECFR_HL_PALETTE[c]}" title="${escAttr(c)}"
        onmousedown="event.preventDefault()"
        onclick="ecfrSetColor(${escJs(c)})"></button>`).join("");
    // Undo history is per instance; the buttons act on the frame you last
    // marked (ecfrUndoTarget), so ask that one.
    const target = ecfrUndoTarget();
    const canUndo = !!(target && target.canUndo());
    const canRedo = !!(target && target.canRedo());
    const armed = ECFR_TOOLS.find(t => t.mode === ecfrTool.mode);

    // The scratch warning is NOT here — it lives in the live frame's own
    // header (ecfrFrameHtml). It's a fact about one frame, and the toolbar is
    // shared by all of them, so here it couldn't say which frame it meant.
    el.innerHTML = `${tools}
        <span class="ecfr-tool-swatches">${swatches}</span>
        <span class="ecfr-tool-sep"></span>
        <button class="ecfr-tool" ${canUndo ? "" : "disabled"} title="Undo (Ctrl+Z)"
            onmousedown="event.preventDefault()" onclick="ecfrUndo()">↶</button>
        <button class="ecfr-tool" ${canRedo ? "" : "disabled"} title="Redo (Ctrl+Shift+Z)"
            onmousedown="event.preventDefault()" onclick="ecfrRedo()">↷</button>
        <span class="ecfr-tool-hint">${esc(armed ? armed.hint : "")}</span>`;
}

function ecfrSetTool(mode) {
    ecfrTool.mode = mode;
    // Apply to the current selection BEFORE arming. Order matters twice
    // over: the new mode is what gets painted, and ecfrApplyToolToSelection
    // clears the selection so that arming the annotator underneath doesn't
    // then paint the same words a second time.
    ecfrApplyToolToSelection();
    // Every annotatable frame arms together: the tool is a property of the
    // toolbar, not of a frame, and you shouldn't have to re-pick it because
    // you moved the mouse to the other pane.
    ecfrEachAnnotator((ann) => {
        // Only a paint tool turns drag-to-create on; select and eraser both
        // need plain clicks to reach existing marks instead.
        ann.setAnnotatingEnabled(ecfrIsPaintTool(mode));
        if (mode !== "select") ann.cancelSelected();
    });
    ecfrRenderToolbar();
    ecfrSyncAnnotatingAffordance();
}

function ecfrSetColor(color) {
    if (!ECFR_HL_PALETTE[color]) return;
    ecfrTool.color = color;
    // Picking a colour while pointing/erasing means "I want to highlight in
    // this colour" — the convention every PDF editor uses. ecfrSetTool then
    // does the applying; when a paint tool is already armed, do it here.
    if (!ecfrIsPaintTool(ecfrTool.mode)) {
        ecfrSetTool("highlight");
    } else {
        ecfrApplyToolToSelection();
        ecfrRenderToolbar();
    }
}

// Undo history belongs to an instance, and there are now several. The
// buttons act on the frame you last marked; failing that, on whichever
// instance actually has something to undo — so Ctrl+Z with one annotatable
// frame behaves exactly as it always did.
function ecfrUndoTarget() {
    const active = ecfrActiveFrame !== null && ecfrAnnotators.get(ecfrActiveFrame);
    if (active) return active.ann;
    for (const [, rec] of ecfrAnnotators) {
        if (rec.ann.canUndo() || rec.ann.canRedo()) return rec.ann;
    }
    return ecfrAnyAnnotator();
}

function ecfrUndo() {
    const t = ecfrUndoTarget();
    if (t) t.undo();
    ecfrRenderToolbar();
}

function ecfrRedo() {
    const t = ecfrUndoTarget();
    if (t) t.redo();
    ecfrRenderToolbar();
}

function ecfrHandleReaderKeydown(e) {
    if (appScreen !== "ecfr" || !ecfrCurrentKey || ecfrPaneTab !== "read") return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? ecfrRedo() : ecfrUndo();
        return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === "Escape") {
        ecfrEachAnnotator((ann) => ann.cancelSelected());
        ecfrHighlightEditingId = null;
        ecfrSetTool("select");
        renderEcfrAnnotationsPanel();
        return;
    }
    const shortcuts = { v: "select", h: "highlight", u: "underline", s: "strike", e: "eraser" };
    const mode = shortcuts[e.key.toLowerCase()];
    if (mode && ecfrHasAnnotatableFrame()) {
        e.preventDefault();
        ecfrSetTool(mode);
    }
}

// Two different questions, which used to have one answer.
//
// "Can I mark anything?" — true for a live frame too, since round 4: its
// marks are scratch, but they're real while you're reading.
function ecfrHasAnnotatableFrame() {
    return ecfrFrames.some(f => ECFR_SOURCES[f.source].editable);
}

// "Will marks be SAVED?" — only against the local snapshot, whose text we
// store and can re-anchor to. This is what the panel's lists depend on.
function ecfrHasPersistingFrame() {
    return ecfrFrames.some(f => {
        const src = ECFR_SOURCES[f.source];
        return src.editable && src.persists !== false;
    });
}

// The heading with its own section number stripped off, for prev/next — the
// button says where you're going, not the number you can already see.
//
// `[a-z]*` is load-bearing: 509 of 9,696 section identifiers carry a letter
// suffix (60.111b, 52.220a). Matching only [\d.]+ leaves the letter behind,
// so "§ 60.111b Definitions." rendered as "b Definitions.".
function ecfrShortLabel(ref) {
    return (ref.heading || ref.section_key || "")
        .replace(/^§\s*[\d.]+[a-z]*\s*/i, "").slice(0, 40);
}

function ecfrRenderBlock(block, index) {
    if (block.type === "table") {
        const headHtml = block.headers && block.headers.length
            ? `<thead><tr>${block.headers.map(h => `<th>${esc(h)}</th>`).join("")}</tr></thead>` : "";
        const bodyHtml = (block.rows || [])
            .map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
        const captionHtml = block.caption ? `<caption>${esc(block.caption)}</caption>` : "";
        const footHtml = (block.footnotes || []).length
            ? `<div class="ecfr-table-footnotes">${block.footnotes.map(f => `<div>${esc(f)}</div>`).join("")}</div>` : "";
        return `<div class="ecfr-table-wrap" data-block-index="${index}">
            <table class="ecfr-table">${captionHtml}${headHtml}<tbody>${bodyHtml}</tbody></table>
            ${footHtml}
        </div>`;
    }
    return `<p class="ecfr-block" data-block-index="${index}">${esc(block.text || "")}</p>`;
}

function renderEcfrAnnotationsPanel() {
    const el = document.getElementById("ecfr-annotations");
    if (!el) return;

    let html = `<div class="ecfr-annotations-head">Annotations</div>`;
    // The scope bar is gone. It could only offer levels reachable from the
    // section you already had open, which made "which part is my note in?"
    // — the only version of the question worth asking — unanswerable. The
    // tree accordion below answers it from anywhere.

    if (ecfrCurrentKey) {
        const favorited = ecfrFavKeys.has(ecfrCurrentKey);
        html += `<button class="ecfr-bookmark-star ${favorited ? "on" : ""}"
            onclick="ecfrToggleFavoriteClick()">
            ${favorited ? "★ Starred" : "☆ Star this section"}</button>`;
    }
    // No Favorites accordion here on purpose: the sidebar's pinned group
    // (ecfrFavoritesGroupHtml) is the one place favorites live. Two lists of
    // the same data, one of which couldn't unstar, was worse than one.
    html += ecfrAccHtml("notes", "Notes & Highlights", null, ecfrPanelMarksHtml());
    const all = ecfrAllAnnotations;
    const total = all ? (all.notes || []).length + (all.highlights || []).length : null;
    html += ecfrAccHtml("tree", "All annotations", total, ecfrAnnoTreeHtml());
    el.innerHTML = html;
}

// The scope-filtered notes/highlights lists — the panel's original contents,
// now the body of one accordion section.
function ecfrPanelMarksHtml() {
    const p = ecfrPanel || { notes: [], highlights: [] };
    const s = ecfrSection || {};
    let html = "";

    if (ecfrPanelLoading) return `<p class="hint" style="padding:12px;">Loading…</p>`;
    // SAVED marks only paint on the local snapshot. A live frame can still be
    // marked, but those are scratch and never reach this list.
    if (ecfrCurrentKey && !ecfrHasPersistingFrame()) {
        html += `<p class="hint" style="padding:4px 12px 8px;">No frame is showing the local
            snapshot, so the highlights below aren't painted in the text — switch a frame
            back to it to see them.</p>`;
    }

    // Orphans are listed separately below, so keep them out of the main list.
    const orphanIds = new Set(ecfrOrphanedHighlights.map(h => h.id));
    const highlights = p.highlights.filter(h => !orphanIds.has(h.id));

    html += `<div class="ecfr-annot-section-head">Highlights</div>`;
    if (highlights.length) {
        html += highlights.map(ecfrHighlightItemHtml).join("");
    } else {
        html += `<p class="hint" style="padding:0 12px;">${ecfrScope === "section"
            ? "Pick the highlighter, then drag across the text to mark it."
            : "Nothing highlighted in this part of Title 40 yet."}</p>`;
    }
    if (ecfrOrphanedHighlights.length) {
        html += `<div class="ecfr-orphan-note">${ecfrOrphanedHighlights.length} highlight${ecfrOrphanedHighlights.length === 1 ? "" : "s"}
            couldn't be located in the current text (orphaned) — the quote is preserved:</div>`;
        html += ecfrOrphanedHighlights.map(h => `<div class="ecfr-highlight-item orphaned">
            <span class="ecfr-highlight-quote">"${ecfrQuotePreview(h.quote)}"</span>
            <button class="ecfr-annot-x" title="Remove highlight" onclick="ecfrDeleteHighlightClick(${h.id})">✕</button>
        </div>`).join("");
    }

    html += `<div class="ecfr-annot-section-head">Notes</div>`;
    if (p.notes.length) {
        html += p.notes.map(ecfrNoteItemHtml).join("");
    } else if (ecfrScope !== "section") {
        html += `<p class="hint" style="padding:0 12px;">No notes in this part of Title 40 yet.</p>`;
    }
    // Notes attach to the section you're reading, so the composer needs one.
    if (ecfrCurrentKey) {
        html += `<div class="ecfr-note-item ecfr-note-new">
            <textarea class="ecfr-note-textarea" id="ecfr-note-new"
                placeholder="Add a note on ${escAttr(s.citation || ecfrCurrentKey)}…"></textarea>
            <div class="ecfr-note-actions">
                <button class="ecfr-btn" onclick="ecfrSubmitNote()">Add note</button>
            </div>
        </div>`;
    }

    return html;
}

function ecfrNoteItemHtml(n) {
    if (ecfrNoteEditingId === n.id) {
        return `<div class="ecfr-note-item">
            <textarea class="ecfr-note-textarea" id="ecfr-note-edit-${n.id}">${esc(n.note)}</textarea>
            <div class="ecfr-note-actions">
                <button class="rerun-link" onclick="ecfrSaveNoteEdit(${n.id})">Save</button>
                <button class="rerun-link" onclick="ecfrCancelEditNote()">Cancel</button>
            </div>
        </div>`;
    }
    return `<div class="ecfr-note-item">
        ${ecfrWhereHtml(n)}
        <div class="ecfr-note-text">${esc(n.note)}</div>
        <div class="ecfr-note-actions">
            <span class="hint" style="font-size:var(--fs-caption);">${esc(fmtDate(n.updated_at || n.created_at))}</span>
            <button class="rerun-link" onclick="ecfrStartEditNote(${n.id})">Edit</button>
            <button class="rerun-link" onclick="ecfrDeleteNoteClick(${n.id})">Delete</button>
        </div>
    </div>`;
}

// At a wider scope the list spans sections, so each row has to say where it
// lives; rows in the section already open don't need telling.
function ecfrWhereHtml(row) {
    if (!row.section_key || row.section_key === ecfrCurrentKey) return "";
    const label = row.section_citation || row.section_key;
    return `<button class="ecfr-hl-where" title="${escAttr(row.section_heading || label)}"
        onclick="event.stopPropagation(); openEcfrSection(${escJs(row.section_key)})">
        ${esc(label)} ›</button>`;
}

function ecfrQuotePreview(quote) {
    const q = quote || "";
    return `${esc(q.slice(0, 90))}${q.length > 90 ? "…" : ""}`;
}

// One row in the panel's Highlights list: its colour/kind at a glance, the
// quoted text, and any attached comment. Clicking scrolls the reading pane
// to it; the ✕ removes it.
function ecfrHighlightItemHtml(h) {
    if (ecfrHighlightEditingId === h.id) return ecfrHighlightEditorHtml(h);
    const color = ECFR_HL_PALETTE[h.color || "yellow"] || ECFR_HL_PALETTE.yellow;
    const kind = h.kind || "highlight";
    return `<div class="ecfr-highlight-item"
        onclick="ecfrHighlightRowClick(${h.id}, ${escJs(h.section_key || "")})">
        <span class="ecfr-hl-swatch kind-${escAttr(kind)}" style="background:${color}"
            title="${escAttr(kind + " · " + (h.color || "yellow"))}"></span>
        <div class="ecfr-hl-body">
            ${ecfrWhereHtml(h)}
            <span class="ecfr-highlight-quote">"${ecfrQuotePreview(h.quote)}"</span>
            ${h.comment ? `<div class="ecfr-hl-comment">${esc(h.comment)}</div>` : ""}
        </div>
        <button class="ecfr-annot-x" title="Remove highlight"
            onclick="event.stopPropagation(); ecfrDeleteHighlightClick(${h.id})">✕</button>
    </div>`;
}

// In the open section a row scrolls to its mark; elsewhere it's a jump link.
function ecfrHighlightRowClick(id, sectionKey) {
    if (sectionKey && sectionKey !== ecfrCurrentKey) {
        openEcfrSection(sectionKey);
        return;
    }
    ecfrFocusHighlight(id);
}

function ecfrHighlightEditorHtml(h) {
    const swatches = Object.keys(ECFR_HL_PALETTE).map(c => `<button
        class="ecfr-swatch ${(h.color || "yellow") === c ? "armed" : ""}"
        style="background:${ECFR_HL_PALETTE[c]}" title="${escAttr(c)}"
        onclick="ecfrSetHighlightColor(${h.id}, ${escJs(c)})"></button>`).join("");
    const kinds = ["highlight", "underline", "strike"].map(k =>
        `<option value="${k}" ${(h.kind || "highlight") === k ? "selected" : ""}>${k}</option>`).join("");
    return `<div class="ecfr-highlight-item editing">
        <span class="ecfr-highlight-quote">"${ecfrQuotePreview(h.quote)}"</span>
        <div class="ecfr-hl-controls">
            ${swatches}
            <select class="spec-select" onchange="ecfrSetHighlightKind(${h.id}, this.value)">${kinds}</select>
        </div>
        <textarea class="ecfr-note-textarea" id="ecfr-hl-comment-${h.id}"
            placeholder="Add a comment…">${esc(h.comment || "")}</textarea>
        <div class="ecfr-note-actions">
            <button class="rerun-link" onclick="ecfrSaveHighlightComment(${h.id})">Save</button>
            <button class="rerun-link" onclick="ecfrCancelHighlightEdit()">Cancel</button>
        </div>
    </div>`;
}

// Opened by clicking a mark in the reading pane with Select armed.
function ecfrShowHighlightEditor(dbId) {
    ecfrHighlightEditingId = dbId;
    renderEcfrAnnotationsPanel();
    const ta = document.getElementById(`ecfr-hl-comment-${dbId}`);
    if (ta) ta.focus();
}

function ecfrCancelHighlightEdit() {
    ecfrHighlightEditingId = null;
    ecfrEachAnnotator((ann) => ann.cancelSelected());
    renderEcfrAnnotationsPanel();
}

function ecfrFocusHighlight(id) {
    const annoId = ecfrAnnotationIdForRow(id);
    if (!annoId || !ecfrHasAnnotator()) return;
    // The mark may be painted in more than one frame; scroll the one that
    // owns it (ecfrAnnotatorFor falls back to any instance).
    const ann = ecfrAnnotatorFor(annoId);
    if (!ann) return;
    ann.scrollIntoView(annoId);
    ann.setSelected(annoId);
}

// PATCH one highlight and reflect the result in both the panel and the mark.
async function ecfrPatchHighlight(id, fields) {
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/highlights/${id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(fields) });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        ecfrSyncPanelRow(d);
        ecfrApplyRowAppearance(d);
        renderEcfrAnnotationsPanel();
        return d;
    } catch (err) {
        console.error("Error updating highlight:", err);
        toast("Couldn't update the highlight.");
        return null;
    }
}

function ecfrSetHighlightColor(id, color) {
    if (!ECFR_HL_PALETTE[color]) return;
    ecfrPatchHighlight(id, { color });
}

function ecfrSetHighlightKind(id, kind) {
    ecfrPatchHighlight(id, { kind });
}

async function ecfrSaveHighlightComment(id) {
    const ta = document.getElementById(`ecfr-hl-comment-${id}`);
    const comment = ta ? ta.value.trim() : "";
    const saved = await ecfrPatchHighlight(id, { comment });
    if (saved) {
        ecfrHighlightEditingId = null;
        ecfrEachAnnotator((ann) => ann.cancelSelected());
        renderEcfrAnnotationsPanel();
    }
}

// The one path that stars/unstars anything, from the reader's own button or
// from any star in the tree.
//
// Callers pass ONLY a node type and key — never a label. Labels are resolved
// here from the caches, so no heading ever has to survive a round trip
// through an HTML attribute (escAttr doesn't escape apostrophes, and plenty
// of eCFR headings have them).
async function ecfrToggleFavorite(nodeType, nodeKey) {
    const meta = ecfrFavoriteMeta(nodeType, nodeKey);
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/favorites`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ node_type: nodeType, node_key: nodeKey,
                                   citation: meta.citation, label: meta.label }) });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);

        if (d.favorited) {
            ecfrFavorites = [{ id: d.favorite_id, node_type: nodeType, node_key: nodeKey,
                               citation: meta.citation, label: meta.label },
                             ...ecfrFavorites.filter(f => f.node_key !== nodeKey)];
        } else {
            ecfrFavorites = ecfrFavorites.filter(f => f.node_key !== nodeKey);
        }
        ecfrSyncFavKeys();
        // The open section's own star lives in the annotations payload.
        if (ecfrAnnotations && nodeKey === ecfrCurrentKey) {
            ecfrAnnotations.favorited = d.favorited;
            ecfrAnnotations.favorite_id = d.favorite_id;
        }
        // Both the tree (stars + pinned group) and the panel show this.
        renderEcfrToc();
        renderEcfrAnnotationsPanel();
        toast(d.favorited ? `Starred ${meta.label || nodeKey} — pinned above the table of contents.`
                          : "Removed from favorites.", "success");
    } catch (err) {
        console.error("Error updating eCFR favorite:", err);
        toast("Couldn't update the favorite.");
    }
}

// Citation + label for a node, dug out of whatever cache knows. Falls back
// to the key itself, which is always something rather than nothing.
function ecfrFavoriteMeta(nodeType, nodeKey) {
    if (nodeType === "part") {
        const p = (ecfrPartsList || []).find(x => x.part === nodeKey);
        return { citation: `40 CFR Part ${nodeKey}`,
                 label: p ? ecfrPartSubject(p.heading) : `Part ${nodeKey}` };
    }
    if (nodeType === "subpart") {
        const [part, code] = nodeKey.split("/");
        const cached = ecfrPartCache[part];
        const sp = cached && (cached.subparts || []).find(x => x.subpart === code);
        return { citation: `40 CFR Part ${part} Subpart ${code}`,
                 label: sp ? ecfrSubpartLabel(sp.heading, code) : `Subpart ${code}` };
    }
    // Section: the open one knows itself; otherwise the part's TOC does.
    if (nodeKey === ecfrCurrentKey && ecfrSection) {
        return { citation: ecfrSection.citation || "", label: ecfrSection.heading || nodeKey };
    }
    const cached = ecfrPartCache[nodeKey.split(":")[0]];
    const sec = cached && (cached.sections || []).find(x => x.section_key === nodeKey);
    return { citation: sec ? (sec.citation || "") : "",
             label: sec ? ecfrSectionLabel(sec) : nodeKey };
}

// The reader's own star button.
function ecfrToggleFavoriteClick() {
    if (!ecfrCurrentKey) return;
    ecfrToggleFavorite("section", ecfrCurrentKey);
}

async function ecfrSubmitNote() {
    const ta = document.getElementById("ecfr-note-new");
    const note = ta ? ta.value.trim() : "";
    if (!note) { toast("Enter note text first."); return; }
    const s = ecfrSection || {};
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/notes`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ section_key: ecfrCurrentKey, citation: s.citation || "",
                                   note }) });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        ecfrUpsertRow("notes", d);
        ecfrBumpCounts("notes", 1);
        renderEcfrAnnotationsPanel();
    } catch (err) {
        toast(err.message || "Couldn't save the note.");
    }
}

function ecfrStartEditNote(id) {
    ecfrNoteEditingId = id;
    renderEcfrAnnotationsPanel();
}

function ecfrCancelEditNote() {
    ecfrNoteEditingId = null;
    renderEcfrAnnotationsPanel();
}

async function ecfrSaveNoteEdit(id) {
    const ta = document.getElementById(`ecfr-note-edit-${id}`);
    const note = ta ? ta.value.trim() : "";
    if (!note) { toast("Note text can't be empty."); return; }
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/notes/${id}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ note }) });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        ecfrUpsertRow("notes", { id, note, updated_at: new Date().toISOString() });
        ecfrNoteEditingId = null;
        renderEcfrAnnotationsPanel();
    } catch (err) {
        toast("Couldn't save the note.");
    }
}

async function ecfrDeleteNoteClick(id) {
    if (!confirm("Delete this note?")) return;
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/notes/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ecfrRemoveRow("notes", id);
        ecfrBumpCounts("notes", -1);
        renderEcfrAnnotationsPanel();
    } catch (err) {
        toast("Couldn't delete the note.");
    }
}

// Panel ✕. When the highlight is painted, route the removal through the
// annotator so the mark disappears and the deletion joins the undo history;
// its deleteAnnotation handler does the DELETE. Orphans aren't painted, so
// they're deleted directly.
async function ecfrDeleteHighlightClick(id) {
    const annoId = ecfrAnnotationIdForRow(id);
    if (annoId && ecfrHasAnnotator()) {
        // Remove from every frame showing it — two local frames paint the
        // same row, and the deleteAnnotation handler does the DELETE once.
        ecfrEachAnnotator((ann) => {
            try { ann.removeAnnotation(annoId); } catch (err) { /* not in this frame */ }
        });
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/highlights/${id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        ecfrRemoveRow("highlights", id);
        ecfrBumpCounts("highlights", -1);
        ecfrOrphanedHighlights = ecfrOrphanedHighlights.filter(h => h.id !== id);
        renderEcfrAnnotationsPanel();
    } catch (err) {
        toast("Couldn't remove the highlight.");
    }
}

// --- Nav wiring ---
document.getElementById("ws-ecfr").addEventListener("click", goEcfr);
document.addEventListener("keydown", ecfrHandleReaderKeydown);
