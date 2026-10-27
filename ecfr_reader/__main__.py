"""ecfr-reader fetch | import | serve | status | dockets …"""
import argparse
import sys

from . import __version__, config


def main(argv=None):
    # A Windows console that is not UTF-8 would otherwise choke on the
    # arrows and dashes in the progress lines; degrade them instead.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    ap = argparse.ArgumentParser(prog="ecfr-reader", description="A local-first reader for 40 CFR.")
    ap.add_argument("--version", action="version", version=f"ecfr-reader {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fetch", help="download the Title 40 XML from ecfr.gov (needs ECFR_CONTACT)")
    from .corpus import fetch
    fetch.add_arguments(f)
    sub.add_parser("import", help="build the corpus database from the XML on disk")
    s = sub.add_parser("serve", help="run the reader at http://127.0.0.1:5000")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=5000)
    s.add_argument("--debug", action="store_true")
    sub.add_parser("status", help="what the data directory holds")
    d = sub.add_parser("dockets", help="the regulations.gov docket catalog (needs REGSGOV_API_KEY)")
    dsub = d.add_subparsers(dest="dcmd", required=True)
    for name, text in (("add", "track a docket and catalog it"), ("sync", "catalog a tracked docket (resumes)")):
        x = dsub.add_parser(name, help=text)
        x.add_argument("docket_id", help="e.g. EPA-HQ-OAR-2021-0317")
        x.add_argument("--pull", default="data", help="files to download: data (xlsx,xls,csv,zip — the "
                       "default), all, none, or a list like pdf,xlsx")
    dsub.add_parser("list", help="the tracked dockets")
    a = ap.parse_args(argv)

    if a.cmd == "fetch":
        fetch.run(a.date, a.force, a.parts)
    elif a.cmd == "import":
        from .corpus import importer
        importer.run()
    elif a.cmd == "serve":
        from .app import create_app
        create_app().run(host=a.host, port=a.port, debug=a.debug)
    elif a.cmd == "status":
        from .corpus.store import corpus_exists, read_meta
        print(f"data directory: {config.data_dir()}")
        print(f"corpus:         {config.ecfr_db()} — " + ("present" if corpus_exists() else "absent (run fetch, then import)"))
        if corpus_exists():
            m = read_meta()
            print(f"  snapshot {m.get('snapshot_date')} · parts {m.get('parts')} · "
                  f"{m.get('section_count')} sections · imported {m.get('imported_at')}")
        print(f"annotations:    {config.annotations_db()}")
        print(f"ECFR_CONTACT:   {config.contact() or 'unset (fetch and the update check need it)'}")
        print(f"dockets:        {config.dockets_db()} · REGSGOV_API_KEY "
              f"{'set' if config.regsgov_api_key() else 'unset (the Dockets tab needs it)'}")
    elif a.cmd == "dockets":
        return dockets_cmd(a)
    return 0


def dockets_cmd(a):
    from .dockets import store
    store.init_db()
    if a.dcmd == "list":
        rows = store.list_dockets()
        if not rows:
            print(f"no dockets tracked yet — `{config.prog()} dockets add EPA-HQ-OAR-2021-0317`, "
                  "or add one from the Dockets tab")
        for d in rows:
            st = d.get("sync_state") or {}
            print(f"{d['docket_id']}  {d.get('short_title') or d.get('title') or ''}")
            print(f"    {d['document_count']} documents ({d['pending_count']} without detail) · "
                  f"{d['file_count']} files ({d['local_count']} kept) · "
                  f"sync {st.get('phase') or 'never'}" + (f" — {st['stopped_reason']}" if st.get("stopped_reason") else ""))
        return 0
    from .dockets import client, sync
    docket_id = a.docket_id.strip().upper()
    try:
        config.require_regsgov_api_key()
        if a.dcmd == "add":
            store.upsert_docket(client.docket(docket_id))
            print(f"tracking {docket_id}")
        elif not store.get_docket(docket_id):
            sys.exit(f"{docket_id} is not tracked; `{config.prog()} dockets add {docket_id}` first")
    except (RuntimeError, client.RegsGovError) as e:
        sys.exit(str(e))

    last = {"line": None}

    def progress(state):
        line = f"  {state['phase']}: {state['done']}/{state['total']}"
        if line != last["line"]:
            print(line, flush=True)
            last["line"] = line
    state = sync.sync_docket(docket_id, a.pull, progress)
    if state.get("stopped_reason"):
        print(f"stopped ({state['stopped_reason']}): {state.get('message')}")
        return 1
    print(f"complete: {state['requests']} requests · " +
          " · ".join(f"{k} {v}" for k, v in (state.get("types") or {}).items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())
