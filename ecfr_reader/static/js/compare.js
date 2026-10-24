// =====================================================================
// ecfr-reader — the Compare tab. The reading pane has two tabs, Read and
// Compare; this is the second. The target is what the contents has in
// focus — one section, or a whole subpart when its heading was clicked
// (the sidebar feeds whichever tab is showing); pick version A and
// version B by name, press Compare, and read the difference the way git
// would print it — in a mock terminal, because that is where diffs come
// from. A whole subpart prints section by section, like a multi-file
// diff. The tab keeps its output across a swap back to Read.
//
// Loaded after ecfr.js: it borrows the viewer's caches and loaders
// (ecfrEnsureVersion, ecfrEnsureUnitVersion, ecfrEnsureLiveSection,
// ecfrFetchLiveUnit, ecfrFocus) and the diff engine (ecfrDiffBlocks,
// ecfrDiffLines); ecfr.js owns the tab strip (ecfrSetPaneTab) and calls
// cmpMount / cmpShow.
// =====================================================================

let cmpKey = null;          // what's compared: a section key ("60:60.4230") or a
                            // whole subpart as "<part>/<subpart>" ("60/OOOOb")
let cmpMeta = null;         // {citation, heading} for the prompt and headers
let cmpVersions = null;     // /api/ecfr/section/versions or /unit/versions payload, or {error}
let cmpA = null;            // source ids: "local" | "live" | "version:<date>"
let cmpB = null;
let cmpRan = false;         // the hash carries A..B only once a comparison ran
let cmpLocalCache = {};     // key -> the local section payload (/api/ecfr/section)
let cmpLiveUnits = {};      // "part/subpart" -> the live unit payload (/api/ecfr/unit/live)
let cmpRunSeq = 0;          // a run that another run overtook prints nothing
let cmpWordDiff = (() => { try { return localStorage.getItem("ecfr.compare.wordDiff") === "1"; } catch (e) { return false; } })();
let cmpCollapse = (() => { try { return localStorage.getItem("ecfr.diffCollapse") !== "0"; } catch (e) { return true; } })();

// --- entry ------------------------------------------------------------

// The shell goes into the pane's Compare tab once; a pane re-render that
// kept the skeleton keeps the terminal's output too.
function cmpMount() {
    const el = document.getElementById("ecfr-compare");
    if (!el) return;
    if (!el.querySelector(".cmp-screen")) el.innerHTML = cmpShellHtml();
    cmpRenderControls();
}

// Section keys always carry a colon; a subpart id never does.
function cmpIsUnit(key = cmpKey) {
    return !!key && !key.includes(":");
}

// What the contents has in focus: the whole subpart, or the current section.
function cmpTarget() {
    if (typeof ecfrUnitFocused === "function" && ecfrUnitFocused()) return ecfrUnitId();
    return (typeof ecfrCurrentKey !== "undefined" && ecfrCurrentKey) || null;
}

// The tab is showing (or the focus changed under it): follow the contents,
// and re-print a run whose output a rebuild of the pane lost.
async function cmpShow() {
    cmpMount();
    const key = cmpTarget();
    if (key !== cmpKey) { await cmpPickTarget(key); return; }
    cmpRenderControls();
    const out = document.getElementById("cmp-out");
    if (cmpRan && cmpA && cmpB && out && !out.querySelector(".cmp-line")) await cmpRun();
}

// From the timeline's link and from a #ecfr/compare/<key>[/<A>..<B>] link:
// open the section (or the whole subpart) in the reader, show the tab, and
// run the pair if given.
async function openEcfrCompare(key, a, b) {
    if (cmpIsUnit(key)) await openEcfrSubpart(...key.split("/"));
    else await openEcfrSection(key);
    await ecfrSetPaneTab("compare");
    if (a && b && cmpKey === key) {
        cmpA = a; cmpB = b;
        cmpRenderControls();
        await cmpRun();
    }
}

function cmpShellHtml() {
    return `<div class="cmp-screen">
        <div class="cmp-controls" id="cmp-controls"></div>
        <div class="cmp-terminal">
            <div class="cmp-titlebar"><span class="cmp-title">ecfr-reader — compare</span></div>
            <pre class="cmp-out" id="cmp-out"><span class="cmp-muted">Pick two versions, then press Compare.</span></pre>
        </div>
    </div>`;
}

// --- the control bar --------------------------------------------------

