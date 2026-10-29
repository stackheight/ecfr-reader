# Third-party components

ecfr-reader is GPL-3.0-or-later (see LICENSE). Everything it depends on is
listed here with the license read from the installed package's own metadata
(`importlib.metadata`), checked 2026-10-23.

## Python packages (pip)

| Package | Version | License | Used for |
|---|---|---|---|
| Flask | 3.1.3 | BSD-3-Clause | the API and static serving |
| Werkzeug | 3.1.x | BSD-3-Clause | Flask's WSGI layer |
| Jinja2 | 3.1.6 | BSD-3-Clause | Flask dependency (no templates of our own) |
| MarkupSafe | 3.0.x | BSD-3-Clause | Jinja2 dependency |
| itsdangerous | 2.2.x | BSD-3-Clause | Flask dependency |
| click | 8.x | BSD-3-Clause | Flask dependency |
| blinker | 1.9.x | MIT | Flask dependency |
| beautifulsoup4 | 4.15.0 | MIT | parsing the eCFR XML (`ecfr_reader/corpus/render.py`) |
| soupsieve | 2.8.x | MIT | beautifulsoup4 dependency |
| lxml | 6.1.1 | BSD-3-Clause | the XML parser behind beautifulsoup4 |
| pdfminer.six | 20260107 | MIT | reading a proposed rule's redline PDF — character boxes paired with the drawn strike / underline marks (`ecfr_reader/proposals/extract.py`) |
| charset-normalizer | 3.x | MIT | pdfminer.six dependency |
| cryptography | 50.x | Apache-2.0 OR BSD-3-Clause | pdfminer.six dependency (encrypted PDFs) |

## Vendored frontend assets

| Component | Version | License | Used for | Notes |
|---|---|---|---|---|
| @recogito/text-annotator | 3.4.10 | BSD-3-Clause | the highlight / underline / strike / comment engine (`ecfr_reader/static/vendor/text-annotator/`, UMD build only) | License per the package's own `package.json` (`"license": "BSD-3-Clause"`, author Rainer Simon). The npm tarball ships no LICENSE file, so the vendored `LICENSE` holds the standard BSD-3-Clause text with the declared copyright holder — replace it with upstream's verbatim file if one appears. Retain the notice when redistributing. |

## U.S. Government works (public domain, 17 U.S.C. §105)

| Source | Used for | Notes |
|---|---|---|
| The Code of Federal Regulations, as published on ecfr.gov (Office of the Federal Register, GSA) | the text this reader shows | Public domain. The reader stores a copy locally; it is not redistributed with this repository. |
| The eCFR versioner API (https://www.ecfr.gov/developers) | fetching the XML and checking for newer issues | A public service: send a User-Agent that identifies you (`ECFR_CONTACT`), pace requests (this tool waits 1.5 s between parts, backs off on 429, and the update check makes at most two requests). |

## Provenance

The XML rendering (`corpus/render.py`) adapts the author's own earlier,
unpublished script. The ecfr.gov client (`corpus/updates.py`) was written
from the public API documentation with the standard library only. Neither
contains code from any third-party eCFR client or parser.
