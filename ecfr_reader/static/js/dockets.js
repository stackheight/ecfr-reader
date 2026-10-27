// =====================================================================
// The Dockets tab: the regulations.gov record behind a rule. A home with
// the dockets you track and a way to add one; a docket screen with facets
// (type, subtype, format), the catalog table, and a drawer for the open
// document with its files. The catalog is built by the server's sync job
// (ecfr_reader/dockets/sync.py), polled here while it runs.
//
// Files: regulations.gov serves them only to browsers, so "Open" is a real
// link to downloads.regulations.gov in a new tab, "Keep a copy" is one
// honest server-side try, and the drop zone files a browser download back
// under the document it belongs to. Globals are dk*; every server or user
// string that reaches innerHTML goes through esc().
// =====================================================================

let dkHome = null;          // GET /api/dockets payload (tracked dockets, totals, quota, key_set)
let dkDocketId = null;      // the open docket, or null for the home
let dkDocket = null;        // GET /api/dockets/<id> (docket + summary + sync + rate)
let dkDocs = null;          // GET /api/dockets/<id>/documents payload for dkFilter
let dkFilter = { type: "", subtype: "", format: "", q: "", local: false, sort: "posted", offset: 0 };
let dkSelected = null;      // document_id open in the drawer
let dkDocument = null;      // its GET /api/dockets/documents/<id> payload
let dkPollTimer = null;     // the sync poll while a job runs
let dkSearchTimer = null;
let dkAddBusy = false;
let dkAddResults = null;    // docket search results on the home, or null
let dkAcc = { type: true, subtype: true, format: true };
let dkConfirmRemove = false;
const DK_PAGE = 100;
const DK_TYPES = ["Proposed Rule", "Rule", "Notice", "Supporting & Related Material", "Other"];
const DK_SITE = "https://www.regulations.gov";

function dkHash() {
    if (!dkDocketId) return "#dockets";
    let h = `#dockets/${encodeURIComponent(dkDocketId)}`;
    if (dkSelected) h += `/${encodeURIComponent(dkSelected)}`;
    return h;
}

// The header button and the router both land here.
async function openDockets(docketId, documentId) {
    showScreen("dockets");
    if (docketId) await dkOpen(docketId, documentId || null);
    else await dkRenderHome();
}

async function goDockets() {
    showScreen("dockets");
    if (dkDocketId) { dkRenderDocket(); return; }
    await dkRenderHome();
}

