"""Login sessions: tokens, logout, idle timeout."""

import time
from datetime import timedelta

from api import sessions as auth_sessions
from api.auth import create_jwt_token, verify_jwt_token

from conftest import ADMIN, auth


def me(client, token, **headers):
    return client.get("/api/auth/me", headers={**auth(token), **headers})


def session_of(token):
    return auth_sessions._all()[verify_jwt_token(token)["sid"]]


def test_setup_logs_the_first_admin_in(client, admin):
    res = me(client, admin["token"])
    assert res.status_code == 200
    body = res.json()
    assert body["user"]["username"] == ADMIN["username"]
    assert body["user"]["is_admin"] is True
    assert "sid" not in body["user"]
    assert body["idleTimeout"] == auth_sessions.IDLE_TIMEOUT
    assert 0 < body["idleRemaining"] <= auth_sessions.IDLE_TIMEOUT


def test_setup_cannot_be_repeated(client, admin):
    res = client.post("/api/setup/complete", json={"username": "other", "password": "another-password-1"})
    assert res.status_code == 400


def test_wrong_password_is_rejected(client, admin):
    res = client.post("/api/auth/login", json={"username": ADMIN["username"], "password": "nope"})
    assert res.json()["valid"] is False
    assert "token" not in res.json()


def test_requests_without_a_valid_token_get_401(client, admin):
    assert client.get("/api/auth/me").status_code == 401
    assert me(client, "not-a-token").status_code == 401
    assert me(client, admin["token"] + "x").status_code == 401


def test_token_without_a_session_is_not_a_login(client, admin):
    user = admin["user"]
    token = create_jwt_token(user["id"], user["username"], True)
    assert me(client, token).status_code == 401


def test_media_token_is_not_a_login(client, admin):
    user = admin["user"]
    sid = verify_jwt_token(admin["token"])["sid"]
    token = create_jwt_token(user["id"], user["username"], True, extra_claims={"scope": "media", "sid": sid})
    assert me(client, token).status_code == 401


def test_expired_token_is_rejected(client, admin):
    user = admin["user"]
    sid = verify_jwt_token(admin["token"])["sid"]
    token = create_jwt_token(user["id"], user["username"], True,
                             expires_delta=timedelta(seconds=-1), extra_claims={"sid": sid})
    assert me(client, token).status_code == 401


def test_logout_ends_the_session_on_the_server(client, make_user):
    user = make_user()
    assert me(client, user["token"]).status_code == 200
    assert client.post("/api/auth/logout", headers=auth(user["token"])).status_code == 200
    assert me(client, user["token"]).status_code == 401


def test_logout_only_ends_that_login(client, make_user, login):
    first = make_user()
    second = login(first["user"]["username"])
    client.post("/api/auth/logout", headers=auth(first["token"]))
    assert me(client, first["token"]).status_code == 401
    assert me(client, second["token"]).status_code == 200


def test_idle_session_times_out(client, make_user):
    user = make_user()
    session_of(user["token"])["last_activity"] = time.time() - auth_sessions.IDLE_TIMEOUT - 1
    assert me(client, user["token"]).status_code == 401


def test_requests_count_as_activity(client, make_user):
    user = make_user()
    session = session_of(user["token"])
    session["last_activity"] = time.time() - 1000
    assert me(client, user["token"]).status_code == 200
    assert time.time() - session["last_activity"] < 5


def test_background_requests_do_not_keep_a_session_alive(client, make_user):
    user = make_user()
    session = session_of(user["token"])
    before = session["last_activity"] = int(time.time()) - 1000
    # The browser says the user has not touched anything for 2000 seconds
    assert me(client, user["token"], **{"X-Idle-Seconds": "2000"}).status_code == 200
    assert session["last_activity"] == before
    # ...and here the user was active 10 seconds ago
    assert me(client, user["token"], **{"X-Idle-Seconds": "10"}).status_code == 200
    assert abs(session["last_activity"] - (time.time() - 10)) < 5


def test_session_has_a_maximum_age(client, make_user):
    user = make_user()
    session_of(user["token"])["expires_at"] = time.time() - 1
    assert me(client, user["token"]).status_code == 401


def test_timed_out_sessions_are_swept(client, make_user):
    user = make_user()
    sid = verify_jwt_token(user["token"])["sid"]
    session_of(user["token"])["last_activity"] = time.time() - auth_sessions.IDLE_TIMEOUT - 1
    assert sid in auth_sessions.end_expired()
    assert sid not in auth_sessions._all()


def test_sessions_survive_a_restart(client, make_user):
    user = make_user()
    auth_sessions._sessions = None  # forget the in-memory copy, as after a restart
    assert me(client, user["token"]).status_code == 200


def test_new_password_logs_the_user_out(client, admin, make_user, login):
    user = make_user()
    res = client.patch(f"/api/admin/users/{user['user']['id']}", json={"password": "a-brand-new-password"},
                       headers=auth(admin["token"]))
    assert res.status_code == 200
    assert me(client, user["token"]).status_code == 401
    assert me(client, admin["token"]).status_code == 200
    login(user["user"]["username"], "a-brand-new-password")


def test_deleted_user_is_logged_out(client, admin, make_user):
    user = make_user()
    res = client.delete(f"/api/admin/users/{user['user']['id']}", headers=auth(admin["token"]))
    assert res.status_code == 200
    assert me(client, user["token"]).status_code == 401


def test_role_change_applies_to_existing_logins(client, admin, make_user):
    user = make_user("editor")
    assert client.get("/api/admin/users", headers=auth(user["token"])).status_code == 403
    client.patch(f"/api/admin/users/{user['user']['id']}", json={"role": "admin"}, headers=auth(admin["token"]))
    assert client.get("/api/admin/users", headers=auth(user["token"])).status_code == 200
