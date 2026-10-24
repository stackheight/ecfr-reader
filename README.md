# ecfr-reader

A local-first reader for Title 40 of the Code of Federal Regulations. It
fetches the eCFR's XML once, keeps it in a SQLite file on your machine, and
gives you a reader that works offline: a table of contents you can star,
full-text search, up to six reading frames side by side (the local snapshot
or live ecfr.gov), a word-level diff between the two, highlights with
comments, notes, and a check that tells you when ecfr.gov has published a
newer issue.

State-level regulations maybe added in the future where practicable.

![The reader](docs/screenshot.png)

![What an amendment changed](docs/screenshot-timeline.png)

Built for air-permitting work (Title 40, parts 50–99: the Clean Air Act
programs), but the corpus tools take any part range in Title 40.

## Quick start

Python 3.10 or newer, with an `sqlite3` that has FTS5 (every python.org,
distro and uv-managed interpreter does).

```bash
git clone https://github.com/SpottedHound/ecfr-reader.git
cd ecfr-reader
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

export ECFR_CONTACT=you@example.org      # who to reach about your requests (see below)
python3 -m ecfr_reader fetch             # ~95 MB of XML, 50 parts, a couple of minutes
python3 -m ecfr_reader import            # builds data/ecfr.db (~170 MB), about 20 s
python3 -m ecfr_reader serve             # http://127.0.0.1:5000 or http://localhost:5000
python3 -m ecfr_reader serve --port XXXX # serve on alternative port
```

`python3 -m ecfr_reader status` says what the data directory holds.
`pip install -e .` adds an `ecfr-reader` command that does the same.