function cmpRenderControls() {
    const el = document.getElementById("cmp-controls");
    if (!el) return;
    const v = cmpVersions;
    const unit = cmpIsUnit();
    const section = cmpKey
        ? `<span class="cmp-chosen"><b>${esc(cmpMeta && cmpMeta.citation || cmpKey)}</b> ${esc(cmpMeta && cmpMeta.heading || "")}</span>`
        : `<span class="cmp-chosen cmp-muted">no section open — pick one in the contents</span>`;
    // Section or whole subpart. Only a subpart can be compared whole: an
    // appendix is one section, and loose sections aren't a division ecfr.gov
    // serves — so the switch is there but off for those.
    const canUnit = typeof ecfrUnitId === "function" && !!ecfrUnitId();
    const scope = `<span class="cmp-flags cmp-scope">
            <button class="cmp-flag ${unit ? "" : "on"}" ${cmpKey ? "" : "disabled"} onclick="cmpSetScope('section')"
                title="Compare the section you're reading">this section</button>
            <button class="cmp-flag ${unit ? "on" : ""}" ${canUnit ? "" : "disabled"} onclick="cmpSetScope('unit')"
                title="${canUnit ? "Compare every section of the subpart at once"
                    : "Only a subpart can be compared whole — an appendix is one section, and loose sections aren't a division ecfr.gov serves"}">whole subpart</button>
        </span>`;
    const options = cmpVersionOptions();
    const sel = (id, value, label) => `<label class="cmp-field"><span>${esc(label)}</span>
        <select id="${id}" class="spec-select cmp-select" ${options.length ? "" : "disabled"}
            onchange="cmpSetSide(${escJs(id === "cmp-a" ? "a" : "b")}, this.value)">${
            options.map(o => `<option value="${escAttr(o.id)}" ${o.id === value ? "selected" : ""}>${esc(o.label)}</option>`).join("")
        }</select></label>`;
    // Stacked, one thing per line, so a long section heading on the first
    // line can't push the controls under it around.
    el.innerHTML = `
        <div class="cmp-row cmp-section-line">${section}${
            v && v.loading ? `<span class="cmp-muted">loading the amendment dates…</span>` :
            v && v.error ? `<span class="cmp-muted">amendment dates unavailable: ${esc(v.error)} — Local and Live still compare</span>` :
            v && v.versions ? `<span class="cmp-muted">${v.versions.length} amendment${v.versions.length === 1 ? "" : "s"} on record since 2017${
                unit ? " across the subpart" : ""}</span>` : ""}</div>
        <div class="cmp-head">Compare:</div>
        <div class="cmp-row">${scope}</div>
        <div class="cmp-head">Options:</div>
        <div class="cmp-row">
            ${sel("cmp-a", cmpA, "A — before")}
            <button class="ecfr-btn" title="Swap A and B" onclick="cmpSwap()" ${cmpA && cmpB ? "" : "disabled"}>⇄</button>
            ${sel("cmp-b", cmpB, "B — after")}
            <span class="cmp-flags">
                <button class="cmp-flag ${cmpWordDiff ? "on" : ""}" onclick="cmpToggleFlag('wordDiff')"
                    title="One line per paragraph with the changed words marked, instead of a removed line and an added line">--word-diff</button>
                <button class="cmp-flag ${cmpCollapse ? "on" : ""}" onclick="cmpToggleFlag('collapse')"
                    title="Fold runs of unchanged paragraphs; one paragraph of context stays on each side of a change">--collapse</button>
            </span>
        </div>
        <div class="cmp-row">
            <button class="btn btn-primary" id="cmp-run" onclick="cmpRun()" ${cmpKey && cmpA && cmpB && cmpA !== cmpB ? "" : "disabled"}>Compare</button>
        </div>`;
}

function cmpVersionOptions() {
    const out = [];
    const v = cmpVersions;
    if (v && v.versions) {
        v.versions.forEach(x => out.push({ id: `version:${x.date}`,
            label: `${x.date} — ${x.sections ? `${x.sections.length} section${x.sections.length === 1 ? "" : "s"} amended` : "amended"}${
                x.substantive ? ", substantive" : ""}${x.removed ? ", removed" : ""}` }));
    }
    if (cmpKey) {
        const snap = (v && v.local_snapshot_date) || (typeof ecfrStatus !== "undefined" && ecfrStatus && ecfrStatus.snapshot_date);
        out.push({ id: "local", label: `Local snapshot${snap ? ` (${snap})` : ""}` });
        out.push({ id: "live", label: "Live ecfr.gov (today)" });
    }
    return out;
}

// The switch in the controls: it moves the reader's focus (ecfr.js owns
// that), and the tab follows the focus like it follows the contents.
function cmpSetScope(scope) {
    if (typeof ecfrFocus === "undefined") return;
    const want = scope === "unit" ? "unit" : "section";
    if (ecfrFocus === want) return;
    ecfrFocus = want;
    ecfrApplyFocus();
}

