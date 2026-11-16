"""Push notifications: subscriptions per browser, sending on every notification, and the web app files."""

import json
import time

import pytest

from api import push
from database import db_create_notification
from database.push import db_list_push_subscriptions

from conftest import auth

SUB = {"endpoint": "https://push.example/abc", "keys": {"p256dh": "BKey", "auth": "secret"}}


@pytest.fixture
def me(make_user):
    return make_user()


@pytest.fixture
def sent(monkeypatch):
    """Replaces the network call; collects what would have been sent."""
    calls = []

    def fake(subscription_info, data, **kwargs):
        calls.append({"endpoint": subscription_info["endpoint"], "payload": json.loads(data), "claims": kwargs.get("vapid_claims")})

    monkeypatch.setattr(push, "webpush", fake)
    return calls


def wait_until(condition, seconds=5.0):
    end = time.time() + seconds
    while not condition() and time.time() < end:
        time.sleep(0.02)


def subscribe(client, user, sub=SUB):
    res = client.post("/api/push/subscribe", json=sub, headers=auth(user["token"]))
    assert res.status_code == 200, res.text


def test_the_key_is_stable_and_needs_a_login(client, me):
    assert client.get("/api/push/key").status_code == 401
    first = client.get("/api/push/key", headers=auth(me["token"])).json()["publicKey"]
    assert len(first) > 80 and "=" not in first
    push._vapid = None  # as after a restart: the key comes back from the settings
    assert client.get("/api/push/key", headers=auth(me["token"])).json()["publicKey"] == first


def test_subscribe_validates_and_counts_devices(client, me):
    for bad in ({}, {"endpoint": "http://plain.example", "keys": SUB["keys"]}, {"endpoint": SUB["endpoint"]},
                {"endpoint": SUB["endpoint"], "keys": {"p256dh": "x"}}):
        assert client.post("/api/push/subscribe", json=bad, headers=auth(me["token"])).status_code == 400
    assert client.post("/api/push/subscribe", json=SUB).status_code == 401
    subscribe(client, me)
    subscribe(client, me)  # the same browser again is still one device
    assert client.get("/api/push/devices", headers=auth(me["token"])).json() == {"count": 1}
    subscribe(client, me, {**SUB, "endpoint": "https://push.example/phone"})
    assert client.get("/api/push/devices", headers=auth(me["token"])).json() == {"count": 2}


def test_a_notification_is_pushed_to_the_users_browsers_only(client, me, make_user, sent):
    other = make_user()
    subscribe(client, me)
    subscribe(client, other, {**SUB, "endpoint": "https://push.example/other"})
    note = db_create_notification(me["user"]["id"], "mention", "You were mentioned in Brief", message="by ana", link="/me/page/p1")
    wait_until(lambda: sent)  # the message goes out on a worker thread
    assert [c["endpoint"] for c in sent] == [SUB["endpoint"]]
    assert sent[0]["payload"] == {"id": note["id"], "title": "You were mentioned in Brief", "body": "by ana", "link": "/me/page/p1"}
    assert sent[0]["claims"]["sub"].startswith(("mailto:", "https:"))


def test_a_notification_without_a_link_opens_the_project(me):
    assert push.payload_of({"title": "Joined", "projectId": "p9"})["link"] == "/p/p9/review"
    assert push.payload_of({"title": "Hello"})["link"] == "/"


def test_a_shared_browser_notifies_its_current_user(client, me, make_user):
    other = make_user()
    subscribe(client, me)
    subscribe(client, other)  # the next person logs in on the same browser
    assert db_list_push_subscriptions(me["user"]["id"]) == []
    assert len(db_list_push_subscriptions(other["user"]["id"])) == 1
    # only the owner can remove it
    client.post("/api/push/unsubscribe", json={"endpoint": SUB["endpoint"]}, headers=auth(me["token"]))
    assert len(db_list_push_subscriptions(other["user"]["id"])) == 1
    client.post("/api/push/unsubscribe", json={"endpoint": SUB["endpoint"]}, headers=auth(other["token"]))
    assert db_list_push_subscriptions(other["user"]["id"]) == []


def test_an_expired_subscription_is_removed_and_other_failures_are_kept(client, me, monkeypatch):
    subscribe(client, me)
    subscribe(client, me, {**SUB, "endpoint": "https://push.example/flaky"})

    class Gone:
        status_code = 410

    class Busy:
        status_code = 500

    def fail(subscription_info, data, **kwargs):
        raise push.WebPushException("no", response=Gone() if subscription_info["endpoint"] == SUB["endpoint"] else Busy())

    monkeypatch.setattr(push, "webpush", fail)
    assert client.post("/api/push/test", headers=auth(me["token"])).json() == {"sent": 0}
    assert [s["endpoint"] for s in db_list_push_subscriptions(me["user"]["id"])] == ["https://push.example/flaky"]


def test_a_failing_push_never_breaks_the_notification(me, monkeypatch, client):
    subscribe(client, me)

    def boom(*args, **kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(push, "webpush", boom)
    assert db_create_notification(me["user"]["id"], "mention", "Still created")["title"] == "Still created"
    push._executor.submit(lambda: None).result()


def test_the_web_app_files_are_served(client):
    manifest = client.get("/manifest.webmanifest")
    assert manifest.status_code == 200 and manifest.json()["display"] == "standalone"
    for icon in manifest.json()["icons"]:
        assert client.get(icon["src"]).status_code == 200
    worker = client.get("/sw.js")
    assert worker.status_code == 200 and "javascript" in worker.headers["content-type"]
    assert worker.headers["service-worker-allowed"] == "/" and "showNotification" in worker.text
    page = client.get("/").text
    assert 'rel="manifest"' in page and "features/push.js" in page