function dkFmtBytes(n) {
    if (n == null || isNaN(n)) return "";
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function dkFmtN(n) { return Number(n || 0).toLocaleString(); }

async function dkJson(url, opts) {
    const r = await fetch(`${API_BASE}${url}`, opts);
    let body = null;
    try { body = await r.json(); } catch (e) { /* no body */ }
    if (!r.ok) {
        const err = new Error((body && body.error) || `HTTP ${r.status}`);
        err.body = body; err.status = r.status;
        throw err;
    }
    return body;
}

// ── Home ───────────────────────────────────────────────────────────────

async function dkRenderHome() {
    dkStopPoll();
    dkDocketId = null; dkDocket = null; dkDocs = null; dkSelected = null; dkDocument = null;
    syncHash(false);
    const el = document.getElementById("dockets-workspace");
    if (!el) return;
    if (!dkHome) el.innerHTML = `<p class="hint" style="padding:20px;">Loading the docket catalog…</p>`;
    try {
        dkHome = await dkJson("/api/dockets");
    } catch (err) {
        el.innerHTML = `<p class="hint" style="padding:20px;">Couldn't load the docket catalog (${esc(err.message)}).</p>`;
        return;
    }
    dkPaintHome();
}

function dkQuotaHtml(rate, keySet) {
    if (!keySet) return `<div class="kpi-value warn" style="font-size:16px;">no key</div>
        <div class="kpi-sub">set <code>REGSGOV_API_KEY</code> · <a href="${escAttr(dkHome ? dkHome.signup_url : "https://api.data.gov/signup/")}"
            target="_blank" rel="noopener">free key ↗</a></div>`;
    if (!rate || rate.remaining == null) return `<div class="kpi-value" style="font-size:16px;">—</div>
        <div class="kpi-sub">known after the first request</div>`;
    const warn = rate.remaining < 100 ? " warn" : "";
    return `<div class="kpi-value${warn}">${dkFmtN(rate.remaining)}<span class="unit"> / ${dkFmtN(rate.limit)}</span></div>
        <div class="kpi-sub">requests left this hour · resets on the hour</div>`;
}

function dkPaintHome() {
    const el = document.getElementById("dockets-workspace");
    if (!el || !dkHome) return;
    const t = dkHome.totals || {};
    let html = `<div class="home-title">Dockets — the regulations.gov record behind a rule</div>
    <div class="kpis">
        <div class="kpi"><div class="kpi-label">Tracked dockets</div>
            <div class="kpi-value">${dkFmtN(t.dockets)}</div>
            <div class="kpi-sub">catalogued on this machine</div></div>
        <div class="kpi"><div class="kpi-label">Documents</div>
            <div class="kpi-value">${dkFmtN(t.documents)}</div>
            <div class="kpi-sub">rules, notices, supporting material</div></div>
        <div class="kpi"><div class="kpi-label">Files</div>
            <div class="kpi-value">${dkFmtN(t.local_files)}<span class="unit"> / ${dkFmtN(t.files)}</span></div>
            <div class="kpi-sub">kept here / known</div></div>
        <div class="kpi" title="api.data.gov allows 1,000 requests an hour per key; a sync keeps 25 unspent for browsing."><div class="kpi-label">API quota</div>
            ${dkQuotaHtml(dkHome.rate, dkHome.key_set)}</div>
    </div>`;

    if (!dkHome.key_set) {
        html += `<div class="fac-table-card dk-keycard"><div style="padding:18px 20px;">
            <p class="hint">The Dockets tab asks regulations.gov for a docket's documents and
            file lists. That needs an <b>api.data.gov key</b> — free, instant, one form at
            <a href="${escAttr(dkHome.signup_url)}" target="_blank" rel="noopener">${esc(dkHome.signup_url)}</a>.
            Then start the server with it:</p>
            <pre class="ecfr-code">export REGSGOV_API_KEY=your-key-here      # PowerShell: $env:REGSGOV_API_KEY = "your-key-here"
python -m ecfr_reader serve</pre>
            <p class="hint">Dockets already catalogued below still open without a key; adding or syncing one needs it.</p>
        </div></div>`;
    }

    html += `<div class="comp-section-head">Add a docket</div>
    <div class="home-toolbar dk-add">
        <input type="search" id="dk-add-input" placeholder="A docket ID such as EPA-HQ-OAR-2021-0317, or words to search EPA's dockets…"
            autocomplete="off" ${dkHome.key_set ? "" : "disabled"}
            onkeydown="if (event.key === 'Enter') dkAddSubmit()">
        <button class="btn btn-primary" onclick="dkAddSubmit()" ${dkHome.key_set && !dkAddBusy ? "" : "disabled"}>${dkAddBusy ? "Working…" : "Add"}</button>
        <span class="hint">An ID is tracked and catalogued at once; words search regulations.gov (one request) and you pick.</span>
    </div>`;
    if (dkAddResults) {
        html += `<div class="fac-table-card" style="margin-bottom:16px;"><table class="fac-table"><thead><tr>
            <th>Docket</th><th>Title</th><th>Type</th><th>Modified</th><th></th></tr></thead><tbody>`;
        if (!dkAddResults.length) html += `<tr><td colspan="5" class="muted">Nothing matched on regulations.gov.</td></tr>`;
        for (const r of dkAddResults) {
            html += `<tr><td class="muted">${esc(r.id)}</td><td><div class="fac-name">${esc(r.title || "")}</div></td>
                <td class="muted">${esc(r.docketType || "")}</td><td class="muted">${esc(fmtDate(r.lastModifiedDate))}</td>
                <td><button class="btn btn-sm btn-quiet" onclick="dkAdd(${escJs(r.id)})">Track</button></td></tr>`;
        }
        html += `</tbody></table></div>`;
    }

    html += `<div class="comp-section-head">Tracked dockets</div>`;
    const rows = dkHome.dockets || [];
    if (!rows.length) {
        html += `<div class="fac-table-card"><div style="padding:18px 20px;"><p class="hint">None yet. Add one above —
            the docket for a rule is printed in its Federal Register notice ("Docket ID No. EPA-HQ-OAR-2021-0317")
            and in the eCFR's source notes.</p></div></div>`;
    } else {
        html += `<div class="fac-table-card"><table class="fac-table"><thead><tr>
            <th>Docket</th><th>Title</th><th class="num">Documents</th><th class="num">Files kept</th><th>Catalog</th>
            </tr></thead><tbody>`;
        for (const d of rows) {
            html += `<tr onclick="dkOpen(${escJs(d.docket_id)})">
                <td class="muted">${esc(d.docket_id)}</td>
                <td><div class="fac-name">${esc(d.short_title || d.title || "")}</div>
                    <div class="hint" style="margin:2px 0 0;">${esc(d.agency_id || "")}${d.docket_type ? " · " + esc(d.docket_type) : ""}${d.rin && d.rin !== "Not Assigned" ? " · RIN " + esc(d.rin) : ""}</div></td>
                <td class="num">${dkFmtN(d.document_count)}${d.pending_count ? `<span class="hint" title="documents whose file lists are not fetched yet"> (${dkFmtN(d.pending_count)} pending)</span>` : ""}</td>
                <td class="num">${dkFmtN(d.local_count)}<span class="unit"> / ${dkFmtN(d.file_count)}</span></td>
                <td class="muted">${dkSyncShort(d.sync_state, d.synced_at)}</td></tr>`;
        }
        html += `</tbody></table></div>`;
    }
    el.innerHTML = html;
}

function dkSyncShort(state, syncedAt) {
    if (!state) return "never synced";
    if (state.phase === "done" && !state.stopped_reason) return `complete · ${fmtDate(state.finished_at || syncedAt)}`;
    const names = { quota: "paused (quota)", rate_limited: "paused (429)", cancelled: "stopped",
                    files_refused: "catalog done · files refused", error: "failed" };
    if (state.stopped_reason) return names[state.stopped_reason] || state.stopped_reason;
    return `${state.phase} ${state.done}/${state.total}`;
}

function dkLooksLikeId(s) {
    return /^[A-Za-z]{2,}[A-Za-z0-9]*(-[A-Za-z0-9]+){2,}$/.test(s) && /\d/.test(s);
}

async function dkAddSubmit() {
    const input = document.getElementById("dk-add-input");
    const value = (input ? input.value : "").trim();
    if (!value || dkAddBusy) return;
    if (dkLooksLikeId(value)) { await dkAdd(value.toUpperCase()); return; }
    dkAddBusy = true; dkPaintHome();
    try {
        const r = await dkJson(`/api/dockets/search?q=${encodeURIComponent(value)}&agency=EPA`);
        dkAddResults = r.results || [];
    } catch (err) {
        toast(err.message);
    } finally {
        dkAddBusy = false;
        dkPaintHome();
        const again = document.getElementById("dk-add-input");
        if (again) again.value = value;
    }
}

async function dkAdd(docketId) {
    if (dkAddBusy) return;
    dkAddBusy = true; dkPaintHome();
    try {
        const r = await dkJson("/api/dockets", { method: "POST", headers: { "Content-Type": "application/json" },
                                                body: JSON.stringify({ docket_id: docketId, pull: "data" }) });
        dkAddResults = null;
        toast(`Tracking ${r.docket.docket_id} — cataloguing in the background.`, "ok");
        await dkOpen(r.docket.docket_id);
    } catch (err) {
        toast(err.message);
    } finally {
        dkAddBusy = false;
        if (!dkDocketId) dkPaintHome();
    }
}

// ── A docket ───────────────────────────────────────────────────────────

async function dkOpen(docketId, documentId = null) {
    const changed = dkDocketId !== docketId;
    dkDocketId = docketId;
    if (changed) {
        dkDocket = null; dkDocs = null; dkDocument = null;
        dkFilter = { type: "", subtype: "", format: "", q: "", local: false, sort: "posted", offset: 0 };
        dkConfirmRemove = false;
    }
    dkSelected = documentId;
    dkRenderDocket();                     // the shell, with "loading" where data is missing
    syncHash(changed);
    try {
        await Promise.all([dkLoadDocket(), dkLoadDocs()]);
    } catch (err) {
        const el = document.getElementById("dockets-workspace");
        if (el) el.innerHTML = `<p class="hint" style="padding:20px;">${esc(err.message)} <button class="btn btn-sm btn-quiet" onclick="dkRenderHome()">Back to dockets</button></p>`;
        return;
    }
    if (dkSelected) await dkSelect(dkSelected, { keepHash: true });
    dkRenderDocket();
    if (dkDocket.sync && dkDocket.sync.running) dkStartPoll();
}

async function dkLoadDocket() {
    dkDocket = await dkJson(`/api/dockets/${encodeURIComponent(dkDocketId)}`);
}

async function dkLoadDocs() {
    const f = dkFilter;
    const q = new URLSearchParams();
    if (f.type) q.set("type", f.type);
    if (f.subtype) q.set("subtype", f.subtype);
    if (f.format) q.set("format", f.format);
    if (f.q) q.set("q", f.q);
    if (f.local) q.set("local", "1");
    q.set("sort", f.sort); q.set("offset", String(f.offset)); q.set("limit", String(DK_PAGE));
    dkDocs = await dkJson(`/api/dockets/${encodeURIComponent(dkDocketId)}/documents?${q}`);
}

function dkRenderDocket() {
    const el = document.getElementById("dockets-workspace");
    if (!el) return;
    if (!el.querySelector(".dk-docket")) {
        el.innerHTML = `<div class="ecfr-reader dk-docket">
            <div class="ecfr-toc dk-facets" id="dk-facets"></div>
            <div class="ecfr-toc-resizer" title="Drag to resize; double-click to reset"
                onpointerdown="dkResizeStart(event)" ondblclick="dkResize(null)"></div>
            <div class="ecfr-pane dk-main" id="dk-main"></div>
            <div class="ecfr-annotations dk-drawer" id="dk-drawer"></div>
        </div>`;
        const saved = (typeof ecfrTocWidth === "function") ? ecfrTocWidth() : null;
        if (saved) dkResize(saved);
    }
    dkRenderFacets();
    dkRenderMain();
    dkRenderDrawer();
}

// The facets rail shares the contents rail's remembered width.
function dkResize(px) {
    const grid = document.querySelector(".dk-docket");
    if (!grid) return;
    if (px === null) { grid.style.removeProperty("--toc-w"); return; }
    grid.style.setProperty("--toc-w", `${Math.round(Math.max(220, Math.min(px, window.innerWidth * 0.6)))}px`);
}

function dkResizeStart(e) {
    const rail = document.getElementById("dk-facets");
    if (!rail || e.button !== 0) return;
    e.preventDefault();
    const left = rail.getBoundingClientRect().left;
    const handle = e.currentTarget;
    handle.classList.add("dragging");
    document.body.classList.add("ecfr-resizing");
    const move = ev => dkResize(ev.clientX - left);
    const stop = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stop);
        handle.classList.remove("dragging");
        document.body.classList.remove("ecfr-resizing");
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
}

