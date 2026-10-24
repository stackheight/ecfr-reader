# Changelog

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
