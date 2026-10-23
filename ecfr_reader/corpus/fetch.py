"""Fetch the Title 40 XML corpus from ecfr.gov into <data>/xml/
(`ecfr-reader fetch [--date YYYY-MM-DD] [--force] [--parts 50-99]`), then
`ecfr-reader import` builds the database.

Design:
- Date defaults to the CURRENT snapshot (updates.latest_title_date) —
  fetching fresh also picks up amendments; updates.check_updates exists
  to tell you when the local snapshot is behind.
- Resumable: existing part files are skipped (--force refetches), so a
  429-interrupted run just continues where it stopped.
- Polite: ~1.5 s between parts; a 429 backs off 30 s and retries
  (max 3 per part). These are big requests — part 63 alone is ~26 MB.
- Atomic per file (tmp + os.replace); dataset_state.json's
  snapshot_date is stamped ONLY when the full set is on disk, so a
  partial fetch never claims to be a snapshot.

The corpus is DERIVED DATA — re-fetchable; the one file worth backing up
is annotations.db.
"""

import argparse
import json
import os
import sys
import time

from .. import config
from .updates import EcfrApiError, _fetch_xml, _parts_scope, latest_title_date

PAUSE_S = 1.5
BACKOFF_S = 30
MAX_TRIES = 3


def _fetch_part(date: str, part: str) -> bytes:
    for attempt in range(1, MAX_TRIES + 1):
        try:
            return _fetch_xml(date, {"part": part}, 40).encode("utf-8")
        except EcfrApiError as e:
            if "429" in str(e) and attempt < MAX_TRIES:
                print(f"  part {part}: rate-limited, backing off "
                      f"{BACKOFF_S}s (attempt {attempt}/{MAX_TRIES})")
                time.sleep(BACKOFF_S)
                continue
            raise


def add_arguments(ap):
    ap.add_argument("--date", help="snapshot date YYYY-MM-DD (default: current per ecfr.gov)")
    ap.add_argument("--force", action="store_true", help="refetch parts that already exist on disk")
    ap.add_argument("--parts", help='parts to fetch, e.g. "50-99" or "60,63" (default: the data directory\'s '
                                    'dataset_state.json, else 50-99)')


def run(date=None, force=False, parts_spec=None):
    """Fetch every part in scope. Returns the snapshot date when the set
    is complete, else exits with the missing parts named."""
    state_path, xml_dir = config.dataset_state_path(), config.xml_dir()
    os.makedirs(xml_dir, exist_ok=True)
    if os.path.isfile(state_path):
        with open(state_path, "r", encoding="utf-8") as f:
            state = json.load(f)
    else:
        state = dict(config.DEFAULT_STATE)
    if parts_spec:
        state["parts"] = parts_spec
    parts = sorted(_parts_scope(state["parts"]), key=int)
    try:
        config.user_agent()      # fail here, before any request, when ECFR_CONTACT is unset
    except RuntimeError as e:
        sys.exit(str(e))

    date = date or latest_title_date()
    print(f"Title 40 parts {state['parts']} @ {date} → {xml_dir}")
    args = argparse.Namespace(force=force)

    fetched = skipped = 0
    total_bytes = 0
    for part in parts:
        dest = os.path.join(xml_dir, f"title-40-part-{part}.xml")
        if os.path.exists(dest) and not args.force:
            skipped += 1
            continue
        data = _fetch_part(date, part)
        tmp = dest + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, dest)
        fetched += 1
        total_bytes += len(data)
        print(f"  part {part}: {len(data) / 1024 / 1024:.1f} MB")
        time.sleep(PAUSE_S)

    have = [p for p in parts
            if os.path.exists(os.path.join(xml_dir, f"title-40-part-{p}.xml"))]
    if len(have) == len(parts):
        state["snapshot_date"] = date
        tmp = state_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1)
        os.replace(tmp, state_path)
        print(f"complete: {fetched} fetched ({total_bytes / 1024 / 1024:.0f} MB), "
              f"{skipped} already present; snapshot_date = {date}")
        print("now run:  ecfr-reader import")
        return date
    else:
        missing = sorted(set(parts) - set(have), key=int)
        sys.exit(f"INCOMPLETE — missing parts {missing}; "
                 "snapshot_date NOT stamped. Re-run to resume.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    add_arguments(ap)
    a = ap.parse_args()
    run(a.date, a.force, a.parts)
