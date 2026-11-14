"""An admin, an editor and a share-link guest in one project see each other's changes live.

Tests run in order and build on one another (shared server, three browser contexts).
"""

import pytest

from e2e.e2e_support import ADMIN, PASSWORD, login, open_guest, wait_js

pytestmark = pytest.mark.e2e


@pytest.fixture(scope="module")
def scene(server, new_page, browser):
    editor_id = server.create_user("editor")
    project_id = server.create_project("Spot")
    server.grant_access(project_id, editor_id)
    link_id = server.create_share_link(project_id)

    a = new_page(name="admin")
    b = new_page(name="editor")
    g = new_page(name="guest")
    login(a, server.base_url, ADMIN["username"], ADMIN["password"])
    login(b, server.base_url, "editor")
    a.goto(f"{server.base_url}/?project={project_id}")
    b.goto(f"{server.base_url}/?project={project_id}")
    open_guest(g, server, link_id)
    for page in (a, b, g):
        wait_js(page, "window.Live && Live.isConnected() && AppState.projectId", 10000)
    a.wait_for_timeout(2500)  # the watch list is sent to the server within 2 s
    return {"a": a, "b": b, "g": g, "project": project_id, "link": link_id, "editor_id": editor_id}


def all_pages(scene):
    return [("admin", scene["a"]), ("editor", scene["b"]), ("guest", scene["g"])]


def test_upload_reaches_everyone(scene, server):
    server.upload_png_clip(scene["project"])
    for name, page in all_pages(scene):
        wait_js(page, "Object.keys(AppState.clips).length === 1 && !!AppState.currentClip", 15000)


def test_media_loads_for_members_and_guests_but_not_anonymous(scene, browser, server):
    for name, page in all_pages(scene):
        result = page.evaluate("""async () => {
            const v = Object.values(AppState.clips)[0].versions[0];
            return await new Promise(r => { const i = new Image(); i.onload = () => r('ok');
                i.onerror = () => r('error'); i.src = '/video/' + v.filename; });
        }""")
        assert result == "ok", f"{name}: clip image did not load"
    fname = scene["a"].evaluate("Object.values(AppState.clips)[0].versions[0].filename")
    ctx = browser.new_context()
    try:
        anon = ctx.new_page()
        assert anon.goto(f"{server.base_url}/video/{fname}").status == 401
    finally:
        ctx.close()


def test_comment_reaches_everyone(scene):
    a, b, g = scene["a"], scene["b"], scene["g"]
    a.fill("#commentInput", "Trim two frames here")
    a.evaluate("submitComment()")
    wait_js(a, "AppState.comments.length === 1")
    wait_js(b, "AppState.comments.length === 1")
    wait_js(g, "AppState.comments.length === 1")
    wait_js(b, "document.querySelectorAll('.comment-item').length === 1")
    assert b.evaluate("AppState.comments[0].userName") == "admin"


def test_guest_reload_keeps_the_guest_in(scene):
    g = scene["g"]
    g.reload()
    wait_js(g, "AppState.isShareLinkGuest && AppState.comments.length === 1 && !!AppState.currentClip"
               " && Live.isConnected()", 15000)
    assert g.evaluate("AppState.userName") == "Kim Guest"
    assert g.evaluate("!document.getElementById('shareNameInput')"), "no name prompt after a reload"
    g.wait_for_timeout(2500)


def test_guest_comment_reaches_others_with_guest_name(scene):
    a, g = scene["a"], scene["g"]
    g.fill("#commentInput", "Looks great")
    g.evaluate("submitComment()")
    wait_js(a, "AppState.comments.length === 2")
    assert a.evaluate("AppState.comments[1].userName") == "Kim Guest"
    assert g.evaluate("AppState.comments.length") == 2, "guest sees own comment once"


def test_resolve_reaches_everyone(scene):
    a, b, g = scene["a"], scene["b"], scene["g"]
    first = b.evaluate("AppState.comments[0].id")
    b.evaluate(f"toggleCommentResolved('{first}')")
    wait_js(a, "AppState.comments[0].resolved === true")
    wait_js(g, "AppState.comments[0].resolved === true")


def test_delete_comment_rules_and_propagation(scene):
    a, b, g = scene["a"], scene["b"], scene["g"]
    first = b.evaluate("AppState.comments[0].id")
    assert b.evaluate(
        f"!document.querySelector('.comment-item[data-comment-id=\"{first}\"] [onclick*=deleteComment]')"
    ), "editor must not get a delete button on someone else's comment"
    a.evaluate(f"deleteComment('{first}')")
    wait_js(b, "AppState.comments.length === 1")
    wait_js(g, "AppState.comments.length === 1")


def test_own_comment_still_deletable_after_reload(scene):
    b = scene["b"]
    b.fill("#commentInput", "Mine")
    b.evaluate("submitComment()")
    wait_js(b, "AppState.comments.length === 2")
    b.reload()
    wait_js(b, "AppState.comments.length === 2 && !!AppState.currentClip", 15000)
    assert b.evaluate("AppState.comments.some(c => c.user === AppState.userId)")


def test_clip_status_change_reaches_editor(scene, server):
    statuses = server.api("/api/statuses")["statuses"]
    if not statuses:
        statuses = [server.api("/api/statuses", {"name": "Approved", "color": "#22c55e"})["status"]]
    sid = statuses[0]["id"]
    scene["a"].evaluate(f"updateClipStatus(Object.keys(AppState.clips)[0], '{sid}')")
    wait_js(scene["b"], f"(() => {{ const s = Object.values(AppState.clips)[0].status;"
                        f" return !!s && s.id === '{sid}'; }})()")


def test_project_list_updates_on_access_grant(scene, server):
    other = server.create_project("Second")
    server.grant_access(other, scene["editor_id"], can_review=True, can_tasks=False)
    wait_js(scene["b"], f"AppState.projects.some(p => p.id === '{other}')")


def test_new_task_appears_live(scene, server):
    b = scene["b"]
    server.create_task(scene["project"], "Grade shot")
    b.evaluate(f"TaskManager.init('{scene['project']}')")
    b.wait_for_timeout(2500)
    server.create_task(scene["project"], "Conform")
    wait_js(b, "TaskManager.getTasks().some(t => t.name === 'Conform')")


def test_catch_up_after_offline(scene, server):
    b = scene["b"]
    before = b.evaluate("AppState.comments.length")
    b.context.set_offline(True)
    b.evaluate("Live.stop(); Live.connect()")  # force a reconnect cycle while offline
    server.add_comment(scene["project"], "While you were away")
    b.context.set_offline(False)
    b.evaluate("window.dispatchEvent(new Event('online'))")
    wait_js(b, f"AppState.comments.length === {before + 1}", 20000)


def test_clip_delete_reaches_others(scene):
    scene["a"].evaluate("deleteClip(Object.keys(AppState.clips)[0])")
    wait_js(scene["b"], "Object.keys(AppState.clips).length === 0")
    wait_js(scene["g"], "Object.keys(AppState.clips).length === 0")


def test_access_revoke_sends_editor_home(scene, server):
    server.revoke_access(scene["project"], scene["editor_id"])
    wait_js(scene["b"], "new URLSearchParams(location.search).get('project') === null", 10000)


def test_share_link_removal_kicks_the_guest(scene, server):
    server.delete_share_link(scene["link"])
    wait_js(scene["g"], "location.pathname === '/' && !location.search", 15000)


def test_no_token_in_any_websocket_url(new_page):
    # Collected by the new_page fixture for every page of the module (see conftest); this makes
    # the check explicit and fails here if any was recorded.
    assert not [e for e in new_page.errors if "WebSocket" in e]
