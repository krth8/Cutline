"""A task made from a review comment, and the clip summaries the clip block in pages reads."""

import pytest

import server
from api import auth as api_auth
from database import db_get_project
from database.batch import db_batch_upsert_clips

from conftest import auth


@pytest.fixture(autouse=True)
def no_rate_limit():
    api_auth.comment_attempts.clear()


@pytest.fixture
def connect(client, ticket):
    def _connect(token, client_id):
        return client.websocket_connect(f"/ws/live?client_id={client_id}&ticket={ticket(token)}")
    return _connect


def add_clip(project_id, base_name="shot_010", status=None):
    """Put a clip with one version into memory and the database (tasks link to the database row)."""
    clip = {"activeVersion": 1, "versions": [
        {"version": 1, "versionStr": "v1", "filename": f"{project_id}_{base_name}_v1.mp4",
         "thumbnail": f"{project_id}_{base_name}_v1.jpg", "uploadedAt": "2030-01-01T00:00:00", "mediaType": "video"}]}
    if status:
        clip["status"] = status
    server.projects[project_id]["clips"][base_name] = clip
    db_batch_upsert_clips(project_id, [(base_name, clip)])
    return clip


def add_comment(client, project_id, token, text="Make the logo bigger\nand move it left", frame=48, clip="shot_010"):
    res = client.post(f"/api/projects/{project_id}/comment",
                      json={"frame": frame, "text": text, "clipBaseName": clip, "clipVersion": 1}, headers=auth(token))
    assert res.status_code == 200, res.text
    return res.json()


def make_task(client, project_id, comment_id, token):
    return client.post(f"/api/projects/{project_id}/comments/{comment_id}/task", headers=auth(token))


def stored_comment(project_id, comment_id):
    return [c for c in server.projects[project_id]["comments"] if c["id"] == comment_id][0]


@pytest.fixture
def scene(client, admin, make_project, make_user, grant):
    project_id = make_project()
    add_clip(project_id)
    tasker, reviewer = make_user(), make_user()
    grant(project_id, tasker["user"]["id"], can_tasks=True)
    grant(project_id, reviewer["user"]["id"], can_tasks=False)
    return {"project": project_id, "tasker": tasker, "reviewer": reviewer}


