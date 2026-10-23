"""The command line and the config it reads."""
import pytest

from ecfr_reader import config
from ecfr_reader.__main__ import main


def test_status_without_a_corpus(data_dir, capsys):
    assert main(["status"]) == 0
    out = capsys.readouterr().out
    assert str(data_dir) in out and "absent" in out and "ECFR_CONTACT" in out


def test_import_then_status(data_dir, capsys):
    main(["import"])
    main(["status"])
    assert "5 sections" in capsys.readouterr().out


def test_fetch_refuses_without_a_contact(data_dir):
    with pytest.raises(SystemExit, match="ECFR_CONTACT"):
        main(["fetch"])


def test_user_agent_names_the_contact(monkeypatch):
    monkeypatch.setenv("ECFR_CONTACT", "someone@example.org")
    ua = config.user_agent()
    assert ua.startswith("ecfr-reader/") and "someone@example.org" in ua and config.REPO_URL in ua


def test_hints_spell_the_program_the_way_it_was_run(monkeypatch):
    import sys
    monkeypatch.setattr(sys, "argv", ["/x/.venv/bin/ecfr-reader", "fetch"])
    assert config.prog() == "ecfr-reader"
    monkeypatch.setattr(sys, "argv", ["/x/ecfr_reader/__main__.py", "fetch"])
    assert config.prog().endswith(" -m ecfr_reader")
