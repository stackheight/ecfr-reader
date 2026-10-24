// =====================================================================
// ecfr-reader — the Compare workspace. Pick a section, pick version A
// and version B by name, press Compare, and read the difference the way
// git would print it — in a mock terminal, because that is where diffs
// come from and it keeps the two jobs apart: the eCFR tab is for
// reading, this tab is for comparing.
//
// Loaded after ecfr.js: it borrows the viewer's caches and loaders
// (ecfrEnsureVersion, ecfrEnsureLiveSection, ecfrEnsureFavorites,
// ecfrVersionSource) and the diff engine (ecfrDiffBlocks, ecfrDiffLines).
// =====================================================================

let cmpKey = null;          // the section being compared ("60:60.4230")
let cmpMeta = null;         // {citation, heading} for the prompt and headers
let cmpVersions = null;     // /api/ecfr/section/versions payload, or {error}
let cmpA = null;            // source ids: "local" | "live" | "version:<date>"
let cmpB = null;
let cmpRan = false;         // the hash carries A..B only once a comparison ran
let cmpLocalCache = {};     // key -> the local section payload (/api/ecfr/section)
let cmpSearchTimer = null;
let cmpHits = [];
let cmpTyping = null;
let cmpRunSeq = 0;          // a run that another run overtook prints nothing
let cmpWordDiff = (() => { try { return localStorage.getItem("ecfr.compare.wordDiff") === "1"; } catch (e) { return false; } })();
let cmpCollapse = (() => { try { return localStorage.getItem("ecfr.diffCollapse") !== "0"; } catch (e) { return true; } })();

// --- entry ------------------------------------------------------------

async function goCompare() {
    showScreen("compare");
    await renderCompare(cmpKey, null, null);
}

// From the viewer's timeline: hand the open section across.
async function openCompareFor(key) {
    showScreen("compare");
    await renderCompare(key, null, null);
}

async function renderCompare(key, a, b) {
    const el = document.getElementById("compare-workspace");
    if (!el) return;
    if (!el.querySelector(".cmp-screen")) el.innerHTML = cmpShellHtml();
    ecfrEnsureFavorites().then(cmpRenderFavorites).catch(() => {});
    if (key && key !== cmpKey) await cmpPickSection(key);
    else cmpRenderControls();
    if (key && a && b) {
        cmpA = a; cmpB = b;
        cmpRenderControls();
        await cmpRun();
    }
}

function cmpShellHtml() {
    return `<div class="cmp-screen">
        <div class="home-title">${wsGlyph("ecfr")}Compare two versions of a section</div>
        <div class="cmp-controls" id="cmp-controls"></div>
        <div class="cmp-terminal">
            <div class="cmp-titlebar"><span class="cmp-dot r"></span><span class="cmp-dot y"></span><span class="cmp-dot g"></span>
                <span class="cmp-title">ecfr-reader — compare</span></div>
            <pre class="cmp-out" id="cmp-out"><span class="cmp-muted">Pick a section and two versions, then press Compare.</span></pre>
        </div>
    </div>`;
}

// --- the control bar --------------------------------------------------

function cmpRenderControls() {
    const el = document.getElementById("cmp-controls");
    if (!el) return;
    const v = cmpVersions;
    const section = cmpKey
        ? `<span class="cmp-chosen"><b>${esc(cmpMeta && cmpMeta.citation || cmpKey)}</b> ${esc(cmpMeta && cmpMeta.heading || "")}</span>`
        : `<span class="cmp-chosen cmp-muted">no section chosen</span>`;
    const viewerKey = (typeof ecfrCurrentKey !== "undefined") ? ecfrCurrentKey : null;
    const options = cmpVersionOptions();
    const sel = (id, value, label) => `<label class="cmp-field"><span>${esc(label)}</span>
        <select id="${id}" class="spec-select cmp-select" ${options.length ? "" : "disabled"}
            onchange="cmpSetSide(${escJs(id === "cmp-a" ? "a" : "b")}, this.value)">${
            options.map(o => `<option value="${escAttr(o.id)}" ${o.id === value ? "selected" : ""}>${esc(o.label)}</option>`).join("")
        }</select></label>`;
    el.innerHTML = `
        <div class="cmp-row">
            <label class="cmp-field cmp-grow"><span>Section</span>
                <input type="search" id="cmp-search" class="ecfr-search-input" placeholder="Search Title 40 — a citation (60.4230) or words"
                    oninput="cmpSearchInput(this.value)" autocomplete="off">
                <div class="cmp-hits" id="cmp-hits"></div></label>
            <label class="cmp-field"><span>Favorites</span>
                <select id="cmp-favs" class="spec-select cmp-select" onchange="if (this.value) cmpPickSection(this.value)"><option value="">starred sections…</option></select></label>
            ${viewerKey ? `<button class="ecfr-btn" onclick="cmpPickSection(${escJs(viewerKey)})"
                title="The section open on the eCFR tab">Use ${esc(viewerKey.split(":")[1] ? "§ " + viewerKey.split(":")[1] : viewerKey)} from the viewer</button>` : ""}
        </div>
        <div class="cmp-row cmp-section-line">${section}${
            v && v.loading ? `<span class="cmp-muted">loading the amendment dates…</span>` :
            v && v.error ? `<span class="cmp-muted">amendment dates unavailable: ${esc(v.error)} — Local and Live still compare</span>` :
            v && v.versions ? `<span class="cmp-muted">${v.versions.length} amendment${v.versions.length === 1 ? "" : "s"} on record since 2017</span>` : ""}</div>
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
            <button class="btn btn-primary" id="cmp-run" onclick="cmpRun()" ${cmpKey && cmpA && cmpB && cmpA !== cmpB ? "" : "disabled"}>Compare</button>
        </div>`;
    cmpRenderFavorites();
    cmpRenderHits();
}

