// =====================================================================
// eCFR reader — local↔live version diff (round 3).
//
// Answers "what actually changed?" when the same section is open in a local
// snapshot frame and a live ecfr.gov frame. The dashboard already tells you
// a part changed upstream; this shows the words.
//
// Hand-rolled rather than vendored: registry.npmjs.org isn't reachable from
// this sandbox, so jsdiff would need the author to fetch a tarball by hand. The
// inputs are paragraph-sized, so ~100 lines of LCS is a fair trade for a
// dependency. If this ever needs to be smarter (moved paragraphs, in-table
// diffs), jsdiff (BSD-3, dist/diff.js UMD) is the escalation — it'd need a
// THIRD_PARTY.md row.
//
// Loaded after ecfr-annotator.js, before ecfr.js.
//
// SAFETY: every string here is esc()'d BEFORE any <del>/<ins> markup is
// added. Nothing in this file may emit un-escaped corpus text.
// =====================================================================

// Above this many cells the LCS matrix stops being worth it. A 500x500
// paragraph pair is 250k cells — already generous for regulation prose;
// beyond it (a giant appendix pasted as one block) we degrade to "this
// paragraph was replaced" rather than locking the tab up. The bound is on
// the PRODUCT, not either length, because that's what the DP actually costs.
const ECFR_DIFF_MAX_CELLS = 250000;

// --- Word diff --------------------------------------------------------

// Each token is a word WITH its trailing whitespace, not word and space as
// separate tokens. That detail decides how the output reads.
//
// Tokenise them apart and the spaces between changed words are themselves
// common tokens, so LCS anchors on them and shreds a rewritten phrase into
// alternating one-word marks: "b"/"x" " " "c"/"y" " " "d"/"z". Glue the
// space to its word and there's nothing to anchor on, so the whole phrase
// merges into one deletion followed by one insertion.
//
// Rebuilt text is still byte-identical to the input (join() round-trips,
// leading whitespace included), which the offset-free renderer relies on.
function ecfrDiffSplit(text) {
    return (text || "").split(/(\S+\s*)/).filter(s => s !== "");
}

// Longest-common-subsequence over word tokens.
// Returns [{op: "=" | "-" | "+", text}], runs of the same op merged.
//   "-" = in the local snapshot, gone from live
//   "+" = new in live
function ecfrDiffTokens(a, b) {
    const A = ecfrDiffSplit(a);
    const B = ecfrDiffSplit(b);
    if (a === b) return A.length ? [{ op: "=", text: a }] : [];

    if (A.length * B.length > ECFR_DIFF_MAX_CELLS) {
        // Too big to align word-by-word; say the whole thing was replaced.
        const out = [];
        if (a) out.push({ op: "-", text: a });
        if (b) out.push({ op: "+", text: b });
        return out;
    }

    // Compare on the trimmed word, emit the original token. Tokens carry
    // their trailing whitespace, so a plain === would call "two" and "two "
    // different words and report the last word of a paragraph as deleted and
    // reinserted every time something is appended after it — claiming a
    // removal that never happened. Matching on the word alone fixes that.
    const ta = A.map(t => t.trim()), tb = B.map(t => t.trim());
    const n = A.length, m = B.length, w = m + 1;
    // Uint32Array: one flat buffer beats n nested arrays, and lengths here
    // can't overflow 32 bits.
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = ta[i] === tb[j]
                ? dp[(i + 1) * w + (j + 1)] + 1
                : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
        }
    }

    // On a match emit the LIVE token, not the local one: the diff renders
    // into the live frame, so unchanged text must come out as the live text
    // spells it (whitespace included).
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (ta[i] === tb[j]) { ops.push({ op: "=", text: B[j] }); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { ops.push({ op: "-", text: A[i] }); i++; }
        else { ops.push({ op: "+", text: B[j] }); j++; }
    }
    while (i < n) { ops.push({ op: "-", text: A[i] }); i++; }
    while (j < m) { ops.push({ op: "+", text: B[j] }); j++; }
    return ecfrDiffMergeRuns(ops);
}

// "shall" "-" / " " "-" / "must" "-" is three <del>s where one will do —
// and three boxes with gaps between them read much worse than one.
function ecfrDiffMergeRuns(ops) {
    const out = [];
    for (const o of ops) {
        const last = out[out.length - 1];
        if (last && last.op === o.op) last.text += o.text;
        else out.push({ op: o.op, text: o.text });
    }
    return out;
}