// ── Facets ─────────────────────────────────────────────────────────────

function dkAccToggled(id, open) { dkAcc[id] = open; }

function dkFacetGroup(id, title, entries, key) {
    // entries: [[label, count]] ; key: the dkFilter field
    const current = dkFilter[key];
    const total = entries.reduce((n, e) => n + e[1], 0);
    const row = (label, count, value) => `<button class="dk-facet ${current === value ? "active" : ""}"
        onclick="dkSetFilter(${escJs(key)}, ${escJs(value)})" title="${escAttr(label)}">
        <span class="dk-facet-label">${esc(label)}</span><span class="dk-facet-n">${dkFmtN(count)}</span></button>`;
    let body = row("All", total, "");
    for (const [label, count] of entries) body += row(label || "(none)", count, label);
    return `<details class="ecfr-acc" ${dkAcc[id] ? "open" : ""} ontoggle="dkAccToggled(${escJs(id)}, this.open)">
        <summary>${esc(title)}<span class="ecfr-acc-n">${entries.length}</span></summary>
        <div class="ecfr-acc-body dk-facet-list">${body}</div></details>`;
}

function dkRenderFacets() {
    const el = document.getElementById("dk-facets");
    if (!el) return;
    const s = (dkDocket && dkDocket.summary) || { types: {}, subtypes: {}, formats: {} };
    const types = DK_TYPES.filter(t => s.types[t]).map(t => [t, s.types[t]]);
    for (const t of Object.keys(s.types)) if (!DK_TYPES.includes(t)) types.push([t, s.types[t]]);
    const subtypes = Object.entries(s.subtypes).filter(([k]) => k).sort((a, b) => b[1] - a[1]);
    const formats = Object.entries(s.formats).filter(([k]) => k).sort((a, b) => b[1] - a[1]);
    el.innerHTML = `<div class="ecfr-search">
            <input type="search" id="dk-search-input" class="ecfr-search-input" placeholder="Search titles and abstracts…"
                autocomplete="off" value="${escAttr(dkFilter.q)}" oninput="dkSearchInput(this.value)">
            ${dkFilter.q ? `<button class="ecfr-search-x" title="Clear" onclick="dkSetFilter('q', '')">✕</button>` : ""}
        </div>
        <div class="dk-facet-scroll">
        ${dkFacetGroup("type", "Type", types, "type")}
        ${dkFacetGroup("subtype", "Subtype", subtypes, "subtype")}
        ${dkFacetGroup("format", "File format", formats, "format")}
        <label class="dk-local-toggle"><input type="checkbox" ${dkFilter.local ? "checked" : ""}
            onchange="dkSetFilter('local', this.checked)"> Only documents with a copy kept here
            <span class="ecfr-acc-n">${dkFmtN(s.local_files)}</span></label>
        </div>`;
}

