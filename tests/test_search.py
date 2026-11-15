"""Global search: GET /api/search over pages, tasks, review comments and clips, with the same permissions as
the surfaces they come from."""

import uuid

import pytest

from api.state import projects
from database.engine import execute
from database.utils import get_db

from conftest import auth
from test_pages import create, make_task, team  # noqa: F401  (team is a fixture)


def mark():
    """A word no other test uses (the database is shared by the whole session)."""
    return "zq" + uuid.uuid4().hex[:10]


def set_text(page_id, text):
    with get_db() as conn:
        execute(conn, "UPDATE pages SET text = ? WHERE id = ?", (text, page_id))


def search(client, token, q, **params):
    return client.get("/api/search", params={"q": q, **params}, headers=auth(token))


def found(client, token, q, **params):
    """{type: [item, ...]} of a successful search."""
    res = search(client, token, q, **params)
    assert res.status_code == 200, res.text
    return {g["type"]: g["items"] for g in res.json()["groups"]}


def ids(items):
    return [i["id"] for i in items]


def comment(client, token, project_id, text, **body):
    res = client.post(f"/api/projects/{project_id}/comment", json={"frame": 7, "text": text, **body}, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()


def add_clip(project_id, name):
    projects[project_id].setdefault("clips", {})[name] = {"versions": [], "activeVersion": 1}


@pytest.fixture
def scene(client, team, make_user, grant):
    """team: member (reviews and tasks), reviewer (review only), viewer, outsider. Plus a tasks-only member."""
    tasks_only = make_user()
    grant(team["project"], tasks_only["user"]["id"], can_review=False, can_tasks=True)
    return {**team, "tasks_only": tasks_only["token"], "word": mark()}


# ---------- each type is found ----------

def test_finds_a_page_by_title_and_by_body_text_with_a_snippet(client, scene):
    word = scene["word"]
    by_title = create(client, scene["member"], scene["space"], f"Notes {word}")["id"]
    by_body = create(client, scene["member"], scene["space"], "Meeting")["id"]
    set_text(by_body, f"Agenda for the week. We should talk about {word} and the budget before Friday.")
    items = found(client, scene["member"], word)["page"]
    assert set(ids(items)) == {by_title, by_body}
    body_item = next(i for i in items if i["id"] == by_body)
    assert word in body_item["snippet"] and "budget" in body_item["snippet"]
    assert body_item["route"] == f"/p/{scene['project']}/page/{by_body}"
    assert body_item["projectId"] == scene["project"] and body_item["projectName"]
    assert body_item["title"] == "Meeting"


def test_finds_a_task_by_name_description_and_body(client, scene):
    word = scene["word"]
    by_name = make_task(client, scene["member"], scene["project"], f"Cut {word}")
    by_description = make_task(client, scene["member"], scene["project"], "Describe")
    res = client.patch(f"/api/tasks/{by_description}", json={"description": f"Needs the {word} footage"},
                       headers=auth(scene["member"]))
    assert res.status_code == 200, res.text
    by_body = make_task(client, scene["member"], scene["project"], "Has a body")
    page = client.get(f"/api/tasks/{by_body}/page", headers=auth(scene["member"])).json()["id"]
    set_text(page, f"Body text with {word} inside")
    items = found(client, scene["member"], word)["task"]
    assert set(ids(items)) == {by_name, by_description, by_body}
    assert next(i for i in items if i["id"] == by_description)["snippet"].startswith("Needs the")
    assert word in next(i for i in items if i["id"] == by_body)["snippet"]
    assert items[0]["route"].startswith(f"/p/{scene['project']}/tasks?task=")


def test_finds_a_comment_with_the_review_deep_link(client, scene):
    word = scene["word"]
    add_clip(scene["project"], f"shot_{word}")
    made = comment(client, scene["member"], scene["project"], f"Please fix the {word} here",
                   clipBaseName=f"shot_{word}", clipVersion=2, frame=48)
    item = found(client, scene["member"], word)["comment"][0]
    assert item["id"] == made["id"] and word in item["title"]
    assert (item["clip"], item["version"], item["frame"]) == (f"shot_{word}", 2, 48)
    assert item["route"] == f"/p/{scene['project']}/review?clip=shot_{word}&v=2&frame=48"
    assert item["projectId"] == scene["project"]


def test_finds_a_clip_by_name(client, scene):
    word = scene["word"]
    add_clip(scene["project"], f"Opening_{word}")
    item = found(client, scene["member"], word.upper())["clip"][0]
    assert item["title"] == f"Opening_{word}" and item["id"] == f"{scene['project']}:Opening_{word}"
    assert item["route"] == f"/p/{scene['project']}/review?clip=Opening_{word}"


# ---------- permissions ----------

def test_permission_matrix(client, scene, admin):
    word = scene["word"]
    page = create(client, scene["member"], scene["space"], f"Plan {word}")["id"]
    task = make_task(client, scene["member"], scene["project"], f"Task {word}")
    add_clip(scene["project"], f"clip_{word}")
    made = comment(client, scene["member"], scene["project"], f"Comment {word}", clipBaseName=f"clip_{word}")

    everything = {"page": [page], "task": [task], "comment": [made["id"]], "clip": [f"{scene['project']}:clip_{word}"]}
    seen = lambda who: {t: ids(i) for t, i in found(client, who, word).items()}  # noqa: E731
    assert seen(scene["member"]) == everything
    assert seen(admin["token"]) == everything
    # review only: no tasks
    assert seen(scene["reviewer"]) == {k: v for k, v in everything.items() if k != "task"}
    # tasks only: no comments or clips; the project's pages are readable with any access
    assert seen(scene["tasks_only"]) == {"page": [page], "task": [task]}
    assert seen(scene["outsider"]) == {}


def test_guests_are_refused_and_anonymous_is_unauthorized(client, scene, share):
    guest = share(scene["project"])["token"]
    assert search(client, guest, "x").status_code == 403
    assert client.get("/api/search", params={"q": "x"}).status_code == 401


def test_personal_pages_are_private_even_from_admins(client, scene, admin):
    word = scene["word"]
    mine = create(client, scene["member"], "me", f"Diary {word}")["id"]
    set_text(mine, f"secret {word}")
    assert ids(found(client, scene["member"], word)["page"]) == [mine]
    mine_item = found(client, scene["member"], word)["page"][0]
    assert mine_item["route"] == f"/me/page/{mine}" and mine_item["projectId"] is None
    assert "page" not in found(client, admin["token"], word)
    assert "page" not in found(client, scene["outsider"], word)
    assert "page" not in found(client, scene["reviewer"], word)


def test_project_filter_and_unknown_projects(client, scene):
    word = scene["word"]
    inside = create(client, scene["member"], scene["space"], f"In project {word}")["id"]
    create(client, scene["member"], "me", f"Personal {word}")
    assert ids(found(client, scene["member"], word, project=scene["project"])["page"]) == [inside]
    assert found(client, scene["outsider"], word, project=scene["project"]) == {}
    assert found(client, scene["member"], word, project="no-such-project") == {}


def test_archived_pages_and_deleted_tasks_are_not_returned(client, scene):
    word = scene["word"]
    page = create(client, scene["member"], scene["space"], f"Gone {word}")["id"]
    task = make_task(client, scene["member"], scene["project"], f"Gone {word}")
    assert set(found(client, scene["member"], word)) == {"page", "task"}
    with get_db() as conn:
        execute(conn, "UPDATE pages SET archived_at = ? WHERE id = ?", ("2024-01-01T00:00:00", page))
    assert client.delete(f"/api/tasks/{task}", headers=auth(scene["member"])).status_code == 200
    assert found(client, scene["member"], word) == {}


# ---------- matching and ranking ----------

def test_multi_word_needs_every_word_anywhere(client, scene):
    a, b = mark(), mark()
    both = create(client, scene["member"], scene["space"], f"{a} plan")["id"]
    set_text(both, f"and also {b}")
    only_one = create(client, scene["member"], scene["space"], f"{a} alone")["id"]
    items = found(client, scene["member"], f"{a} {b}")["page"]
    assert ids(items) == [both] and only_one not in ids(items)
    # case and word order do not matter
    assert ids(found(client, scene["member"], f"{b.upper()}  {a}")["page"]) == [both]


def test_accents_do_not_matter_in_titles_and_in_memory_text(client, scene):
    word = mark()
    page = create(client, scene["member"], scene["space"], f"Café {word}")["id"]
    assert ids(found(client, scene["member"], f"cafe {word}")["page"]) == [page]
    add_clip(scene["project"], f"Éclair_{word}")
    assert found(client, scene["member"], f"eclair_{word}")["clip"][0]["title"] == f"Éclair_{word}"


def test_ranking_prefix_then_substring_then_body_then_recency(client, scene):
    word = mark()
    body = create(client, scene["member"], scene["space"], "Unrelated title")["id"]
    set_text(body, f"mentions {word} only in the body")
    sub = create(client, scene["member"], scene["space"], f"About {word}")["id"]
    prefix_old = create(client, scene["member"], scene["space"], f"{word} first")["id"]
    prefix_new = create(client, scene["member"], scene["space"], f"{word} second")["id"]
    with get_db() as conn:
        for page_id, stamp in ((prefix_old, "2020-01-01T00:00:00"), (prefix_new, "2021-01-01T00:00:00"),
                               (sub, "2023-01-01T00:00:00"), (body, "2024-01-01T00:00:00")):
            execute(conn, "UPDATE pages SET updated_at = ? WHERE id = ?", (stamp, page_id))
    assert ids(found(client, scene["member"], word)["page"]) == [prefix_new, prefix_old, sub, body]


def test_limit_caps_each_group(client, scene):
    word = mark()
    for n in range(5):
        create(client, scene["member"], scene["space"], f"{word} {n}")
        add_clip(scene["project"], f"{word}_{n}")
    groups = found(client, scene["member"], word, limit=3)
    assert len(groups["page"]) == 3 and len(groups["clip"]) == 3
    assert len(found(client, scene["member"], word)["page"]) == 5
    assert search(client, scene["member"], word, limit=0).status_code == 422
    assert search(client, scene["member"], word, limit=1000).status_code == 422


def test_types_filter(client, scene):
    word = mark()
    create(client, scene["member"], scene["space"], f"Page {word}")
    add_clip(scene["project"], f"clip_{word}")
    assert set(found(client, scene["member"], word)) == {"page", "clip"}
    assert set(found(client, scene["member"], word, types="clip")) == {"clip"}
    assert set(found(client, scene["member"], word, types="pages,task")) == {"page"}
    assert search(client, scene["member"], word, types="bogus").status_code == 400


def test_snippet_is_short_and_has_ellipses(client, scene):
    word = mark()
    page = create(client, scene["member"], scene["space"], "Long one")["id"]
    set_text(page, "lorem ipsum " * 60 + f" {word} " + "dolor sit " * 60)
    snippet = found(client, scene["member"], word)["page"][0]["snippet"]
    assert word in snippet and snippet.startswith("...") and snippet.endswith("...") and len(snippet) < 200


# ---------- odd input ----------

@pytest.mark.parametrize("q", ["%", "_", "100%", "a_b", "'", '"', "'; DROP TABLE pages; --", "\\", "!", "!%", "   ",
                               "\u0000", "x" * 5000, " ".join(["word"] * 500), "\U0001F600", "%%%___"])
def test_odd_queries_are_safe(client, scene, q):
    create(client, scene["member"], scene["space"], "Plain page")
    res = search(client, scene["member"], q)
    assert res.status_code == 200, res.text
    assert isinstance(res.json()["groups"], list)


def test_wildcards_are_matched_literally(client, scene):
    word = mark()
    literal = create(client, scene["member"], scene["space"], f"{word} 100% done")["id"]
    other = create(client, scene["member"], scene["space"], f"{word} 100 done")["id"]
    set_text(literal, f"{word} 100% done")
    set_text(other, f"{word} 100 done")
    assert ids(found(client, scene["member"], f"{word} 100%")["page"]) == [literal]


def test_empty_query_gives_nothing(client, scene):
    body = search(client, scene["member"], "").json()
    assert body["groups"] == [] and isinstance(body["took"], int)
