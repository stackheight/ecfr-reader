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

// --- Lines ------------------------------------------------------------
// The diff as a list of terminal lines for compare.js to print:
//   {kind: "hunk", text}            @@ (e) @@ — names the paragraph a change is in
//   {kind: "same" | "del" | "ins", text}
//   {kind: "word", ops}             one paragraph with [-removed-] / {+added+} words
//   {kind: "fold", n, lines}        a run of unchanged paragraphs, folded
// opts.wordDiff: a changed paragraph is one "word" line instead of a "del"
// then an "ins". opts.collapse: unchanged runs beyond one paragraph of
// context on each side of a change fold. Returns {lines, counts}.
const ECFR_DIFF_CONTEXT = 1;

function ecfrDiffHunkName(text) {
    const m = /^((?:\([a-zA-Z0-9]{1,4}\))+)/.exec((text || "").trim());
    return m ? m[1] : "";
}

function ecfrDiffLines(parts, opts = {}) {
    const counts = { changed: 0, added: 0, removed: 0, tables: 0 };
    const changeLines = p => {
        const out = [];
        if (p.kind === "table") {
            counts.tables++;
            const cap = (p.block && p.block.caption) || "table";
            out.push({ kind: "hunk", text: `@@ table: ${cap} — ${p.state} @@` });
        } else if (p.kind === "del") {
            counts.removed++;
            out.push({ kind: "hunk", text: `@@ ${ecfrDiffHunkName(p.block.text) || "paragraph"} removed @@` });
            out.push({ kind: "del", text: p.block.text || "" });
        } else if (p.kind === "ins") {
            counts.added++;
            out.push({ kind: "hunk", text: `@@ ${ecfrDiffHunkName(p.block.text) || "paragraph"} added @@` });
            out.push({ kind: "ins", text: p.block.text || "" });
        } else {
            counts.changed++;
            out.push({ kind: "hunk", text: `@@ ${ecfrDiffHunkName(p.b) || ecfrDiffHunkName(p.a) || "paragraph"} @@` });
            if (opts.wordDiff) out.push({ kind: "word", ops: p.ops });
            else { out.push({ kind: "del", text: p.a }); out.push({ kind: "ins", text: p.b }); }
        }
        return out;
    };
    const sameLine = p => ({ kind: "same", text: p.type === "table" ? `[table: ${p.block.caption || "table"}]` : (p.block.text || "") });
    const anyChange = parts.some(p => p.kind !== "same");
    const lines = [];
    if (!opts.collapse || !anyChange) {
        parts.forEach(p => { if (p.kind === "same") lines.push(sameLine(p)); else lines.push(...changeLines(p)); });
    } else {
        let i = 0;
        while (i < parts.length) {
            if (parts[i].kind !== "same") { lines.push(...changeLines(parts[i])); i++; continue; }
            let j = i;
            while (j < parts.length && parts[j].kind === "same") j++;
            const run = parts.slice(i, j);
            const leading = i === 0 ? 0 : ECFR_DIFF_CONTEXT;
            const trailing = j === parts.length ? 0 : ECFR_DIFF_CONTEXT;
            if (run.length <= leading + trailing + 1) {
                run.forEach(p => lines.push(sameLine(p)));
            } else {
                run.slice(0, leading).forEach(p => lines.push(sameLine(p)));
                const hidden = run.slice(leading, run.length - trailing);
                lines.push({ kind: "fold", n: hidden.length, lines: hidden.map(sameLine) });
                run.slice(run.length - trailing).forEach(p => lines.push(sameLine(p)));
            }
            i = j;
        }
    }
    return { lines, counts };
}
