# Changelog

## 1.3.0 — 2026-10-24

**A subpart is a thing you can open whole.** Clicking a subpart heading in
the contents now opens the whole subpart as what you are working on,
instead of only expanding its list (the caret beside the heading does
that). While it is open: the amendment rail shows every date any of its
sections changed (`GET /api/ecfr/unit/versions`, one request to
ecfr.gov), a dated frame holds the whole subpart as it stood that day
(`GET /api/ecfr/unit/at`, one request, cached for ever), and the Compare
tab diffs the whole subpart section by section — a `---`/`+++` pair per
changed section, sections added or removed between the two dates against
`/dev/null`, unchanged sections folded — with a `this section | whole
subpart` switch in its controls. Click a section to narrow back to it.
Links: `#ecfr/read/60/OOOOb` and `#ecfr/compare/60/OOOOb/A..B`. Only
subparts open whole: an appendix is one section, and loose sections are
not a division ecfr.gov serves.

The contents rail is wider by default and can be dragged wider or
narrower from its right edge (double-click the edge to reset; the width
is remembered), and hovering any row in it shows the whole heading in
place instead of the clamped two or three lines. The Compare controls
are stacked one thing per line — the section, **Compare:** with the
`this section | whole subpart` switch, **Options:** with A, B,
`--word-diff` and `--collapse`, then the Compare button — so a long
section heading can't shove them around.

A frame's source menu now lists exactly what the amendment rail shows —
**Snapshots** (Local, Live) and **Amendments on record**, one per date —
and fills in as the dates arrive. It used to offer a date only after its
tick had been clicked, and then kept it for ever, so after a few sections
it listed dates from other rules' histories. Labels say what things are:
"Local snapshot — eCFR as of 2026-07-28", "Live ecfr.gov — today", "As of
2024-03-08"; the rail's caption and tooltips say that a click opens a new
frame whose text is fetched from ecfr.gov once and then kept, and the
dashboard's snapshot tile explains that a snapshot is the eCFR as it stood
on a day.

On the amendment rail, a lead runs along the line from the Local tick
back to the amendment whose text it holds (amber dashes; green dots for
Live), the amendment's label says "= Local" or "= Local & Live", and the
Local frame's header says "text as amended <date>" too.

The Compare terminal follows the theme: paper-light in light mode, dark in dark mode.

Also: the Compare terminal stops typing its command one character at a
time; the command and its output just appear. The macOS window buttons are
gone from the title bar, and the `$` prompt is a two-line prompt in the
style kitty users tend to run — `reader@ecfr`, the section (or subpart) as
a path under `~/40cfr`, and the clock on the first line, a `❯` and the
command on the second — with an idle prompt under each result.

## 1.2.1 — 2026-10-24

Compare is a tab of the reading pane — **Read | Compare** above the
text — rather than a separate screen, so swapping back and forth is one
click and nothing is lost either way: the Read tab keeps its frames and
scroll position, the Compare tab keeps its output. The contents sidebar
feeds whichever tab is showing, so Compare's own section search and
favorites picker are gone: the section you compare is the section you
have open. The link form is `#ecfr/compare/<key>/<A>..<B>` (1.2.0's
`#compare/…` links still open).

## 1.2.0 — 2026-10-23

**The Compare workspace.** Comparing versions moves out of the reader
into its own tab. Pick a section (search, a starred section, or the one
open in the viewer), pick **A (before)** and **B (after)** from every
version on record — the amendment dates, your Local snapshot, Live
ecfr.gov — and press Compare. The result prints into a mock terminal as
a git-style unified diff: `---`/`+++` headers naming the two versions, a
`@@ (e) @@` hunk header naming the paragraph each change is in, `-` and
`+` lines, runs of unchanged paragraphs folded to `@@ 19 unchanged
paragraphs @@` (click to show). `--word-diff` prints each changed
paragraph once with the removed words `[-marked-]` and the added words
`{+marked+}`, git's convention; `--collapse` turns the folding off. The
prompt line types itself (not when the OS asks for reduced motion). A
comparison is a link: `#compare/<key>/<A>..<B>`.

**The timeline, labelled.** The rail across the top of a section is now
captioned ("Amendment history · 3 amendments on record since 2017"), has
a legend, and says what a click does: it opens that version in a reading
frame beside the ones you have. A version on screen is drawn filled. The
"Compare versions →" link at its right hands the section to Compare.

Gone from the reader: the "Show changes" and "Compare" buttons, the
in-frame diff with its sticky summary strip, shift-click on the rail, and
the `#ecfr/read/<key>/diff/<A>..<B>` link form (open the same pair in
Compare instead). Annotation tools no longer pause — the reader only ever
shows real text now.

Also: an unclosed comment in the stylesheet had been swallowing the light
theme's table-header, ok, warning and star colour tokens.

## 1.1.1 — 2026-10-23

The favorites are a pinned, collapsible band under the search box: the
contents tree scrolls beneath them and they stay in view. Clicking a
favorite opens it in the reader and brings its row into view in the tree
(its subpart expanded).

## 1.1.0 — 2026-10-23

**The version timeline.** Across the top of an open section: every date
ecfr.gov amended it (its point-in-time history starts 2017-01-01), with
your Local snapshot and Live ecfr.gov on the same rail. Click a date to
read what that amendment changed, against the version before it;
shift-click to set the A side and pair any two; a comparison is a link
(`#ecfr/read/<key>/diff/<A>..<B>`). Past versions are fetched once and
cached for ever; the date list is cached for a day.

**A readable diff.** Changed paragraphs appear in full with the changed
words marked; runs of unchanged paragraphs fold to a one-line strip, one
paragraph of context kept on each side (a "Collapse unchanged" checkbox
turns the folding off, and the choice is remembered); a sticky strip at
the top counts the changes and steps through them. The paragraph stays
the unit of the diff — it is what the CFR cites.

Also: the page stamps its version into its script and stylesheet links,
so an upgrade never runs a browser's cached copy of the old code.

## 1.0.1 — 2026-10-23

`fetch` and the live frames failed with HTTP 406: ecfr.gov's full-text
endpoint now requires the request to permit compression, and Python's
urllib does not ask for any. The client sends `Accept-Encoding: gzip`,
inflates the reply, and quotes the server's own message on any 4xx.
A part download gets a five-minute read timeout and a retry (part 63 is
~26 MB and ecfr.gov compresses it before sending; the old 25 s timeout
cut the fetch off on a slow link), and a failed fetch exits with the
part's name and a resume hint instead of a traceback.
The hints after `fetch` spell the next command the way you ran this
one (`python -m ecfr_reader import`, or `ecfr-reader import` after
`pip install -e .`), and `import` without the packages installed says
to run `pip install -r requirements.txt` instead of a traceback.
The contents column reads better in a small window: part subjects wrap
to two lines instead of ending in an ellipsis, under 1100px the
annotations panel moves below the reading pane so the contents keep a
readable column, and under 760px the three panes stack.
Windows: the console output degrades gracefully on a non-UTF-8 code
page, the README has the PowerShell steps, and the test suite runs on a
Windows runner in CI.

## 1.0.0 — 2026-10-23

First public release. Fetch Title 40 (parts 50–99 by default) from the
eCFR versioner API, import it into SQLite with a full-text index, and read
it in the browser: a table-of-contents tree with favorites, search, one to
six reading frames on the local snapshot or live ecfr.gov, a word-level
diff between the two, highlight / underline / strike marks with comments,
notes, and a notify-only check for newer issues. Light and dark themes.