function cmpVersionOptions() {
    const out = [];
    const v = cmpVersions;
    if (v && v.versions) {
        v.versions.forEach(x => out.push({ id: `version:${x.date}`,
            label: `${x.date} — amended${x.substantive ? ", substantive" : ""}${x.removed ? ", removed" : ""}` }));
    }
    if (cmpKey) {
        const snap = (v && v.local_snapshot_date) || (typeof ecfrStatus !== "undefined" && ecfrStatus && ecfrStatus.snapshot_date);
        out.push({ id: "local", label: `Local snapshot${snap ? ` (${snap})` : ""}` });
        out.push({ id: "live", label: "Live ecfr.gov (today)" });
    }
    return out;
}

function cmpRenderFavorites() {
    const sel = document.getElementById("cmp-favs");
    if (!sel || typeof ecfrFavorites === "undefined") return;
    const secs = ecfrFavorites.filter(f => f.node_type === "section");
    sel.innerHTML = `<option value="">${secs.length ? "starred sections…" : "no starred sections"}</option>` +
        secs.map(f => `<option value="${escAttr(f.node_key)}" ${f.node_key === cmpKey ? "selected" : ""}>${esc(f.citation || f.node_key)} ${esc((f.label || "").slice(0, 60))}</option>`).join("");
}

