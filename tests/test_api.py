"""The corpus routes through the Flask test client."""


def test_corpus_routes_say_so_before_an_import(empty_client):
    assert empty_client.get("/api/ecfr/status").get_json() == {"present": False}
    r = empty_client.get("/api/ecfr/toc")
    assert r.status_code == 503 and "ecfr_reader import" in r.get_json()["error"]
    assert empty_client.get("/api/ecfr/search?q=x").status_code == 503
    assert empty_client.get("/").status_code == 200               # the page still loads


def test_status_toc_and_unit(client):
    s = client.get("/api/ecfr/status").get_json()
    assert s["present"] and s["section_count"] == 5 and s["part_count"] == 1
    toc = client.get("/api/ecfr/toc/999").get_json()
    assert toc["part"]["part"] == "999" and len(toc["subparts"]) == 2 and len(toc["sections"]) == 5
    assert client.get("/api/ecfr/toc/1").status_code == 404
    unit = client.get("/api/ecfr/unit?part=999&subpart=A").get_json()
    assert [x["section_key"] for x in unit["sections"]] == ["999:999.10", "999:999.11"]
    assert isinstance(unit["sections"][0]["blocks"], list)
    app = client.get("/api/ecfr/unit?part=999&appendix=Appendix%20A%20to%20Part%20999").get_json()
    assert app["heading"].startswith("Appendix A")
    assert client.get("/api/ecfr/unit?part=999&subpart=A&appendix=B").status_code == 400
    assert client.get("/api/ecfr/unit?part=999&subpart=Z").status_code == 404


def test_search_takes_any_input(client):
    r = client.get("/api/ecfr/search?q=spark+ignition").get_json()
    assert r["total"] == 1 and r["results"][0]["section_key"] == "999:999.10"
    # bareword operators and punctuation are literal, never a syntax error
    assert client.get('/api/ecfr/search?q=spark AND NOT "ignition" (x:y)').status_code == 200
    assert client.get("/api/ecfr/search?q=").get_json()["total"] == 0
    assert client.get("/api/ecfr/search?q=x&limit=abc").status_code == 400
    assert client.get("/api/ecfr/search?q=records&limit=1000").get_json()["limit"] == 100


def test_live_routes_need_a_contact(client):
    """Nothing reaches ecfr.gov without ECFR_CONTACT; the reader says so
    instead of sending an anonymous request."""
    r = client.get("/api/ecfr/section/live?key=999:999.1")
    assert r.status_code == 502 and "ECFR_CONTACT" in r.get_json()["error"]
    r = client.get("/api/ecfr/updates?force=1")
    assert r.status_code == 502 and "ECFR_CONTACT" in r.get_json()["error"]


def test_the_page_stamps_the_version_into_its_asset_links(empty_client):
    from ecfr_reader import __version__
    html = empty_client.get("/").get_data(as_text=True)
    assert f'src="js/ecfr.js?v={__version__}"' in html and "{{v}}" not in html