function dkSearchInput(value) {
    clearTimeout(dkSearchTimer);
    dkSearchTimer = setTimeout(() => dkSetFilter("q", value.trim(), { keepInput: true }), 250);
}

async function dkSetFilter(key, value, opts = {}) {
    if (dkFilter[key] === value) return;
    dkFilter[key] = value;
    dkFilter.offset = 0;
    try { await dkLoadDocs(); } catch (err) { toast(err.message); return; }
    dkRenderMain();
    if (!opts.keepInput) dkRenderFacets();
    else {                                             // repaint the facet buttons, keep the caret
        const input = document.getElementById("dk-search-input");
        const pos = input ? input.selectionStart : null;
        dkRenderFacets();
        const again = document.getElementById("dk-search-input");
        if (again && pos !== null) { again.focus(); again.setSelectionRange(pos, pos); }
    }
}

async function dkPage(delta) {
    dkFilter.offset = Math.max(0, dkFilter.offset + delta * DK_PAGE);
    try { await dkLoadDocs(); } catch (err) { toast(err.message); return; }
    dkRenderMain();
    const main = document.getElementById("dk-main");
    if (main) main.scrollTop = 0;
}

async function dkSort(sort) {
    dkFilter.sort = dkFilter.sort === sort ? (sort === "posted" ? "-posted" : "posted") : sort;
    dkFilter.offset = 0;
    try { await dkLoadDocs(); } catch (err) { toast(err.message); return; }
    dkRenderMain();
}

