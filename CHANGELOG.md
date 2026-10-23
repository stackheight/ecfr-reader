# Changelog

## 1.0.1 — 2026-10-23

`fetch` and the live frames failed with HTTP 406: ecfr.gov's full-text
endpoint now requires the request to permit compression, and Python's
urllib does not ask for any. The client sends `Accept-Encoding: gzip`,
inflates the reply, and quotes the server's own message on any 4xx.

## 1.0.0 — 2026-10-23

First public release. Fetch Title 40 (parts 50–99 by default) from the
eCFR versioner API, import it into SQLite with a full-text index, and read
it in the browser: a table-of-contents tree with favorites, search, one to
six reading frames on the local snapshot or live ecfr.gov, a word-level
diff between the two, highlight / underline / strike marks with comments,
notes, and a notify-only check for newer issues. Light and dark themes.