// --- Block diff -------------------------------------------------------

// What makes two blocks "the same block" for the block-level LCS. Tables
// compare whole: their entire contents, so any cell change makes the table
// a changed block (we badge it rather than diff into it — see below).
function ecfrDiffBlockSig(b) {
    if (!b) return "";
    if (b.type === "table") return "t:" + JSON.stringify(b);
    return "p:" + (b.text || "");
}

// LCS over whole blocks, so unchanged paragraphs are recognised even when
// text is inserted above them. Returns [{kind, ...}] for the renderer:
//   {kind:"same", block}                  unchanged, render normally
//   {kind:"word", a, b, ops}              a paragraph, changed
//   {kind:"del"|"ins", block}             a paragraph only on one side
//   {kind:"table", state, block}          added | removed | changed
function ecfrDiffBlocks(A, B) {
    A = A || []; B = B || [];
    const sa = A.map(ecfrDiffBlockSig), sb = B.map(ecfrDiffBlockSig);
    const n = sa.length, m = sb.length, w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * w + j] = sa[i] === sb[j]
                ? dp[(i + 1) * w + (j + 1)] + 1
                : Math.max(dp[(i + 1) * w + j], dp[i * w + (j + 1)]);
        }
    }

    // Pass 1: walk the matrix into a flat op list. Kept separate from the
    // pairing below because doing both at once means the "collect this gap"
    // loop has to stop when EITHER side runs out — which silently splits a
    // gap in two and reports one changed table as a removal plus an
    // unrelated addition.
    const raw = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (sa[i] === sb[j]) { raw.push({ op: "=", b: B[j] }); i++; j++; }
        else if (dp[(i + 1) * w + j] >= dp[i * w + (j + 1)]) { raw.push({ op: "-", a: A[i] }); i++; }
        else { raw.push({ op: "+", b: B[j] }); j++; }
    }
    while (i < n) { raw.push({ op: "-", a: A[i] }); i++; }
    while (j < m) { raw.push({ op: "+", b: B[j] }); j++; }

    // Pass 2: unchanged blocks pass through; each run of changed ones is
    // paired up, because that's where an amendment actually lives.
    const out = [];
    let k = 0;
    while (k < raw.length) {
        if (raw[k].op === "=") { out.push({ kind: "same", block: raw[k].b }); k++; continue; }
        const gapA = [], gapB = [];
        while (k < raw.length && raw[k].op !== "=") {
            if (raw[k].op === "-") gapA.push(raw[k].a);
            else gapB.push(raw[k].b);
            k++;
        }
        ecfrDiffPairGap(gapA, gapB, out);
    }
    return out;
}

// How alike two paragraphs are, 0..1: the share of word tokens they have in
// common (Sørensen–Dice over token sets). Cheap, order-insensitive, and
// enough to tell "this sentence was edited" from "these are different
// paragraphs that happen to be adjacent".
function ecfrDiffSimilarity(a, b) {
    // Trim: tokens carry their trailing whitespace (see ecfrDiffSplit), and
    // "shall " must count as the same word as "shall" at the end of a line.
    const words = (s) => new Set(ecfrDiffSplit(s).map(t => t.trim()).filter(Boolean));
    const A = words(a), B = words(b);
    if (!A.size || !B.size) return 0;
    let shared = 0;
    A.forEach(t => { if (B.has(t)) shared++; });
    return (2 * shared) / (A.size + B.size);
}

// Below this, two paragraphs are different paragraphs — not one edited one.
// 0.35 is empirical: a real §52.247 amendment paired its source-citation note
// against a newly-inserted paragraph (t) at ~0.1 and word-diffed them into
// "[78(t) FRDetermination 1761,of Jan.failure…". Anything that unalike is
// better reported as one deletion and one insertion.
const ECFR_DIFF_MIN_SIMILARITY = 0.35;

// Would these two blocks be the same block, edited?
function ecfrDiffPairScore(a, b) {
    const aTable = a.type === "table", bTable = b.type === "table";
    if (aTable !== bTable) return 0;        // a table is never an edited paragraph
    if (aTable && bTable) return 1;         // two tables in one gap: the table, edited
    return ecfrDiffSimilarity(a.text || "", b.text || "");
}