// ── Main column: header, sync bar, table ───────────────────────────────

function dkKeywordHtml(k) {
    const m = /40 CFR part (\d+) subpart ([A-Za-z]+)/.exec(k);
    if (m) return `<a class="dk-chip dk-chip-link" href="#ecfr/read/${m[1]}/${m[2]}" title="Open in the reader">${esc(k)}</a>`;
    return `<span class="dk-chip">${esc(k)}</span>`;
}

function dkPhaseText(s) {
    const n = `${dkFmtN(s.done)} / ${dkFmtN(s.total)}`;
    switch (s.phase) {
        case "docket": return "Fetching the docket record…";
        case "list": return `Listing documents by type (${n})…`;
        case "details": return `Fetching each document's abstract and file list (${n})…`;
        case "comments": return `Counting public comments on the rules (${n})…`;
        case "files": return `Keeping files (${n})…`;
        case "done": return "Catalog complete";
    }
    return s.phase || "";
}

function dkSyncBarHtml() {
    const s = (dkDocket && dkDocket.sync) || {};
    const keySet = dkDocket && dkDocket.key_set;
    const running = !!s.running;
    const rate = dkDocket && dkDocket.rate;
    let status, cls = "";
    if (running) status = dkPhaseText(s);
    else if (!s.phase) status = "Not catalogued yet.";
    else if (s.stopped_reason === "files_refused") { status = `Catalog complete. ${s.message || ""}`; cls = "warn"; }
    else if (s.stopped_reason) { status = `${dkPhaseText(s)} — ${s.message || s.stopped_reason}`; cls = s.stopped_reason === "error" ? "danger" : "warn"; }
    else status = `Catalog complete · ${fmtDate(s.finished_at)} · ${dkFmtN(s.requests)} requests`;
    const pct = running && s.total ? Math.round(100 * s.done / s.total) : null;
    const quota = rate && rate.remaining != null ? `<span class="hint" title="api.data.gov: requests left this hour for your key">quota ${dkFmtN(rate.remaining)} / ${dkFmtN(rate.limit)}</span>` : "";
    const pulls = (dkDocket && dkDocket.sync && dkDocket.sync.pull) || [];
    return `<div class="dk-sync ${cls}">
        <div class="dk-sync-status">${running ? `<span class="dk-spin"></span>` : ""}${esc(status)}
            ${pct !== null ? `<span class="dk-bar"><span style="width:${pct}%"></span></span>` : ""}</div>
        <div class="dk-sync-actions">
            ${quota}
            ${running ? `<button class="btn btn-sm btn-quiet" onclick="dkStopSync()">Stop</button>`
                      : `<button class="btn btn-sm btn-primary" onclick="dkSync('data')" ${keySet ? "" : "disabled"}
                            title="Catalog every document and file list; download the data files (${escAttr((pulls.length ? pulls : (dkHome && dkHome.auto_pull) || ["xlsx", "xls", "csv", "zip"]).join(", "))}). Resumes where it stopped.">Sync</button>
                         <button class="btn btn-sm btn-quiet" onclick="dkSync('all')" ${keySet ? "" : "disabled"}
                            title="Also try to keep every PDF. The file host usually refuses the server; the drop zone is the sure way.">Sync + all files</button>`}
            ${!keySet ? `<span class="hint">needs <code>REGSGOV_API_KEY</code></span>` : ""}
        </div></div>`;
}