async function cmpPickTarget(key) {
    cmpKey = key; cmpMeta = null; cmpVersions = key ? { loading: true } : null; cmpA = cmpB = null; cmpRan = false;
    const out = document.getElementById("cmp-out");
    if (out) out.innerHTML = `<span class="cmp-muted">${key ? "Pick two versions, then press Compare." : "Pick a section in the contents to compare its versions."}</span>`;
    cmpRenderControls();
    syncHash(false);
    if (!key) return;
    const unit = cmpIsUnit(key);
    try {
        if (unit) {
            const [part, subpart] = key.split("/");
            const local = await cmpLocalUnit(part, subpart);
            cmpMeta = { citation: `40 CFR Part ${part}, Subpart ${subpart}`,
                        heading: `${local.heading || ""} · ${local.sections.length} section${local.sections.length === 1 ? "" : "s"}` };
        } else {
            const local = await cmpLocalSection(key);
            cmpMeta = { citation: local.citation, heading: local.heading };
        }
    } catch (e) { cmpMeta = { citation: key, heading: "" }; }
    try {
        const [part, subpart] = key.split("/");
        const res = await fetch(unit
            ? `${API_BASE}/api/ecfr/unit/versions?${new URLSearchParams({ part, subpart }).toString()}`
            : `${API_BASE}/api/ecfr/section/versions?key=${encodeURIComponent(key)}`);
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        if (cmpKey !== key) return;
        cmpVersions = d;
        const vs = d.versions || [];
        // the default pair: the latest amendment against the one before it
        if (vs.length >= 2) { cmpA = `version:${vs[vs.length - 2].date}`; cmpB = `version:${vs[vs.length - 1].date}`; }
        else if (vs.length === 1) { cmpA = `version:${vs[0].date}`; cmpB = "live"; }
        else { cmpA = "local"; cmpB = "live"; }
    } catch (err) {
        if (cmpKey !== key) return;
        cmpVersions = { error: err.message || "couldn't reach ecfr.gov" };
        cmpA = "local"; cmpB = "live";
    }
    cmpRenderControls();
}

function cmpSetSide(side, value) {
    if (side === "a") cmpA = value; else cmpB = value;
    cmpRan = false;
    cmpRenderControls();
}

function cmpSwap() {
    [cmpA, cmpB] = [cmpB, cmpA];
    cmpRan = false;
    cmpRenderControls();
}

function cmpToggleFlag(which) {
    if (which === "wordDiff") {
        cmpWordDiff = !cmpWordDiff;
        try { localStorage.setItem("ecfr.compare.wordDiff", cmpWordDiff ? "1" : "0"); } catch (e) { /* private mode */ }
    } else {
        cmpCollapse = !cmpCollapse;
        try { localStorage.setItem("ecfr.diffCollapse", cmpCollapse ? "1" : "0"); } catch (e) { /* private mode */ }
    }
    cmpRenderControls();
    if (cmpRan) cmpRun();           // re-print with the new flag; nothing is refetched
}

// --- the versions' text ---------------------------------------------

