"""Where things live. Every value is read lazily from the environment so
tests can point a run at a temporary directory and so nothing has to be
set before the package is imported.

    ECFR_DATA_DIR   the data directory (default ./data under the current
                    working directory; `status` prints the resolved path)
    ECFR_DB         the corpus database (default <data>/ecfr.db)
    ECFR_ANNOTATIONS_DB   your notes / highlights / favorites
                    (default <data>/annotations.db — the one file worth
                    backing up; the corpus is rebuildable)
    ECFR_CONTACT    REQUIRED for anything that talks to ecfr.gov (fetch and
                    the update check): an email address or URL that goes
                    into the User-Agent so the eCFR operators can reach
                    whoever is running this. The reader itself never needs it.
"""
import os

from . import __version__

REPO_URL = "https://github.com/SpottedHound/ecfr-reader"
DEFAULT_STATE = {"title": 40, "chapter": "I", "subchapter": "C", "parts": "50-99", "snapshot_date": None}


def prog():
    """How to spell this program the way it was invoked: `ecfr-reader`
    after `pip install -e .`, else `python -m ecfr_reader` — so a hint
    like "now run: … import" is one the user can paste."""
    import sys
    if os.path.basename(sys.argv[0] or "").startswith("ecfr-reader"):
        return "ecfr-reader"
    return f"{os.path.basename(sys.executable) or 'python'} -m ecfr_reader"


def data_dir():
    return os.path.abspath(os.environ.get("ECFR_DATA_DIR") or "data")


def ecfr_db():
    return os.environ.get("ECFR_DB") or os.path.join(data_dir(), "ecfr.db")


def annotations_db():
    return os.environ.get("ECFR_ANNOTATIONS_DB") or os.path.join(data_dir(), "annotations.db")


def xml_dir():
    return os.path.join(data_dir(), "xml")


def dataset_state_path():
    return os.path.join(data_dir(), "dataset_state.json")


def contact():
    """The contact the User-Agent carries, or None when unset."""
    return (os.environ.get("ECFR_CONTACT") or "").strip() or None


def user_agent():
    """ecfr.gov asks for a User-Agent that identifies the client and how to
    reach its operator. Raises when ECFR_CONTACT is unset — a request with
    no contact is the one thing this tool must never send."""
    who = contact()
    if not who:
        raise RuntimeError(
            "ECFR_CONTACT is not set. ecfr.gov asks every client to identify "
            "itself with a contact (an email address or URL); export "
            "ECFR_CONTACT=you@example.org and run again. The reader itself "
            "works without it — only fetching and the update check talk to ecfr.gov.")
    return f"ecfr-reader/{__version__} (+{REPO_URL}; contact: {who})"