function dkRenderMain() {
    const el = document.getElementById("dk-main");
    if (!el) return;
    if (!dkDocket) { el.innerHTML = `<p class="hint" style="padding:20px;">Loading…</p>`; return; }
    const d = dkDocket, s = d.summary || {};
    const abstract = d.abstract || "";
    let html = `<div class="ecfr-pane-nav dk-nav">
        <button class="btn btn-sm btn-quiet" onclick="dkRenderHome()">← Dockets</button>
        <span class="hint">${esc(d.agency_id || "")}${d.docket_type ? " · " + esc(d.docket_type) : ""}${d.rin && d.rin !== "Not Assigned" ? " · RIN " + esc(d.rin) : ""} · modified ${esc(fmtDate(d.modify_date))}</span>
        <a class="btn btn-sm btn-quiet" href="${DK_SITE}/docket/${encodeURIComponent(d.docket_id)}" target="_blank" rel="noopener">regulations.gov ↗</a>
    </div>
    <div class="dk-head">
        <div class="dk-id">${esc(d.docket_id)}</div>
        <h2 class="dk-title">${esc(d.title || d.short_title || "")}</h2>
        ${d.short_title && d.short_title !== d.title ? `<div class="dk-short">${esc(d.short_title)}</div>` : ""}
        ${abstract ? `<details class="dk-abstract"><summary>Abstract</summary><p>${esc(abstract)}</p></details>` : ""}
        ${(d.keywords || []).length ? `<div class="dk-chips">${d.keywords.map(dkKeywordHtml).join("")}</div>` : ""}
    </div>
    ${dkSyncBarHtml()}`;

    const docs = dkDocs || { total: 0, rows: [] };
    const from = docs.total ? dkFilter.offset + 1 : 0, to = Math.min(dkFilter.offset + DK_PAGE, docs.total);
    const filtered = dkFilter.type || dkFilter.subtype || dkFilter.format || dkFilter.q || dkFilter.local;
    const th = (label, sort, cls = "") => `<th class="${cls} ${dkFilter.sort === sort || dkFilter.sort === "-" + sort ? "sorted" : ""}"
        onclick="dkSort(${escJs(sort)})">${label}${dkFilter.sort === sort ? " ▾" : dkFilter.sort === "-" + sort ? " ▴" : ""}</th>`;
    html += `<div class="dk-table-head">
        <span>${dkFmtN(docs.total)} document${docs.total === 1 ? "" : "s"}${filtered ? ` match · <button class="dk-linkbtn" onclick="dkClearFilters()">clear filters</button>` : ""}
            ${s.pending ? `<span class="hint" title="documents whose abstract and file list are not fetched yet"> · ${dkFmtN(s.pending)} without file lists yet</span>` : ""}</span>
        <span class="dk-pager">${from}–${to} of ${dkFmtN(docs.total)}
            <button class="btn btn-sm btn-quiet" onclick="dkPage(-1)" ${dkFilter.offset ? "" : "disabled"}>‹</button>
            <button class="btn btn-sm btn-quiet" onclick="dkPage(1)" ${to < docs.total ? "" : "disabled"}>›</button></span>
    </div>
    <div class="fac-table-card dk-table-card"><table class="fac-table dk-table"><thead><tr>
        ${th("Posted", "posted")}${th("Type", "type")}<th>Subtype</th>${th("Title", "title")}<th>Files</th><th class="num">Comments</th>
    </tr></thead><tbody>`;
    if (!docs.rows.length) {
        html += `<tr><td colspan="6" class="muted">${dkDocket.sync && dkDocket.sync.running ? "Cataloguing… rows appear as they arrive."
            : filtered ? "Nothing matches these filters." : "No documents catalogued yet — press Sync."}</td></tr>`;
    }
    for (const r of docs.rows) {
        const sel = r.document_id === dkSelected ? " selected" : "";
        html += `<tr class="dk-row${sel}${r.withdrawn ? " withdrawn" : ""}" onclick="dkSelect(${escJs(r.document_id)})">
            <td class="muted">${esc(fmtDate(r.posted_date))}</td>
            <td class="muted">${esc(dkTypeShort(r.document_type))}</td>
            <td class="muted dk-subtype">${esc(r.subtype || "")}</td>
            <td><div class="dk-doc-title">${esc(r.title || r.document_id)}</div>
                <div class="hint dk-doc-id">${esc(r.document_id)}${r.fr_doc_num ? " · FR Doc. " + esc(r.fr_doc_num) : ""}${r.withdrawn ? " · withdrawn" : ""}</div></td>
            <td class="dk-files">${r.has_detail ? dkBadgesHtml(r.files) : `<span class="hint" title="file list not fetched yet">…</span>`}</td>
            <td class="num">${r.comment_count != null ? dkFmtN(r.comment_count) : ""}</td></tr>`;
    }
    html += `</tbody></table></div>`;
    el.innerHTML = html;
}

function dkTypeShort(t) {
    return t === "Supporting & Related Material" ? "Supporting" : (t || "");
}

function dkBadgesHtml(files) {
    if (!files || !files.length) return `<span class="hint">no files</span>`;
    return files.map(f => `<span class="dk-badge${f.local ? " local" : ""}${f.restricted ? " restricted" : ""}" data-format="${escAttr(f.format || "")}"
        title="${escAttr((f.attachment_title || "the document") + (f.size ? " · " + dkFmtBytes(f.size) : "") + (f.local ? " · copy kept here" : "") + (f.restricted ? " · restricted: " + f.restricted : ""))}">${esc(f.format || "file")}${f.size ? `<i>${esc(dkFmtBytes(f.size))}</i>` : ""}</span>`).join("");
}

