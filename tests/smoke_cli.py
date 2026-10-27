"""The CLI and the server end to end, on whichever OS runs this: a corpus
from the synthetic part, `status`, then the app answering over the test
client. Run by the GitHub workflow after pytest (no network, no browser)."""
import json
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

from ecfr_reader.__main__ import main   # noqa: E402


def run():
    tmp = tempfile.mkdtemp(prefix="ecfr-smoke-")
    os.makedirs(os.path.join(tmp, "xml"))
    shutil.copy(os.path.join(HERE, "fixtures", "title-40-part-999.xml"), os.path.join(tmp, "xml", "title-40-part-999.xml"))
    with open(os.path.join(tmp, "dataset_state.json"), "w", encoding="utf-8") as f:
        json.dump({"title": 40, "chapter": "I", "subchapter": "C", "parts": "999", "snapshot_date": "2026-01-01"}, f)
    os.environ["ECFR_DATA_DIR"] = tmp
    assert main(["import"]) == 0
    assert main(["status"]) == 0
    from ecfr_reader.app import create_app
    client = create_app().test_client()
    assert client.get("/").status_code == 200
    status = client.get("/api/ecfr/status").get_json()
    assert status["section_count"] == 5, status
    assert client.get("/api/ecfr/search?q=records").get_json()["total"] == 1
    note = client.post("/api/ecfr/notes", json={"section_key": "999:999.1", "note": "smoke — ok →"})
    assert note.status_code == 201
    dockets = client.get("/api/dockets").get_json()          # loads with no REGSGOV_API_KEY
    assert dockets["dockets"] == [] and dockets["key_set"] is False, dockets
    print("smoke ok on", sys.platform, "python", sys.version.split()[0])


if __name__ == "__main__":
    run()