function cmpSearchInput(q) {
    clearTimeout(cmpSearchTimer);
    const query = (q || "").trim();
    if (query.length < 2) { cmpHits = []; cmpRenderHits(); return; }
    cmpSearchTimer = setTimeout(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/ecfr/search?q=${encodeURIComponent(query)}&limit=8`);
            const d = await res.json();
            cmpHits = res.ok ? (d.results || []) : [];
        } catch (e) { cmpHits = []; }
        cmpRenderHits();
    }, 250);
}

function cmpRenderHits() {
    const el = document.getElementById("cmp-hits");
    if (!el) return;
    el.innerHTML = cmpHits.map(h => `<button class="cmp-hit" onclick="cmpPickSection(${escJs(h.section_key)})">
        <b>${esc(h.citation || h.section_key)}</b> ${esc((h.heading || "").slice(0, 80))}</button>`).join("");
}

async function cmpPickSection(key) {
    cmpKey = key; cmpMeta = null; cmpVersions = { loading: true }; cmpA = cmpB = null; cmpRan = false;
    cmpHits = [];
    const search = document.getElementById("cmp-search");
    if (search) search.value = "";
    cmpRenderControls();
    syncHash(true);
    try {
        const local = await cmpLocalSection(key);
        cmpMeta = { citation: local.citation, heading: local.heading };
    } catch (e) { cmpMeta = { citation: key, heading: "" }; }
    try {
        const res = await fetch(`${API_BASE}/api/ecfr/section/versions?key=${encodeURIComponent(key)}`);
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
    if (id === "local") return cmpLocalSection(key);
    if (id === "live") return ecfrEnsureLiveSection(key);
    if (id.startsWith("version:")) return ecfrEnsureVersion(id.slice(8), key);
    throw new Error(`unknown version ${id}`);
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
    out.innerHTML = `<span class="cmp-prompt">$ </span><span id="cmp-cmd"></span><span class="cmp-cursor" id="cmp-cursor"></span>\n`;
    const typed = cmpTypeCommand(cmd);
    let a, b;
    try {
        [a, b] = await Promise.all([cmpSideData(cmpA, cmpKey), cmpSideData(cmpB, cmpKey)]);
    } catch (err) {
        await typed;
        if (seq !== cmpRunSeq) return;
        cmpPrint(out, [{ kind: "err", text: `error: ${err.message || "couldn't fetch a version"}` }, { kind: "meta", text: "exit 1" }]);
        return;
    }
    const parts = ecfrDiffBlocks(a.blocks || [], b.blocks || []);
    const { lines, counts } = ecfrDiffLines(parts, { collapse: cmpCollapse, wordDiff: cmpWordDiff });
    const cite = (cmpMeta && cmpMeta.citation) || cmpKey;
    const head = [
        { kind: "meta", text: `--- a/${cite}  (${cmpSideName(cmpA, a)})` },
        { kind: "meta", text: `+++ b/${cite}  (${cmpSideName(cmpB, b)})` },
    ];
    const total = counts.changed + counts.added + counts.removed + counts.tables;
    const foot = total === 0
        ? [{ kind: "muted", text: "no differences between these two versions" }, { kind: "meta", text: "exit 0" }]
        : [{ kind: "muted", text: `${counts.changed} paragraph${counts.changed === 1 ? "" : "s"} changed, ${counts.added} added, ${counts.removed} removed${
                counts.tables ? `, ${counts.tables} table${counts.tables === 1 ? "" : "s"} changed` : ""}` },
           { kind: "meta", text: "exit 0" }];
    await typed;
    if (seq !== cmpRunSeq) return;
    // Identical texts print no body — like git, which prints nothing at all;
    // the header and the verdict are kept so the run still reads as a run.
    cmpPrint(out, head.concat(total === 0 ? [] : lines, foot));
    cmpRan = true;
    syncHash(true);
}

// The prompt line types itself — under a second even for a long command —
// unless the user asked the OS for less motion, in which case it just is.
function cmpTypeCommand(cmd) {
    const el = document.getElementById("cmp-cmd");
    if (!el) return Promise.resolve();
    if (cmpTyping) { clearInterval(cmpTyping); cmpTyping = null; }
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) { el.textContent = cmd; return Promise.resolve(); }
    const step = Math.max(8, Math.min(22, 700 / cmd.length));
    return new Promise(resolve => {
        let i = 0;
        cmpTyping = setInterval(() => {
            el.textContent = cmd.slice(0, ++i);
            if (i >= cmd.length) { clearInterval(cmpTyping); cmpTyping = null; resolve(); }
        }, step);
    });
}

function cmpPrint(out, lines) {
    const cursor = document.getElementById("cmp-cursor");
    if (cursor) cursor.remove();
    let foldN = 0;
    const html = lines.map(l => {
        if (l.kind === "fold") {
            const id = `cmp-fold-${++foldN}`;
            return `<div class="cmp-line cmp-fold" onclick="cmpUnfold(${escJs(id)}, this)">@@ ${l.n} unchanged paragraph${l.n === 1 ? "" : "s"} @@ <span class="cmp-muted">(click to show)</span></div>`
                + `<div class="cmp-folded" id="${id}" hidden>${l.lines.map(x => cmpLineHtml(x)).join("")}</div>`;
        }
        return cmpLineHtml(l);
    }).join("");
    out.insertAdjacentHTML("beforeend", html);
}

function cmpLineHtml(l) {
    if (l.kind === "word") {
        const body = l.ops.map(o => o.op === "-" ? `<span class="cmp-wdel">[-${esc(o.text)}-]</span>`
            : o.op === "+" ? `<span class="cmp-wins">{+${esc(o.text)}+}</span>` : esc(o.text)).join("");
        return `<div class="cmp-line cmp-word"> ${body}</div>`;
    }
    const prefix = { del: "-", ins: "+", same: " ", hunk: "", meta: "", muted: "", err: "" }[l.kind] || "";
    return `<div class="cmp-line cmp-${l.kind}">${prefix}${esc(l.text)}</div>`;
}

function cmpUnfold(id, strip) {
    const el = document.getElementById(id);
    if (!el) return;
    el.hidden = !el.hidden;
    const note = strip.querySelector(".cmp-muted");
    if (note) note.textContent = el.hidden ? "(click to show)" : "(click to hide)";
}

// --- Nav wiring ---
document.getElementById("ws-compare").addEventListener("click", goCompare);