On **Windows** (PowerShell, or PyCharm's terminal) the same steps read:

```powershell
py -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
$env:ECFR_CONTACT = "you@example.org"       # cmd.exe: set ECFR_CONTACT=you@example.org
python -m ecfr_reader fetch
python -m ecfr_reader import
python -m ecfr_reader serve
```

Run the commands from the project folder (the data directory is `.\data`
under wherever you run them; in PyCharm, a run configuration's working
directory). Stop `serve` before you `import`: the import swaps the
database file into place, and Windows will not replace a file another
process holds open. The test suite runs on Windows in this repository's
GitHub workflow.

## What the reader does

- **Table of contents.** Parts 50–99, each expanding to its subparts,
  appendices and loose sections. Star any part, subpart or section; the
  stars pin above the tree.
- **Reading units.** You read a subpart (or an appendix, or a part's loose
  sections) as one scrolling page, not a section at a time. Previous / next
  unit at the top and bottom.
- **Frames.** One to six side-by-side frames, each on a source: the local
  snapshot, or live text fetched from ecfr.gov. Drag to reorder.
- **Timeline.** Across the top of a section: every date ecfr.gov amended
  it, with Local and Live on the same rail. Click a date to read what that
  amendment changed; shift-click to pair any two dates. A comparison is a
  link you can send.
- **Diff.** Changed paragraphs in full with the changed words marked;
  unchanged paragraphs fold to a strip (a checkbox unfolds them); a sticky
  strip counts the changes and steps through them. Tables are flagged
  whole rather than diffed cell by cell.
- **Marks.** A toolbar in the PDF-editor idiom: highlight in four colours,
  underline, strike, an eraser, undo / redo, and a comment on any mark.
  Marks on live frames are scratch and never saved. A mark whose text has
  drifted after a re-import is listed as orphaned rather than guessed.
- **Notes** on any section, and a panel that lists every note and mark at
  the scope you choose: this section, its subpart, its part, or all of
  Title 40.
- **Search.** Full text across the corpus (SQLite FTS5), with snippets.
- **Updates.** The dashboard checks ecfr.gov for a newer issue of your
  parts and lists what changed. It only tells you; refreshing is the two
  commands above, run again.
- **Light and dark themes.**

Your notes, marks and stars live in `data/annotations.db`. That is the one
file worth backing up; everything else in `data/` is derived and can be
rebuilt from ecfr.gov.

## Configuration

| Variable              | Default                 | Meaning                                                                                                                                                                                                        |
| --------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ECFR_CONTACT`        | unset                   | Required by `fetch` and by the live / update features. An email address or URL that goes into the User-Agent so the eCFR operators can reach whoever is making the requests. The reader itself never needs it. |
| `ECFR_DATA_DIR`       | `./data`                | Where the XML, the corpus and your annotations live. Relative to the directory you run from.                                                                                                                   |
| `ECFR_DB`             | `<data>/ecfr.db`        | The corpus file.                                                                                                                                                                                               |
| `ECFR_ANNOTATIONS_DB` | `<data>/annotations.db` | Your notes, marks and stars.                                                                                                                                                                                   |

`fetch --parts 60,63` or `--parts 50-52` narrows the corpus; `--date
YYYY-MM-DD` fetches a past issue; `--force` refetches parts already on
disk (a fetch is otherwise resumable). The parts in scope are remembered
in `data/dataset_state.json`.

## Being a good client of ecfr.gov

The eCFR versioner API (https://www.ecfr.gov/developers) is a public
service. This tool identifies itself with your `ECFR_CONTACT`, waits 1.5 s
between parts, backs off for 30 s on a 429, and makes at most two requests
per update check. Please keep it that way.

## API

Everything the page uses is plain JSON under `/api/ecfr/`:

| Route                                                     | What                                                       |
| --------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /status`                                             | snapshot date, parts, section count, the last update check |
| `GET /toc`, `GET /toc/<part>`                             | the parts; one part's subparts and sections                |
| `GET /unit?part=&subpart=` (or `&appendix=`, or neither)  | every section of one division, with its text blocks        |
| `GET /unit/live?part=&subpart=`, `GET /section/live?key=` | the same from ecfr.gov, as of its current issue            |
| `GET /section/versions?key=` | the dates ecfr.gov amended the section (cached a day; `?force=1`) |
| `GET /section/at?key=&date=` | the section as of a date (cached for ever) |
| `GET /search?q=&part=&limit=&offset=`                     | full-text search                                           |
| `GET /updates[?force=1]`                                  | the notify-only update check (cached 24 h)                 |
| `GET /annotations?scope=&key=`                            | notes and marks at a scope, with counts per scope          |
| `POST /notes`, `PATCH`/`DELETE /notes/<id>`               | notes                                                      |
| `POST /highlights`, `PATCH`/`DELETE /highlights/<id>`     | marks                                                      |
| `GET`/`POST /favorites`                                   | stars (POST toggles)                                       |

## Development

```bash
pip install pytest
pytest -q
```

The tests build a corpus from one small synthetic part
(`tests/fixtures/title-40-part-999.xml`) in a temporary directory, so they
never touch ecfr.gov or your data. The GitHub workflow runs them on Python
3.10, 3.12 and 3.13 and audits the pinned dependencies.

The frontend is three classic scripts and one stylesheet with no build
step; the text-annotation engine is the vendored UMD build of
[@recogito/text-annotator](https://github.com/recogito/text-annotator-js).

## Roadmap

- **A git-backed archive.** `ecfr-reader snapshot` would render every
  section to one text file (one paragraph per line) and commit the set
  into `data/history/` under its issue date, so `git log -p` and
  `git blame` tell a section's story from the command line. It shares the
  renderer with the import; the in-app timeline came first.

## Limitations

- Title 40 only, today. The fetch and import are written around its
  part numbering; other titles would need the title to become a parameter.
- Single user, no login. Run it for yourself; if you serve it to others,
  put it behind something that authenticates.
- No browser tests in CI. The suite covers the API contract the page
  depends on.

## License and credits

Copyright (C) 2026 Kyle Gregory. Free software under the GNU General
Public License, version 3 or later (see `LICENSE`). Third-party components
and their licenses are listed in `THIRD_PARTY.md`.

The text of the Code of Federal Regulations is a work of the United States
Government and is in the public domain.

The code was written with an AI assistant (Claude) under the author's
direction, as part of a larger air-quality compliance tool from which this
reader was extracted.
