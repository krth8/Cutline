"""Who can see and change what: roles, project access and share-link guests."""

from conftest import auth


def test_user_without_access_cannot_open_a_project(client, make_project, make_user):
    project_id = make_project()
    user = make_user()
    assert client.get(f"/api/projects/{project_id}", headers=auth(user["token"])).status_code == 403
    listed = client.get("/api/projects", headers=auth(user["token"])).json()["projects"]
    assert project_id not in [p["id"] for p in listed]


def test_granted_user_can_open_the_project(client, make_project, make_user, grant):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"])
    assert client.get(f"/api/projects/{project_id}", headers=auth(user["token"])).status_code == 200
    listed = client.get("/api/projects", headers=auth(user["token"])).json()["projects"]
    assert project_id in [p["id"] for p in listed]


def test_revoked_user_loses_the_project(client, admin, make_project, make_user, grant):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"])
    res = client.delete(f"/api/projects/{project_id}/access/{user['user']['id']}", headers=auth(admin["token"]))
    assert res.status_code == 200
    assert client.get(f"/api/projects/{project_id}", headers=auth(user["token"])).status_code == 403


def test_anonymous_cannot_open_a_project(client, make_project):
    project_id = make_project()
    assert client.get(f"/api/projects/{project_id}").status_code == 401
    assert client.get("/api/projects").json()["projects"] == []


def test_only_admins_reach_the_admin_api(client, make_user):
    editor = make_user("editor")
    for path in ("/api/admin/users", "/api/admin/invites", "/api/admin/guests", "/api/admin/cache"):
        assert client.get(path, headers=auth(editor["token"])).status_code == 403, path
        assert client.get(path).status_code == 401, path


def test_viewer_cannot_create_or_delete_projects(client, make_project, make_user, grant):
    viewer = make_user("viewer")
    assert client.post("/api/projects", json={"name": "x"}, headers=auth(viewer["token"])).status_code == 403
    project_id = make_project()
    grant(project_id, viewer["user"]["id"])
    assert client.delete(f"/api/projects/{project_id}", headers=auth(viewer["token"])).status_code == 403


def test_editor_cannot_delete_projects(client, make_project, make_user, grant):
    editor = make_user("editor")
    project_id = make_project()
    grant(project_id, editor["user"]["id"])
    assert client.delete(f"/api/projects/{project_id}", headers=auth(editor["token"])).status_code == 403


def test_only_owner_or_admin_grants_access(client, make_project, make_user, grant):
    project_id = make_project()
    member, outsider = make_user(), make_user()
    grant(project_id, member["user"]["id"])
    res = client.post(f"/api/projects/{project_id}/access", json={"userId": outsider["user"]["id"]},
                      headers=auth(member["token"]))
    assert res.status_code == 403


def test_tasks_need_task_access(client, make_project, make_user, grant):
    project_id = make_project()
    user = make_user()
    grant(project_id, user["user"]["id"], can_review=True, can_tasks=False)
    assert client.get(f"/api/projects/{project_id}/tasks", headers=auth(user["token"])).status_code == 403
    grant(project_id, user["user"]["id"], can_review=True, can_tasks=True)
    assert client.get(f"/api/projects/{project_id}/tasks", headers=auth(user["token"])).status_code == 200


def test_guest_sees_only_the_shared_project(client, make_project, share):
    shared, other = make_project(), make_project()
    guest = share(shared)
    assert client.get(f"/api/projects/{shared}", headers=auth(guest["token"])).status_code == 200
    assert client.get(f"/api/projects/{other}", headers=auth(guest["token"])).status_code == 403
    assert client.get("/api/projects", headers=auth(guest["token"])).json()["projects"] == []


def test_guest_is_not_a_logged_in_user(client, make_project, share):
    project_id = make_project()
    guest = share(project_id)
    assert client.get("/api/auth/me", headers=auth(guest["token"])).status_code == 401
    assert client.get(f"/api/projects/{project_id}/tasks", headers=auth(guest["token"])).status_code == 401
    assert client.post("/api/projects", json={"name": "x"}, headers=auth(guest["token"])).status_code == 401


def test_deleting_a_share_link_locks_its_guests_out(client, admin, make_project, share):
    project_id = make_project()
    guest = share(project_id)
    assert client.delete(f"/api/share/{guest['linkId']}", headers=auth(admin["token"])).status_code == 200
    assert client.get(f"/api/projects/{project_id}", headers=auth(guest["token"])).status_code == 401


def test_kicked_guest_is_locked_out(client, admin, make_project, share):
    project_id = make_project()
    guest = share(project_id)
    res = client.post("/api/guests/track", json={"name": "Kim", "projectId": project_id, "shareLinkId": guest["linkId"]},
                      headers=auth(guest["token"]))
    assert res.status_code == 200, res.text
    guest_id = res.json()["guest"]["id"]
    assert client.delete(f"/api/admin/guests/{guest_id}", headers=auth(admin["token"])).status_code == 200
    assert client.get(f"/api/projects/{project_id}", headers=auth(guest["token"])).status_code == 401


def test_password_protected_share_link(client, admin, make_project):
    project_id = make_project()
    res = client.post(f"/api/projects/{project_id}/share", json={"password": "sesame"}, headers=auth(admin["token"]))
    link_id = res.json()["link"]["id"]
    assert client.post(f"/api/share/{link_id}/access", json={"password": "wrong"}).json()["valid"] is False
    assert client.post(f"/api/share/{link_id}/access", json={"password": "sesame"}).json()["valid"] is True