async function cmpLocalSection(key) {
    if (cmpLocalCache[key]) return cmpLocalCache[key];
    if (typeof ecfrLocalCache !== "undefined" && ecfrLocalCache[key]) return (cmpLocalCache[key] = ecfrLocalCache[key]);
    const res = await fetch(`${API_BASE}/api/ecfr/section?key=${encodeURIComponent(key)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    return (cmpLocalCache[key] = d);
}

async function cmpSideData(id, key) {
    if (cmpIsUnit(key)) return cmpUnitSideData(id, key);
    if (id === "local") return cmpLocalSection(key);
    if (id === "live") return ecfrEnsureLiveSection(key);
    if (id.startsWith("version:")) return ecfrEnsureVersion(id.slice(8), key);
    throw new Error(`unknown version ${id}`);
}

// A whole subpart on one side: {heading, sections: [...]} with blocks, one
// request per side at most (and none for the local unit already on screen).
async function cmpUnitSideData(id, unitId) {
    const [part, subpart] = unitId.split("/");
    if (id === "local") return cmpLocalUnit(part, subpart);
    if (id === "live") {
        if (!cmpLiveUnits[unitId]) cmpLiveUnits[unitId] = await ecfrFetchLiveUnit({ part, subpart });
        return cmpLiveUnits[unitId];
    }
    if (id.startsWith("version:")) return ecfrEnsureUnitVersion(id.slice(8), { part, subpart });
    throw new Error(`unknown version ${id}`);
}

async function cmpLocalUnit(part, subpart) {
    if (typeof ecfrUnit !== "undefined" && ecfrUnit && ecfrUnit.part === part && ecfrUnit.subpart === subpart
            && ecfrUnitSections.length) {
        return { heading: ecfrUnitHeading, sections: ecfrUnitSections };
    }
    const res = await fetch(`${API_BASE}/api/ecfr/unit?${new URLSearchParams({ part, subpart }).toString()}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
    return d;
}

function cmpSideName(id, data) {
    if (id === "local") return `local snapshot${data && data.as_of ? ` ${data.as_of}` : (typeof ecfrStatus !== "undefined" && ecfrStatus && ecfrStatus.snapshot_date) ? ` ${ecfrStatus.snapshot_date}` : ""}`;
    if (id === "live") return `live ecfr.gov${data && data.as_of ? ` ${data.as_of}` : ""}`;
    return `as of ${id.slice(8)}`;
}

function cmpSideArg(id) {
    return id.startsWith("version:") ? id.slice(8) : id;
}

// --- run and print --------------------------------------------------

async function cmpRun() {
    if (!cmpKey || !cmpA || !cmpB || cmpA === cmpB) return;
    const out = document.getElementById("cmp-out");
    if (!out) return;
    const seq = ++cmpRunSeq;
    const cmd = `ecfr diff ${cmpKey} ${cmpSideArg(cmpA)}..${cmpSideArg(cmpB)}${cmpWordDiff ? " --word-diff" : ""}${cmpCollapse ? "" : " --no-collapse"}`;
    out.innerHTML = cmpPromptHtml(cmd);
    let a, b;
    try {
        [a, b] = await Promise.all([cmpSideData(cmpA, cmpKey), cmpSideData(cmpB, cmpKey)]);
    } catch (err) {
        if (seq !== cmpRunSeq) return;
        cmpPrint(out, [{ kind: "err", text: `error: ${err.message || "couldn't fetch a version"}` }, { kind: "meta", text: "exit 1" }]);
        return;
    }
    const cite = (cmpMeta && cmpMeta.citation) || cmpKey;
    const head = [
        { kind: "meta", text: `--- a/${cite}  (${cmpSideName(cmpA, a)})` },
        { kind: "meta", text: `+++ b/${cite}  (${cmpSideName(cmpB, b)})` },
    ];
    let lines, counts, sections = null;
    if (cmpIsUnit()) {
        ({ lines, counts, sections } = cmpUnitDiff(a, b));
    } else {
        const parts = ecfrDiffBlocks(a.blocks || [], b.blocks || []);
        ({ lines, counts } = ecfrDiffLines(parts, { collapse: cmpCollapse, wordDiff: cmpWordDiff }));
    }
    const total = counts.changed + counts.added + counts.removed + counts.tables;
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
    const foot = total === 0
        ? [{ kind: "muted", text: "no differences between these two versions" }, { kind: "meta", text: "exit 0" }]
        : [{ kind: "muted", text: `${sections ? `${sections.changed} of ${plural(sections.total, "section")} changed${
                sections.added ? `, ${sections.added} added` : ""}${sections.removed ? `, ${sections.removed} removed` : ""} · ` : ""}${
                plural(counts.changed, "paragraph")} changed, ${counts.added} added, ${counts.removed} removed${
                counts.tables ? `, ${plural(counts.tables, "table")} changed` : ""}` },
           { kind: "meta", text: "exit 0" }];
    if (seq !== cmpRunSeq) return;
    // Identical texts print no body — like git, which prints nothing at all;
    // the header and the verdict are kept so the run still reads as a run.
    cmpPrint(out, head.concat(total === 0 ? [] : lines, foot));
    cmpRan = true;
    syncHash(true);
}

// A whole subpart, section by section — the way git prints several files:
// a ---/+++ pair naming each section that changed, its paragraph diff
// under it, and a section only one side has shown against /dev/null with
// every paragraph removed or added. Unchanged sections print one line each,
// and runs of them fold under --collapse. Sections keep A's order, with the
// ones only B has slotted in after their B predecessor.
function cmpUnitDiff(a, b) {
    const aSecs = a.sections || [], bSecs = b.sections || [];
    const aBy = new Map(aSecs.map(s => [s.section_key, s]));
    const order = aSecs.map(s => s.section_key);
    let prev = null;
    bSecs.forEach(s => {
        if (!aBy.has(s.section_key)) order.splice(prev === null ? 0 : order.indexOf(prev) + 1, 0, s.section_key);
        prev = s.section_key;
    });
    const bBy = new Map(bSecs.map(s => [s.section_key, s]));
    const counts = { changed: 0, added: 0, removed: 0, tables: 0 };
    const sections = { total: order.length, changed: 0, added: 0, removed: 0 };
    const lines = [];
    let same = [];
    const flushSame = () => {
        const rows = same.map(label => ({ kind: "muted", text: `  ${label}  (unchanged)` }));
        if (cmpCollapse && rows.length > 1) lines.push({ kind: "fold", n: rows.length, what: "section", lines: rows });
        else lines.push(...rows);
        same = [];
    };
    order.forEach(key => {
        const sa = aBy.get(key), sb = bBy.get(key);
        const sec = sb || sa;
        const name = sec.citation || key;
        const label = sec.heading || name;
        const parts = ecfrDiffBlocks(sa ? sa.blocks || [] : [], sb ? sb.blocks || [] : []);
        const r = ecfrDiffLines(parts, { collapse: cmpCollapse, wordDiff: cmpWordDiff });
        const n = r.counts.changed + r.counts.added + r.counts.removed + r.counts.tables;
        if (sa && sb && n === 0) { same.push(label); return; }
        flushSame();
        Object.keys(counts).forEach(k => { counts[k] += r.counts[k]; });
        if (!sa) sections.added++; else if (!sb) sections.removed++; else sections.changed++;
        lines.push({ kind: "sec", text: `--- ${sa ? `a/${name}` : "/dev/null"}` });
        lines.push({ kind: "sec", text: `+++ ${sb ? `b/${name}` : "/dev/null"}${sa && sb ? "" : sb ? "  (section added)" : "  (section removed)"}` });
        lines.push({ kind: "hunk", text: `@@ ${label} @@` });
        lines.push(...r.lines);
    });
    flushSame();
    return { lines, counts, sections };
}

// A two-line prompt in the style kitty users tend to run: who@where and
// the "directory" (the section, as a path under Title 40) on the first
// line, the command after a chevron on the second. The cursor at the end
// blinks while the versions are fetched and goes away when the output lands.
function cmpPromptHtml(cmd) {
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    let cwd = "~/40cfr";
    if (cmpIsUnit()) cwd += `/${cmpKey.split("/")[0]}/subpart-${cmpKey.split("/")[1]}`;
    else if (cmpKey) cwd += `/${cmpKey.split(":")[0]}/${(cmpKey.split(":")[1] || "").replace(/\s+/g, "-")}`;
    return `<span class="cmp-ps1">╭─</span> <span class="cmp-ps1-user">reader@ecfr</span> `
        + `<span class="cmp-ps1-cwd">${esc(cwd)}</span> <span class="cmp-ps1-time">${hhmm}</span>\n`
        + `<span class="cmp-ps1">╰─</span><span class="cmp-prompt">❯</span> <span class="cmp-cmd">${esc(cmd || "")}</span>`
        + `<span class="cmp-cursor" id="cmp-cursor"></span>\n`;
}

function cmpPrint(out, lines) {
    const cursor = document.getElementById("cmp-cursor");
    if (cursor) cursor.remove();
    let foldN = 0;
    const html = lines.map(l => {
        if (l.kind === "fold") {
            const id = `cmp-fold-${++foldN}`;
            return `<div class="cmp-line cmp-fold" onclick="cmpUnfold(${escJs(id)}, this)">@@ ${l.n} unchanged ${l.what || "paragraph"}${l.n === 1 ? "" : "s"} @@ <span class="cmp-muted">(click to show)</span></div>`
                + `<div class="cmp-folded" id="${id}" hidden>${l.lines.map(x => cmpLineHtml(x)).join("")}</div>`;
        }
        return cmpLineHtml(l);
    }).join("");
    out.insertAdjacentHTML("beforeend", html + cmpPromptHtml(""));
}

function cmpLineHtml(l) {
    if (l.kind === "word") {
        const body = l.ops.map(o => o.op === "-" ? `<span class="cmp-wdel">[-${esc(o.text)}-]</span>`
            : o.op === "+" ? `<span class="cmp-wins">{+${esc(o.text)}+}</span>` : esc(o.text)).join("");
        return `<div class="cmp-line cmp-word"> ${body}</div>`;
    }
    const prefix = { del: "-", ins: "+", same: " ", hunk: "", meta: "", sec: "", muted: "", err: "" }[l.kind] || "";
    return `<div class="cmp-line cmp-${l.kind}">${prefix}${esc(l.text)}</div>`;
}

function cmpUnfold(id, strip) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !el.hidden;
    const note = strip.querySelector(".cmp-muted");
    if (note) note.textContent = el.hidden ? "(click to show)" : "(click to hide)";
}