async function dkClearFilters() {
    dkFilter = { ...dkFilter, type: "", subtype: "", format: "", q: "", local: false, offset: 0 };
    try { await dkLoadDocs(); } catch (err) { toast(err.message); return; }
    dkRenderMain(); dkRenderFacets();
}

// ── Sync control and polling ───────────────────────────────────────────

async function dkSync(pull) {
    try {
        await dkJson(`/api/dockets/${encodeURIComponent(dkDocketId)}/sync`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pull, retry_files: pull === "all" }) });
    } catch (err) {
        toast(err.message);
        return;
    }
    await dkLoadDocket().catch(() => {});
    dkRenderMain();
    dkStartPoll();
}

async function dkStopSync() {
    try { await dkJson(`/api/dockets/${encodeURIComponent(dkDocketId)}/sync`, { method: "DELETE" }); }
    catch (err) { toast(err.message); }
}

function dkStartPoll() {
    dkStopPoll();
    dkPollTimer = setInterval(dkPoll, 2000);
}

function dkStopPoll() {
    if (dkPollTimer) clearInterval(dkPollTimer);
    dkPollTimer = null;
}

async function dkPoll() {
    if (!dkDocketId || appScreen !== "dockets") { dkStopPoll(); return; }
    try {
        await Promise.all([dkLoadDocket(), dkLoadDocs()]);
    } catch (err) {
        dkStopPoll();
        return;
    }
    dkRenderFacets();
    dkRenderMain();
    if (dkSelected && dkDocument && !dkDocument.has_detail) dkSelect(dkSelected, { keepHash: true, quiet: true });
    if (!(dkDocket.sync && dkDocket.sync.running)) {
        dkStopPoll();
        if (dkHome) dkHome = null;        // the home's totals are stale now
    }
}

// ── The drawer: one document and its files ─────────────────────────────

async function dkSelect(documentId, opts = {}) {
    const changed = dkSelected !== documentId;
    dkSelected = documentId;
    if (!opts.quiet) dkRenderMain();      // the selected row
    try {
        dkDocument = await dkJson(`/api/dockets/documents/${encodeURIComponent(documentId)}`);
    } catch (err) {
        if (!opts.quiet) toast(err.message);
        dkDocument = null;
    }
    dkRenderDrawer();
    if (!opts.keepHash) syncHash(changed);
}

function dkCloseDrawer() {
    dkSelected = null; dkDocument = null;
    dkRenderMain(); dkRenderDrawer();
    syncHash(false);
}

function dkFileRowHtml(f) {
    const name = f.attachment_title ? f.attachment_title : (f.doc_order === 0 ? "The document" : "Added by you");
    const local = f.local ? `<a class="btn btn-sm btn-ok" href="${API_BASE}/api/dockets/files/${f.id}" target="_blank" rel="noopener"
            title="The copy kept here (${escAttr(dkFmtBytes(f.local_size))})">Kept copy ↗</a>` : "";
    const open = f.file_url ? `<a class="btn btn-sm btn-quiet" href="${escAttr(f.file_url)}" target="_blank" rel="noopener"
            title="Opens on downloads.regulations.gov in a new tab">Open ↗</a>` : "";
    const keep = f.file_url && !f.local ? `<button class="btn btn-sm btn-quiet" onclick="dkFetchFile(${f.id})"
            title="One try at downloading it here. The host usually only serves browsers; if it refuses, open it and drop the download below.">Keep a copy</button>` : "";
    return `<div class="dk-file${f.local ? " local" : ""}">
        <div class="dk-file-head">${dkBadgesHtml([f])}<span class="dk-file-name">${esc(name)}</span></div>
        <div class="dk-file-actions">${open}${keep}${local}</div>
        ${f.restricted ? `<div class="hint dk-file-err">Restricted: ${esc(f.restricted)}</div>` : ""}
        ${f.download_error && !f.local ? `<div class="hint dk-file-err">${esc(f.download_error)}</div>` : ""}
    </div>`;
}