def test_task_gets_name_description_clip_frame_and_comment(client, scene):
    p, tasker = scene["project"], scene["tasker"]
    comment = add_comment(client, p, tasker["token"])
    res = make_task(client, p, comment["id"], tasker["token"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["created"] is True
    task = body["task"]
    assert task["name"] == "Make the logo bigger"
    assert task["description"] == "Make the logo bigger\nand move it left"
    assert task["projectId"] == p
    assert task["clipName"] == "shot_010"
    assert task["clipId"] is not None
    assert task["clipFrame"] == 48
    assert task["commentId"] == comment["id"]
    # It is a normal task: the task API and the project payload see it
    assert client.get(f"/api/tasks/{task['id']}", headers=auth(tasker["token"])).json()["task"]["commentId"] == comment["id"]
    clips = client.get(f"/api/tasks/{task['id']}/clips", headers=auth(tasker["token"])).json()["clips"]
    assert [c["id"] for c in clips] == [task["clipId"]]
    stored = [c for c in db_get_project(p)["comments"] if c["id"] == comment["id"]][0]
    assert stored["taskId"] == task["id"]
    assert stored_comment(p, comment["id"])["taskId"] == task["id"]


def test_long_first_line_is_cut_at_a_word(client, scene):
    p, tasker = scene["project"], scene["tasker"]
    comment = add_comment(client, p, tasker["token"], text="word " * 40)
    name = make_task(client, p, comment["id"], tasker["token"]).json()["task"]["name"]
    assert len(name) <= 80 and name.endswith("…") and "  " not in name


def test_second_request_returns_the_same_task(client, scene):
    p, tasker = scene["project"], scene["tasker"]
    comment = add_comment(client, p, tasker["token"])
    first = make_task(client, p, comment["id"], tasker["token"]).json()
    second = make_task(client, p, comment["id"], tasker["token"]).json()
    assert second["created"] is False
    assert second["task"]["id"] == first["task"]["id"]
    tasks = client.get(f"/api/projects/{p}/tasks", headers=auth(tasker["token"])).json()["tasks"]
    assert len([t for t in tasks if t.get("commentId") == comment["id"]]) == 1


def test_reviewer_without_task_rights_is_refused(client, scene):
    p = scene["project"]
    comment = add_comment(client, p, scene["reviewer"]["token"])
    assert make_task(client, p, comment["id"], scene["reviewer"]["token"]).status_code == 403
    assert "taskId" not in stored_comment(p, comment["id"])


def test_guest_is_refused(client, scene, share):
    p = scene["project"]
    guest = share(p)
    comment = add_comment(client, p, guest["token"])
    assert make_task(client, p, comment["id"], guest["token"]).status_code == 403
    assert client.post(f"/api/projects/{p}/comments/{comment['id']}/task").status_code == 401


def test_user_of_another_project_is_refused(client, scene, make_project, make_user, grant):
    p = scene["project"]
    comment = add_comment(client, p, scene["tasker"]["token"])
    other = make_project()
    outsider = make_user()
    grant(other, outsider["user"]["id"], can_tasks=True)
    # Task rights somewhere else do not help, and the comment id is not looked up under the other project
    assert make_task(client, p, comment["id"], outsider["token"]).status_code == 403
    assert make_task(client, other, comment["id"], outsider["token"]).status_code == 404


def test_viewer_role_is_refused_even_with_task_access(client, scene, make_user, grant):
    p = scene["project"]
    viewer = make_user("viewer")
    grant(p, viewer["user"]["id"], can_tasks=True)
    comment = add_comment(client, p, scene["tasker"]["token"])
    assert make_task(client, p, comment["id"], viewer["token"]).status_code == 403


def test_unknown_comment_is_404(client, scene):
    assert make_task(client, scene["project"], "nope", scene["tasker"]["token"]).status_code == 404


def test_comment_without_a_clip_still_makes_a_task(client, scene):
    p, tasker = scene["project"], scene["tasker"]
    comment = client.post(f"/api/projects/{p}/comment", json={"frame": 3, "text": "General note"},
                          headers=auth(tasker["token"])).json()
    task = make_task(client, p, comment["id"], tasker["token"]).json()["task"]
    assert task["clipId"] is None and task["clipFrame"] == 3


def test_events_go_to_the_right_people(client, scene, connect):
    p, tasker, reviewer = scene["project"], scene["tasker"], scene["reviewer"]
    comment = add_comment(client, p, tasker["token"])
    with connect(tasker["token"], "t") as with_tasks, connect(reviewer["token"], "r") as without:
        for ws in (with_tasks, without):
            ws.send_json({"type": "watch", "projects": [p]})
            assert ws.receive_json()["type"] == "watching"
        res = make_task(client, p, comment["id"], tasker["token"])
        task_id = res.json()["task"]["id"]
        created = with_tasks.receive_json()
        assert created["type"] == "task_created" and created["task"]["id"] == task_id
        changed = with_tasks.receive_json()
        assert changed["type"] == "rows_changed" and changed["ids"] == [task_id] and changed["change"] == "created"
        updated = with_tasks.receive_json()
        assert updated == {"type": "comment_updated", "commentId": comment["id"], "resolved": False,
                           "taskId": task_id, "project": p}
        # The reviewer hears about the comment's chip, not about the task
        assert without.receive_json()["type"] == "comment_updated"
        without.send_json({"type": "ping"})
        assert without.receive_json() == {"type": "pong"}


def test_deleting_the_task_frees_the_comment(client, scene, connect):
    p, tasker = scene["project"], scene["tasker"]
    comment = add_comment(client, p, tasker["token"])
    first = make_task(client, p, comment["id"], tasker["token"]).json()["task"]
    with connect(tasker["token"], "t") as ws:
        ws.send_json({"type": "watch", "projects": [p]})
        assert ws.receive_json()["type"] == "watching"
        assert client.delete(f"/api/tasks/{first['id']}", headers=auth(tasker["token"])).status_code == 200
        seen = [ws.receive_json() for _ in range(3)]
        cleared = [m for m in seen if m["type"] == "comment_updated"]
        assert cleared and cleared[0]["taskId"] is None
    assert "taskId" not in stored_comment(p, comment["id"])
    again = make_task(client, p, comment["id"], tasker["token"]).json()
    assert again["created"] is True and again["task"]["id"] != first["id"]


def test_table_api_row_still_reads(client, scene):
    p, tasker = scene["project"], scene["tasker"]
    comment = add_comment(client, p, tasker["token"])
    task = make_task(client, p, comment["id"], tasker["token"]).json()["task"]
    res = client.post(f"/api/tables/tasks:{p}/query", json={}, headers=auth(tasker["token"]))
    assert res.status_code == 200, res.text
    row = [r for r in res.json()["rows"] if r["id"] == task["id"]][0]
    assert row["values"]["clip"]["name"] == "shot_010"


# ---- Clip summaries for the clip block ----

def test_summary_has_what_the_card_shows(client, scene):
    p, tasker = scene["project"], scene["tasker"]
    server.projects[p]["clips"]["shot_010"]["status"] = {"id": "s", "name": "In review", "color": "#fff"}
    add_comment(client, p, tasker["token"])
    add_comment(client, p, tasker["token"], text="two")
    res = client.get(f"/api/projects/{p}/clips/shot_010/summary", headers=auth(tasker["token"]))
    assert res.status_code == 200, res.text
    assert res.json() == {
        "projectId": p, "baseName": "shot_010", "version": 1, "versionStr": "v1", "activeVersion": 1, "versionCount": 1,
        "thumbnail": f"{p}_shot_010_v1.jpg", "mediaType": "video",
        "status": {"id": "s", "name": "In review", "color": "#fff"}, "commentCount": 2,
    }
    # An unknown version falls back to the active one
    unknown = client.get(f"/api/projects/{p}/clips/shot_010/summary?version=9", headers=auth(tasker["token"]))
    assert unknown.json()["version"] == 1
    listed = client.get(f"/api/projects/{p}/clip-summaries", headers=auth(tasker["token"])).json()["clips"]
    assert [c["baseName"] for c in listed] == ["shot_010"]


def test_summary_needs_review_access_and_names_nothing(client, scene, make_user, grant, share):
    p = scene["project"]
    outsider = make_user()
    no_review = make_user()
    grant(p, no_review["user"]["id"], can_review=False, can_tasks=True)
    guest = share(p)
    for token in (outsider["token"], no_review["token"], guest["token"]):
        for path in (f"/api/projects/{p}/clips/shot_010/summary", f"/api/projects/{p}/clips/missing/summary",
                     f"/api/projects/{p}/clip-summaries"):
            res = client.get(path, headers=auth(token))
            assert res.status_code == 403, (path, res.text)
            assert "shot_010" not in res.text
    assert client.get(f"/api/projects/{p}/clips/shot_010/summary").status_code == 401


def test_summary_of_a_deleted_clip_is_404(client, scene):
    p, tasker = scene["project"], scene["tasker"]
    add_clip(p, "gone")
    assert client.get(f"/api/projects/{p}/clips/gone/summary", headers=auth(tasker["token"])).status_code == 200
    del server.projects[p]["clips"]["gone"]
    assert client.get(f"/api/projects/{p}/clips/gone/summary", headers=auth(tasker["token"])).status_code == 404
