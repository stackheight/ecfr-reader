"""ecfr-reader fetch | import | serve | status"""
import argparse
import sys

from . import __version__, config


def main(argv=None):
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