function dkRenderDrawer() {
    const el = document.getElementById("dk-drawer");
    if (!el) return;
    if (!dkSelected) {
        el.innerHTML = `<div class="dk-drawer-empty"><p class="hint">Select a document to see its abstract and files.</p>
            <p class="hint">Files open on regulations.gov in a new tab (its file host serves browsers only).
            To keep one here, drop the download on the document.</p></div>`;
        return;
    }
    const d = dkDocument;
    if (!d) { el.innerHTML = `<div class="dk-drawer-empty"><p class="hint">Loading ${esc(dkSelected)}…</p></div>`; return; }
    const detail = d.detail || {};
    const meta = [];
    if (d.posted_date) meta.push(["Posted", fmtDate(d.posted_date)]);
    if (d.document_type) meta.push(["Type", d.document_type + (d.subtype ? " · " + d.subtype : "")]);
    if (d.fr_citation || d.fr_doc_num) meta.push(["Federal Register", [d.fr_citation, d.fr_doc_num ? "FR Doc. " + d.fr_doc_num : ""].filter(Boolean).join(" · ")]);
    if (d.comment_start || d.comment_end) meta.push(["Comment period", `${fmtDate(d.comment_start)} → ${fmtDate(d.comment_end)}${d.open_for_comment ? " (open)" : ""}`]);
    if (d.comment_count != null) meta.push(["Public comments", dkFmtN(d.comment_count)]);
    if (d.cfr_part) meta.push(["CFR", d.cfr_part]);
    if (d.page_count) meta.push(["Pages", dkFmtN(d.page_count)]);
    if (detail.authors && detail.authors.length) meta.push(["Authors", detail.authors.join("; ")]);
    el.innerHTML = `<div class="dk-drawer-head">
            <span class="hint">${esc(d.document_id)}</span>
            <button class="ecfr-search-x" title="Close" onclick="dkCloseDrawer()">✕</button>
        </div>
        <h3 class="dk-drawer-title">${esc(d.title || d.document_id)}</h3>
        <div class="dk-drawer-links">
            <a class="btn btn-sm btn-quiet" href="${DK_SITE}/document/${encodeURIComponent(d.document_id)}" target="_blank" rel="noopener">regulations.gov ↗</a>
        </div>
        <dl class="dk-meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
        ${d.abstract ? `<p class="dk-drawer-abstract">${esc(d.abstract)}</p>` : (d.has_detail ? "" : `<p class="hint">Abstract and file list not fetched yet — they arrive with the sync.</p>`)}
        <div class="comp-section-head" style="margin-top:14px;">Files <span class="comp-section-sub">${d.files.length}</span></div>
        ${d.files.map(dkFileRowHtml).join("") || `<p class="hint">${d.has_detail ? "This document has no files." : ""}</p>`}
        <div class="dk-drop" id="dk-drop" ondragover="dkDragOver(event)" ondragleave="dkDragLeave(event)" ondrop="dkDrop(event)">
            <div><b>Drop a downloaded file here</b> to keep it under this document.</div>
            <div class="hint">It is matched to the file it is (format and size), else kept as an extra.
                <label class="dk-linkbtn">or choose a file<input type="file" multiple hidden onchange="dkUpload(this.files)"></label></div>
        </div>`;
}

async function dkFetchFile(fileId) {
    try {
        await dkJson(`/api/dockets/files/${fileId}/fetch`, { method: "POST" });
        toast("Copy kept.", "ok");
    } catch (err) {
        toast(err.message);
    }
    if (dkSelected) await dkSelect(dkSelected, { keepHash: true, quiet: true });
    dkLoadDocs().then(dkRenderMain).catch(() => {});
}

function dkDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    e.currentTarget.classList.add("dragging");
}

function dkDragLeave(e) { e.currentTarget.classList.remove("dragging"); }

function dkDrop(e) {
    e.preventDefault();
    e.currentTarget.classList.remove("dragging");
    dkUpload(e.dataTransfer.files);
}

async function dkUpload(files) {
    if (!dkSelected || !files || !files.length) return;
    const drop = document.getElementById("dk-drop");
    if (drop) drop.classList.add("busy");
    let kept = 0, extra = 0;
    for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file, file.name);
        try {
            const r = await dkJson(`/api/dockets/documents/${encodeURIComponent(dkSelected)}/upload`, { method: "POST", body: form });
            if (r.matched) kept++; else extra++;
        } catch (err) {
            toast(`${file.name}: ${err.message}`);
        }
    }
    if (kept || extra) toast(`${kept ? `${kept} filed under its catalogued entry` : ""}${kept && extra ? ", " : ""}${extra ? `${extra} kept as extra` : ""}.`, "ok");
    await dkSelect(dkSelected, { keepHash: true, quiet: true });
    dkLoadDocs().then(dkRenderMain).catch(() => {});
    dkLoadDocket().then(dkRenderFacets).catch(() => {});
}

// ── Untrack ────────────────────────────────────────────────────────────

async function dkRemove(withFiles) {
    if (!dkDocketId) return;
    try {
        await dkJson(`/api/dockets/${encodeURIComponent(dkDocketId)}${withFiles ? "?files=1" : ""}`, { method: "DELETE" });
        toast("Docket untracked.", "ok");
        dkHome = null;
        await dkRenderHome();
    } catch (err) {
        toast(err.message);
    }
}

// --- Nav wiring ---
document.getElementById("ws-dockets").addEventListener("click", goDockets);