// Decide which removed block corresponds to which added one. Returns a
// Map(indexInGapB -> indexInGapA).
//
// Greedy best-first: score every candidate pair, take the strongest, and
// keep going while both sides are still free. Gaps are a handful of blocks,
// so the quadratic scan is free — and greedy is enough because the
// alternative (an optimal assignment) buys nothing on inputs this size.
function ecfrDiffMatchGap(gapA, gapB) {
    const scored = [];
    for (let i = 0; i < gapA.length; i++) {
        for (let j = 0; j < gapB.length; j++) {
            const s = ecfrDiffPairScore(gapA[i], gapB[j]);
            if (s >= ECFR_DIFF_MIN_SIMILARITY) scored.push({ i, j, s });
        }
    }
    scored.sort((x, y) => y.s - x.s);
    const takenA = new Set(), takenB = new Set(), match = new Map();
    for (const p of scored) {
        if (takenA.has(p.i) || takenB.has(p.j)) continue;
        takenA.add(p.i); takenB.add(p.j);
        match.set(p.j, p.i);
    }
    return match;
}

// Pair a run of removed blocks against a run of added ones.
//
// Pairing by POSITION is the obvious approach and it's wrong: paragraph 0 of
// the gap is only paragraph 0 of the replacement when nothing was inserted
// above it. Insert one new subsection and every later paragraph is compared
// against its neighbour, producing interleaved word-salad from two unrelated
// texts. Pair on similarity instead, and let anything unmatched be an honest
// whole insertion or deletion.
//
// Output walks the LIVE side, so the result reads in the order of the text
// you're actually looking at; removals are flushed just before whatever
// followed them.
function ecfrDiffPairGap(gapA, gapB, out) {
    const match = ecfrDiffMatchGap(gapA, gapB);
    const emitDel = (a) => out.push(a.type === "table"
        ? { kind: "table", state: "removed", block: a }
        : { kind: "del", block: a });

    let flushed = 0;
    for (let j = 0; j < gapB.length; j++) {
        const b = gapB[j];
        if (match.has(j)) {
            const i = match.get(j);
            while (flushed < i) emitDel(gapA[flushed++]);   // removals that came first
            flushed = Math.max(flushed, i + 1);
            const a = gapA[i];
            // Never diff into table cells: aligning rows is a different
            // problem and a half-aligned table renders as garbage. The badge
            // says what we actually know.
            if (a.type === "table" || b.type === "table") {
                out.push({ kind: "table", state: "changed", block: b });
            } else {
                out.push({ kind: "word", a: a.text || "", b: b.text || "",
                           ops: ecfrDiffTokens(a.text || "", b.text || "") });
            }
        } else {
            out.push(b.type === "table"
                ? { kind: "table", state: "added", block: b }
                : { kind: "ins", block: b });
        }
    }
    while (flushed < gapA.length) emitDel(gapA[flushed++]);
}

// --- Render -----------------------------------------------------------

// Text in, safe HTML out. esc() FIRST, then the markup — the other order
// would eat our own tags and let corpus text write its own.
function ecfrDiffOpsHtml(ops) {
    return ops.map(o => {
        const t = esc(o.text);
        if (o.op === "-") return `<del class="ecfr-diff-del">${t}</del>`;
        if (o.op === "+") return `<ins class="ecfr-diff-ins">${t}</ins>`;
        return t;
    }).join("");
}

function ecfrDiffBadgeHtml(state) {
    const label = { added: "Table added", removed: "Table removed", changed: "Table changed" }[state]
        || "Table changed";
    return `<div class="ecfr-diff-badge ${esc(state)}">${esc(label)}</div>`;
}

// Unchanged paragraphs kept on each side of a change when folding — the
// idea of git's context lines, in paragraphs, which are the CFR's unit.
const ECFR_DIFF_CONTEXT = 1;

