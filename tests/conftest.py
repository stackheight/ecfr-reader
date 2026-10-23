"""Every test runs against a temporary data directory holding a corpus
built from one small synthetic part (tests/fixtures/title-40-part-999.xml)
— the shapes render.py walks (DIV5 part with HEAD / AUTH / SOURCE, a DIV6
subpart, DIV8 sections with paragraphs and a table, a DIV9 appendix, a
loose section outside any subpart), small enough to read beside the
assertions."""
import json
import os
import shutil

import pytest

HERE = os.path.dirname(__file__)
FIXTURE_XML = os.path.join(HERE, "fixtures", "title-40-part-999.xml")


@pytest.fixture
def data_dir(tmp_path, monkeypatch):
    d = tmp_path / "data"
    (d / "xml").mkdir(parents=True)
    shutil.copy(FIXTURE_XML, d / "xml" / "title-40-part-999.xml")
    (d / "dataset_state.json").write_text(json.dumps(
        {"title": 40, "chapter": "I", "subchapter": "C", "parts": "999", "snapshot_date": "2026-01-01"}))
    monkeypatch.setenv("ECFR_DATA_DIR", str(d))
    monkeypatch.delenv("ECFR_DB", raising=False)
    monkeypatch.delenv("ECFR_ANNOTATIONS_DB", raising=False)
    monkeypatch.delenv("ECFR_CONTACT", raising=False)
    return d


@pytest.fixture
def corpus(data_dir):
    from ecfr_reader.corpus import importer
    importer.run()
    return data_dir


@pytest.fixture
def client(corpus):
    from ecfr_reader.app import create_app
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()


@pytest.fixture
def empty_client(data_dir):
    """The app with the data directory present but no corpus imported."""
    from ecfr_reader.app import create_app
    app = create_app()
    app.config["TESTING"] = True
    return app.test_client()
