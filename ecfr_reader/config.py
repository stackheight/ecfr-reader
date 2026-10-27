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

REPO_URL = "https://github.com/stackheight/ecfr-reader"
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


# ── regulations.gov (the Dockets tab) ───────────────────────────────────

REGSGOV_SIGNUP_URL = "https://api.data.gov/signup/"
DEFAULT_AUTO_PULL = "xlsx,xls,csv,zip"


def dockets_db():
    return os.environ.get("ECFR_DOCKETS_DB") or os.path.join(data_dir(), "dockets.db")


def dockets_dir():
    """Where kept docket files live: <data>/dockets/<docket>/<document>/<file>."""
    return os.path.join(data_dir(), "dockets")


def regsgov_api_key():
    """The api.data.gov key, or None when unset. DEMO_KEY (30 requests an
    hour, shared by everyone on the IP) is deliberately not a fallback."""
    return (os.environ.get("REGSGOV_API_KEY") or "").strip() or None


def require_regsgov_api_key():
    key = regsgov_api_key()
    if not key:
        raise RuntimeError(
            "REGSGOV_API_KEY is not set. regulations.gov needs an api.data.gov key "
            f"(free, instant: {REGSGOV_SIGNUP_URL}); export REGSGOV_API_KEY=… and run "
            "again. The reader itself works without it — only the Dockets tab talks to "
            "regulations.gov.")
    return key


def auto_pull_formats():
    """Formats a sync downloads on its own, lower-cased, from REGSGOV_AUTO_PULL
    (default xlsx,xls,csv,zip). "none" or an empty value means catalog only."""
    raw = os.environ.get("REGSGOV_AUTO_PULL")
    raw = DEFAULT_AUTO_PULL if raw is None else raw
    if raw.strip().lower() in ("", "none", "0", "off"):
        return set()
    return {f.strip().lower().lstrip(".") for f in raw.split(",") if f.strip()}


def regsgov_user_agent():
    """regulations.gov does not ask for a contact the way ecfr.gov does; the
    client still says who it is, and names the contact when one is set."""
    who = contact()
    return f"ecfr-reader/{__version__} (+{REPO_URL}" + (f"; contact: {who})" if who else ")")