// The whole diff for one section, as the body of the B frame. With
// opts.collapse, runs of unchanged paragraphs beyond the context fold to a
// one-line strip; every change sits in a .ecfr-diff-change wrapper the step
// buttons walk, and a summary line counts them.
function ecfrDiffHtml(localBlocks, liveBlocks, opts = {}) {
    const parts = ecfrDiffBlocks(localBlocks, liveBlocks);
    const counts = { changed: 0, added: 0, removed: 0, tables: 0 };
    let n = 0;
    const changeHtml = p => {
        n++;
        let inner;
        if (p.kind === "table") {
            counts.tables++;
            inner = `<div class="ecfr-diff-table ${esc(p.state)}">${ecfrDiffBadgeHtml(p.state)}
                ${p.state === "removed" ? "" : ecfrRenderBlock(p.block, -1)}</div>`;
        } else if (p.kind === "del") {
            counts.removed++;
            inner = `<p class="ecfr-block"><del class="ecfr-diff-del">${esc(p.block.text || "")}</del></p>`;
        } else if (p.kind === "ins") {
            counts.added++;
            inner = `<p class="ecfr-block"><ins class="ecfr-diff-ins">${esc(p.block.text || "")}</ins></p>`;
        } else {
            counts.changed++;
            inner = `<p class="ecfr-block">${ecfrDiffOpsHtml(p.ops)}</p>`;
        }
        return `<div class="ecfr-diff-change" data-change-n="${n}">${inner}</div>`;
    };
    const sameHtml = p => ecfrRenderBlock(p.block, -1);
    const anyChange = parts.some(p => p.kind !== "same");

    const out = [];
    if (!opts.collapse || !anyChange) {
        parts.forEach(p => out.push(p.kind === "same" ? sameHtml(p) : changeHtml(p)));
    } else {
        // walk runs of unchanged blocks; keep CONTEXT on each side of a change
        let i = 0;
        while (i < parts.length) {
            if (parts[i].kind !== "same") { out.push(changeHtml(parts[i])); i++; continue; }
            let j = i;
            while (j < parts.length && parts[j].kind === "same") j++;
            const run = parts.slice(i, j);
            const leading = i === 0 ? 0 : ECFR_DIFF_CONTEXT;        // context after the previous change
            const trailing = j === parts.length ? 0 : ECFR_DIFF_CONTEXT;   // context before the next
            if (run.length <= leading + trailing + 1) {
                run.forEach(p => out.push(sameHtml(p)));
            } else {
                run.slice(0, leading).forEach(p => out.push(sameHtml(p)));
                const hidden = run.slice(leading, run.length - trailing);
                out.push(`<details class="ecfr-diff-fold"><summary>${hidden.length} unchanged paragraph${
                    hidden.length === 1 ? "" : "s"}</summary>${hidden.map(sameHtml).join("")}</details>`);
                run.slice(run.length - trailing).forEach(p => out.push(sameHtml(p)));
            }
            i = j;
        }
    }

    if (!anyChange) {
        return `<div class="ecfr-diff-none">No differences between these two versions of this section.</div>` + out.join("");
    }
    const bits = [];
    if (counts.changed) bits.push(`${counts.changed} paragraph${counts.changed === 1 ? "" : "s"} changed`);
    if (counts.added) bits.push(`${counts.added} added`);
    if (counts.removed) bits.push(`${counts.removed} removed`);
    if (counts.tables) bits.push(`${counts.tables} table${counts.tables === 1 ? "" : "s"} changed`);
    // The strip is sticky at the top of the frame body, so the step buttons
    // and the fold checkbox stay in reach however far down the text you are.
    const fi = opts.frameIndex;
    const controls = fi == null ? "" : `<span class="ecfr-diff-controls">
        <button class="ecfr-btn ecfr-btn-sm" title="Previous change" onclick="ecfrDiffStep(${fi}, -1)">‹</button>
        <span class="ecfr-diff-pos" id="ecfr-diff-pos-${fi}">${n} change${n === 1 ? "" : "s"}</span>
        <button class="ecfr-btn ecfr-btn-sm" title="Next change" onclick="ecfrDiffStep(${fi}, 1)">›</button>
        <label class="ecfr-diff-opt" title="Fold runs of unchanged paragraphs to one line; one paragraph of context stays on each side of a change">
            <input type="checkbox" ${opts.collapse ? "checked" : ""} onchange="ecfrSetDiffCollapse(this.checked)"> Collapse unchanged</label>
    </span>`;
    return `<div class="ecfr-diff-summary"><span>${esc(bits.join(" · "))}</span>${controls}</div>` + out.join("");
}
