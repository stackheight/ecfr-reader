// =====================================================================
// ecfr-reader — the page's shared globals, in one classic script loaded
// before ecfr-annotator.js, ecfr-diff.js and ecfr.js: escaping helpers,
// toasts, the single-screen "router" (the hash is #ecfr, #ecfr/read/<key>
// or #ecfr/compare/<key>/<A>..<B>, where <key> is a section key such as
// 60:60.4230 or a whole subpart as <part>/<subpart>), and the light / dark theme.
// =====================================================================

const API_BASE = "";
let appScreen = "ecfr";

// ── Escaping — any user-entered string interpolated into innerHTML ──
function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
}

function escAttr(s) {
    return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escJs(s) {
    return JSON.stringify(String(s == null ? "" : s))
        .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

// ── User feedback — never alert() ──────────────────────────────────
function toast(msg, kind = "error") {
    let box = document.getElementById("toast-box");
    if (!box) {
        box = document.createElement("div");
        box.id = "toast-box";
        document.body.appendChild(box);
    }
    const t = document.createElement("div");
    t.className = `toast toast-${kind}`;
    t.textContent = msg;
    const x = document.createElement("button");
    x.className = "toast-x";
    x.textContent = "✕";
    x.onclick = () => t.remove();
    t.appendChild(x);
    box.appendChild(t);
    // a toast under the mouse stays; leaving restarts a short timer
    let timer = null;
    const fadeOut = () => { t.classList.add("fade"); setTimeout(() => t.remove(), 400); };
    const arm = ms => { clearTimeout(timer); timer = setTimeout(fadeOut, ms); };
    t.addEventListener("mouseenter", () => { clearTimeout(timer); t.classList.remove("fade"); });
    t.addEventListener("mouseleave", () => arm(1500));
    arm(4500);
}

function fmtDate(iso) { return iso ? String(iso).slice(0, 10) : "—"; }

function wsGlyph(key) {
    if (key !== "ecfr") return "";
    return `<svg class="ws-glyph" viewBox="0 0 24 24" aria-hidden="true"
        fill="none" stroke="currentColor" stroke-width="1.6"
        stroke-linecap="round" stroke-linejoin="round"><path d="M12 5.2 c-1.9-1.4-4.8-1.5-6.8-.6 v13.6 c2-.9 4.9-.8 6.8.6
        c1.9-1.4 4.8-1.5 6.8-.6 V4.6 c-2-.9-4.9-.8-6.8.6 z"/>
        <line x1="12" y1="5.2" x2="12" y2="18.8"/></svg>`;
}

// ── One screen, one hash ────────────────────────────────────────────
let _restoringHash = false;

function _stateHash() {
    if (!ecfrCurrentKey) return "#ecfr";
    // A subpart in focus is addressed as <part>/<subpart> — two segments, no
    // colon — and a section by its key, which always has one.
    const key = (typeof ecfrUnitFocused === "function" && ecfrUnitFocused())
        ? ecfrUnitId().split("/").map(encodeURIComponent).join("/")
        : encodeURIComponent(ecfrCurrentKey);
    if (typeof ecfrPaneTab !== "undefined" && ecfrPaneTab === "compare") {
        // a comparison is a link: #ecfr/compare/<key>/<A>..<B>
        let h = `#ecfr/compare/${key}`;
        if (cmpRan && cmpA && cmpB) h += `/${encodeURIComponent(cmpA)}..${encodeURIComponent(cmpB)}`;
        return h;
    }
    return `#ecfr/read/${key}`;
}

function syncHash(push) {
    if (_restoringHash) return;
    const h = _stateHash();
    if (location.hash === h) return;
    if (push) history.pushState(null, "", h);
    else history.replaceState(null, "", h);
}

// The reader is the only screen (Compare is a tab inside its pane):
// showScreen keeps the workspace visible and writes the hash (a push when
// the screen "changed", a replace otherwise — the convention ecfr.js was
// written against). The write is deferred a microtask: callers set their
// state (the dashboard clears ecfrCurrentKey) right AFTER calling this,
// and the hash must reflect it.
function showScreen(screen) {
    const changed = appScreen !== screen;
    appScreen = screen;
    const ws = document.getElementById("ecfr-workspace");
    if (ws) ws.style.display = "block";
    queueMicrotask(() => syncHash(changed));
}

// The wordmark: back to the dashboard from wherever you are. (goEcfr alone
// keeps an open section open — it is the nav button's "show me the reader".)
async function goEcfrHome() {
    ecfrCurrentKey = null;
    await goEcfr();
}

async function restoreFromHash() {
    _restoringHash = true;
    try {
        const parts = location.hash.replace(/^#/, "").split("/");
        showScreen("ecfr");
        // 1.2.0 wrote #compare/<key>/<A>..<B>; it reads as #ecfr/compare/…
        if (parts[0] === "compare") parts.unshift("ecfr");
        const pair = p => p && p.includes("..") ? p.split("..").map(decodeURIComponent) : [null, null];
        if (parts[0] === "ecfr" && (parts[1] === "compare" || parts[1] === "read") && parts[2]) {
            // <part>/<subpart> (no colon) names a whole subpart; a section key has one
            const whole = !decodeURIComponent(parts[2]).includes(":");
            const key = whole ? `${decodeURIComponent(parts[2])}/${decodeURIComponent(parts[3] || "")}`
                              : decodeURIComponent(parts[2]);
            if (parts[1] === "compare") {
                await openEcfrCompare(key, ...pair(parts[whole ? 4 : 3]));
            } else {
                if (typeof ecfrPaneTab !== "undefined") ecfrPaneTab = "read";   // back from a compare link
                if (whole) await openEcfrSubpart(...key.split("/"));
                else await openEcfrSection(key);
            }
        } else {
            await renderEcfrDashboard();
        }
    } catch (err) {
        console.error("Hash restore failed:", err);
        await renderEcfrDashboard();
    } finally {
        _restoringHash = false;
        syncHash(false);
    }
}

window.addEventListener("popstate", () => { if (location.hash !== _stateHash()) restoreFromHash(); });
window.addEventListener("hashchange", () => { if (location.hash !== _stateHash()) restoreFromHash(); });

// ── Theme ───────────────────────────────────────────────────────────
function currentTheme() {
    return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme) {
    theme = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", theme);
    document.querySelectorAll(".theme-opt").forEach(b =>
        b.classList.toggle("active", b.dataset.theme === theme));
    try { localStorage.setItem("theme", theme); } catch (e) { /* private mode */ }
    // highlight fills are theme-dependent (ecfrAnnotationStyle); the
    // renderer only re-runs the style function when asked to
    if (typeof ecfrEachAnnotator === "function") ecfrEachAnnotator(ann => ann.redraw());
}

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll(".theme-opt").forEach(b =>
        b.addEventListener("click", () => applyTheme(b.dataset.theme)));
    applyTheme(currentTheme());
    restoreFromHash();
});
