"""Notes, highlights and favorites: the shapes the reader's JavaScript reads."""


def test_notes_crud(client):
    r = client.post("/api/ecfr/notes", json={"section_key": "999:999.10", "citation": "40 CFR 999.10", "note": "first"})
    assert r.status_code == 201
    note = r.get_json()
    assert set(note) == {"id", "section_key", "citation", "note", "created_at", "updated_at"}
    assert client.post("/api/ecfr/notes", json={"section_key": "", "note": "x"}).status_code == 400
    assert client.post("/api/ecfr/notes", json={"section_key": "999:999.10", "note": "  "}).status_code == 400
    assert client.patch(f"/api/ecfr/notes/{note['id']}", json={"note": "second"}).get_json() == {"status": "updated"}
    assert client.patch("/api/ecfr/notes/999", json={"note": "x"}).status_code == 404
    assert client.delete(f"/api/ecfr/notes/{note['id']}").get_json() == {"status": "deleted"}
    assert client.delete(f"/api/ecfr/notes/{note['id']}").status_code == 404


def test_highlights_crud_and_patch_whitelist(client):
    body = {"section_key": "999:999.10", "quote": "spark plug", "start_pos": 40, "end_pos": 50,
            "prefix": "uses a ", "suffix": " to ignite", "color": "green", "kind": "underline",
            "snapshot_date": "2026-01-01"}
    r = client.post("/api/ecfr/highlights", json=body)
    assert r.status_code == 201
    h = r.get_json()
    assert h["color"] == "green" and h["kind"] == "underline" and h["start_pos"] == 40 and h["comment"] is None
    assert client.post("/api/ecfr/highlights", json={**body, "color": "mauve"}).status_code == 400
    assert client.post("/api/ecfr/highlights", json={**body, "end_pos": 40}).status_code == 400
    assert client.post("/api/ecfr/highlights", json={k: v for k, v in body.items() if k != "start_pos"}).status_code == 400
    r = client.patch(f"/api/ecfr/highlights/{h['id']}", json={"comment": "why", "id": 77, "section_key": "evil"})
    assert r.status_code == 200 and r.get_json()["comment"] == "why"
    assert r.get_json()["id"] == h["id"] and r.get_json()["section_key"] == "999:999.10"   # unknown keys ignored
    assert client.patch(f"/api/ecfr/highlights/{h['id']}", json={"id": 1}).status_code == 400
    assert client.patch(f"/api/ecfr/highlights/{h['id']}", json={"comment": ""}).get_json()["comment"] is None
    assert client.patch("/api/ecfr/highlights/999", json={"color": "blue"}).status_code == 404
    assert client.delete(f"/api/ecfr/highlights/{h['id']}").get_json() == {"status": "deleted"}


def test_annotations_scope_buckets_and_counts(client):
    client.post("/api/ecfr/notes", json={"section_key": "999:999.10", "note": "in A"})
    client.post("/api/ecfr/notes", json={"section_key": "999:999.20", "note": "in B"})
    client.post("/api/ecfr/highlights", json={"section_key": "999:999.1", "quote": "loose", "start_pos": 1, "end_pos": 6})
    r = client.get("/api/ecfr/annotations?scope=section&key=999:999.10").get_json()
    assert [n["note"] for n in r["notes"]] == ["in A"] and r["highlights"] == []
    assert r["counts"] == {"title": {"notes": 2, "highlights": 1}, "part": {"notes": 2, "highlights": 1},
                           "subpart": {"notes": 1, "highlights": 0}, "section": {"notes": 1, "highlights": 0}}
    assert r["notes"][0]["section_citation"] == "40 CFR 999.10" and r["notes"][0]["subpart"] == "A"
    assert r["part"] == "999" and r["subpart"] == "A" and r["favorited"] is False
    title = client.get("/api/ecfr/annotations?scope=title").get_json()
    assert len(title["notes"]) == 2 and len(title["highlights"]) == 1
    assert client.get("/api/ecfr/annotations?scope=part").status_code == 400
    assert client.get("/api/ecfr/annotations?scope=galaxy&key=x").status_code == 400


def test_favorites_toggle(client):
    assert client.get("/api/ecfr/favorites").get_json() == []
    r = client.post("/api/ecfr/favorites", json={"node_type": "subpart", "node_key": "999/A", "label": "Subpart A"})
    assert r.get_json()["favorited"] is True
    assert client.post("/api/ecfr/favorites", json={"node_type": "section", "node_key": "999:999.10"}).get_json()["favorited"]
    favs = client.get("/api/ecfr/favorites").get_json()
    assert [f["node_key"] for f in favs] == ["999:999.10", "999/A"]        # newest first
    ann = client.get("/api/ecfr/annotations?scope=section&key=999:999.10").get_json()
    assert ann["favorited"] is True and ann["favorite_id"] == favs[0]["id"]
    assert client.post("/api/ecfr/favorites", json={"node_type": "subpart", "node_key": "999/A"}).get_json() == {"favorited": False, "favorite_id": None}
    assert client.post("/api/ecfr/favorites", json={"node_type": "planet", "node_key": "x"}).status_code == 400


def test_a_deleted_annotations_file_comes_back_empty(client, corpus):
    import os
    from ecfr_reader import config
    client.post("/api/ecfr/notes", json={"section_key": "999:999.10", "note": "gone soon"})
    os.remove(config.annotations_db())
    assert client.get("/api/ecfr/annotations?scope=title").get_json()["notes"] == []
    assert client.post("/api/ecfr/notes", json={"section_key": "999:999.10", "note": "fresh"}).status_code == 201
