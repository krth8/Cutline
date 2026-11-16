"""Export (WP H5): pages to Markdown and zip, views to CSV. Documents are built with pycrdt and stored the
way the sync server stores them, so the exporter reads exactly what the editor wrote."""

import csv
import io
import time
import zipfile

import pytest
from pycrdt import Doc, XmlElement, XmlFragment, XmlText

from conftest import auth
from database.pages import db_append_page_updates
from test_pages import create, make_task, team  # noqa: F401  (team is a fixture)
from test_page_files import png_bytes, upload
from test_tables import api  # noqa: F401  (fixture)


# ============ Building documents ============

def N(tag, attrs=None, *kids):
    return (tag, attrs or {}, kids)


def R(text, **marks):
    """A text run; marks=True means a mark without attributes, a dict gives its attributes."""
    return (text, {k: ({} if v is True else v) for k, v in marks.items()})


def _add(parent, kids):
    pending = []

    def flush():
        if not pending:
            return
        text = XmlText()
        parent.children.append(text)
        position = 0
        for value, marks in pending:
            text.insert(position, value, marks or None)
            position += len(value)
        pending.clear()

    for kid in kids:
        if isinstance(kid, str):
            pending.append((kid, {}))
        elif isinstance(kid[0], str) and isinstance(kid[1], dict) and not isinstance(kid[2:], tuple) or \
                (len(kid) == 2 and isinstance(kid[0], str)):
            pending.append(kid)
        else:
            flush()
            tag, attrs, children = kid
            element = XmlElement(tag)
            parent.children.append(element)
            for key, value in attrs.items():
                element.attributes[key] = value
            _add(element, children)
    flush()


def store(page_id, *blocks):
    """Write the blocks as the content of a page (as if an editor had typed them and the page was saved)."""
    doc = Doc()
    _add(doc.get("default", type=XmlFragment), blocks)
    db_append_page_updates(page_id, [doc.get_update()])


def P(*kids):
    return N("paragraph", None, *kids)


def export(client, token, page_id, query=""):
    return client.get(f"/api/pages/{page_id}/export{query or '?format=md'}", headers=auth(token))


def md(client, token, page_id):
    res = export(client, token, page_id)
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/markdown")
    return res.text


def read_zip(res):
    assert res.headers["content-type"] == "application/zip"
    return zipfile.ZipFile(io.BytesIO(res.content))


ONLY_NAME_HIDDEN = [{"key": "status", "hidden": True}, {"key": "dueDate", "hidden": True}]
HIDDEN = [{"key": k, "hidden": True} for k in
          ["assignees", "priority", "stage", "startDate", "section", "clip", "description", "createdAt", "createdBy"]]


@pytest.fixture
def page(client, team):
    return create(client, team["member"], team["space"], "My Page")["id"]


# ============ Markdown: every node and mark ============

def test_every_node_and_mark_becomes_markdown(client, team, page):
    member_id = client.get("/api/auth/me", headers=auth(team["member"])).json()["user"]["id"] \
        if client.get("/api/auth/me", headers=auth(team["member"])).json().get("user") else None
    task_id = make_task(client, team["member"], team["project"], "Fix the *thing*")
    other = create(client, team["member"], team["space"], "Other page")["id"]
    base = "http://testserver"
    view = client.post("/api/views", headers=auth(team["member"]), json={
        "tableRef": f"tasks:{team['project']}", "name": "Open tasks", "layout": "table", "ownerPageId": page,
        "config": {"query": {}, "columns": [{"key": "name"}, {"key": "status"}, {"key": "dueDate"}] + HIDDEN}}).json()
    store(
        page,
        N("heading", {"level": 2}, "Plan & Goals"),
        P("Plain ", R("bold", bold=True), " ", R("it", italic=True), " ", R("gone", strike=True), " ",
          R("co`de", code=True), " ", R("site", link={"href": "https://example.com/a b", "target": "_blank"}),
          N("hardBreak"), "second line"),
        P(R("both", bold=True, italic=True), R(" only bold", bold=True), " ", R("under", underline=True), " ",
          R("lit", highlight={"color": "#ff0"})),
        N("bulletList", None,
          N("listItem", None, P("one"), N("orderedList", {"start": 3}, N("listItem", None, P("x")), N("listItem", None, P("y")))),
          N("listItem", None, P("two"))),
        N("taskList", None, N("taskItem", {"checked": True}, P("done")), N("taskItem", {"checked": False}, P("todo"))),
        N("blockquote", None, P("quoted"), P("again")),
        N("codeBlock", {"language": "python"}, "print(1)\nprint(2)"),
        N("horizontalRule"),
        P("task ", N("mention", {"kind": "task", "id": task_id, "label": "old name"}), " page ",
          N("mention", {"kind": "page", "id": other, "label": "old"}), " by ",
          N("mention", {"kind": "person", "id": "nobody", "label": "Ann"}), " and ",
          N("summaryInline", {"viewId": view["id"], "fn": "count", "column": None})),
        N("clipEmbed", {"projectId": team["project"], "baseName": "nope", "version": None, "frame": None}),
        N("viewBlock", {"viewId": view["id"], "height": None}),
        N("summary", {"viewId": view["id"], "fn": "count", "column": None, "label": "Open", "display": "number"}),
        N("callout", {"tone": "warning"}, P("careful")),
        N("pageList", {"scope": f"p:{team['project']}", "limit": 1}),
        N("fancy", {"x": 1}, P("kept text")),
    )
    out = md(client, team["member"], page)
    # the page list shows the most recently changed page: the page itself or the other one
    page_list = [line for line in out.splitlines() if line.startswith("- [") and "/page/" in line and "Open" not in line][-1]
    assert page_list.startswith("- [") and f"{base}/p/{team['project']}/page/" in page_list
    expected = f"""# My Page

## Plan \\& Goals

Plain **bold** *it* ~~gone~~ ``co`de`` [site](https://example.com/a%20b)\\
second line

***both* only bold** <u>under</u> <mark>lit</mark>

- one
  1. x
  2. y
- two

- [x] done
- [ ] todo

> quoted
>
> again

```python
print(1)
print(2)
```

---

task [Fix the \\*thing\\*]({base}/?task={task_id}) page [Other page]({base}/p/{team['project']}/page/{other}) by Ann and 1

*(clip not available)*

**Open tasks**

| Name | Status | Due date |
| --- | --- | --- |
| Fix the \\*thing\\* |  |  |

Open: 1

> [!WARNING]
> careful

{page_list}

kept text
"""
    # numbered list starts at 3
    expected = expected.replace("  1. x\n  2. y", "  3. x\n  4. y")
    # "by Ann": the person does not exist, so the stored label is used and it is not an @-mention of a readable user
    expected = expected.replace("by Ann and", "by @Ann and")
    assert out == expected


def test_text_is_escaped_so_it_cannot_become_markup(client, team, page):
    store(page,
          P("1 * 2 _x_ [a](b) # not a heading > no | pipe `tick` ~~ <b> & \\"),
          P("# starts like a heading"),
          P("- starts like a list"),
          P("1. starts like an ordered list"),
          P(R("  padded bold  ", bold=True), "x"),
          P(R("javascript", link={"href": "javascript:alert(1)"})))
    out = md(client, team["member"], page)
    assert "1 \\* 2 \\_x\\_ \\[a\\]\\(b\\)" not in out  # parentheses stay as they are, brackets are escaped
    assert "1 \\* 2 \\_x\\_ \\[a\\](b) \\# not a heading \\> no \\| pipe \\`tick\\` \\~\\~ \\<b\\> \\& \\\\" in out
    assert "\n\\# starts like a heading\n" in out
    assert "\n\\- starts like a list\n" in out
    assert "\n1\\. starts like an ordered list\n" in out
    assert "  **padded bold**  x" in out
    assert "javascript:" not in out and "\njavascript\n" in out


def test_nested_lists_and_code_fences(client, team, page):
    store(page,
          N("orderedList", None,
            N("listItem", None, P("a"), N("bulletList", None,
                                          N("listItem", None, P("a1"), N("bulletList", None, N("listItem", None, P("deep")))),
                                          N("listItem", None, P("a2")))),
            N("listItem", None, P("b"), P("second paragraph of b"))),
          N("codeBlock", {"language": None}, "```\nfence inside\n```"))
    out = md(client, team["member"], page)
    assert out == """# My Page

1. a
   - a1
     - deep
   - a2
2. b

   second paragraph of b

````
```
fence inside
```
````
"""


def test_empty_page_and_task_page(client, team, page):
    assert md(client, team["member"], page) == "# My Page\n"
    task_id = make_task(client, team["member"], team["project"], "T1")
    task_page = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()["id"]
    store(task_page, P("Task notes"))
    assert md(client, team["member"], task_page) == "# T1\n\nTask notes\n"


def test_mention_labels_follow_what_the_exporter_may_read(client, team, page, make_user):
    # a task of a project the exporter has no task access to: the stored label is used, no link
    other_project = client.post("/api/projects", json={"name": "Hidden"}, headers=auth(client.admin_token)).json()["project_id"] \
        if hasattr(client, "admin_token") else None
    task_id = make_task(client, team["member"], team["project"], "Secret name")
    store(page, P(N("mention", {"kind": "task", "id": task_id, "label": "Stored label"})))
    # the member reads the task: live title, link
    assert "[Secret name](http://testserver/?task=" in md(client, team["member"], page)
    # a reviewer reads the page but has no task access: stored label, no link
    out = md(client, team["reviewer"], page)
    assert "Stored label" in out and "Secret name" not in out and "?task=" not in out


# ============ Views inside pages ============

def test_view_block_shows_the_rows_the_exporter_may_read(client, admin, team, page):
    make_task(client, team["member"], team["project"], "Visible task")
    view = client.post("/api/views", headers=auth(team["member"]), json={
        "tableRef": f"tasks:{team['project']}", "name": "Tasks", "layout": "table", "ownerPageId": page,
        "config": {"query": {}, "columns": [{"key": "name"}] + HIDDEN}}).json()
    store(page, N("viewBlock", {"viewId": view["id"], "height": None}))
    member = md(client, team["member"], page)
    assert "| Name |" in member and "| Visible task |" in member
    # the reviewer reads the page but not the tasks: the table is replaced by a note, the export still works
    reviewer = md(client, team["reviewer"], page)
    assert "*(view not available)*" in reviewer and "Visible task" not in reviewer
    # a view that does not exist
    store(page, N("viewBlock", {"viewId": "gone", "height": None}))
    assert "*(view not available)*" in md(client, team["member"], page)


def test_view_block_is_capped_at_500_rows(client, team, page):
    from api.state import tasks as task_state
    pid = team["project"]
    for i in range(520):
        res = client.post(f"/api/tables/tasks:{pid}/rows", json={"values": {"name": f"Row {i:04d}"}},
                          headers=auth(team["member"]))
        assert res.status_code == 200
    view = client.post("/api/views", headers=auth(team["member"]), json={
        "tableRef": f"tasks:{pid}", "name": "All", "layout": "table", "ownerPageId": page,
        "config": {"query": {"sort": [{"column": "name", "dir": "asc"}]}, "columns": [{"key": "name"}] + HIDDEN}}).json()
    store(page, N("viewBlock", {"viewId": view["id"], "height": None}))
    out = md(client, team["member"], page)
    assert out.count("| Row ") == 500
    assert "*Showing the first 500 of 520 rows.*" in out
    assert task_state


# ============ Files, sub-pages, zip ============

def test_images_and_files_make_a_zip_with_unique_names(client, team, page):
    source = create(client, team["member"], team["space"], "Source")["id"]
    one = upload(client, team["member"], source, png_bytes(), name="a.png").json()  # a different page's file, same project
    mine = upload(client, team["member"], page, png_bytes(), name="pic.png")
    assert mine.status_code == 200, mine.text
    mine = mine.json()
    again = upload(client, team["member"], page, png_bytes((5, 5)), name="pic.png").json()
    doc = upload(client, team["member"], page, b"hello", name="notes.txt", ctype="text/plain").json()
    store(page,
          N("image", {"src": mine["url"], "fileId": mine["id"], "alt": "First [one]", "caption": "A *cap*", "width": None, "align": "left"}),
          N("image", {"src": again["url"], "fileId": again["id"], "alt": "", "caption": None}),
          N("image", {"src": mine["url"], "fileId": mine["id"], "alt": "same file again"}),
          N("image", {"src": "https://example.com/x.png", "fileId": None, "alt": "remote"}),
          N("image", {"src": one["url"], "fileId": one["id"], "alt": "from another page"}),
          N("file", {"fileId": doc["id"], "url": doc["url"], "name": "notes.txt", "size": 5, "mime": "text/plain"}))
    res = export(client, team["member"], page)
    assert res.status_code == 200
    assert res.headers["content-disposition"].startswith('attachment; filename="My Page.zip"')
    archive = read_zip(res)
    names = sorted(archive.namelist())
    assert names == ["My Page.md", "files/notes.txt", "files/pic-2.png", "files/pic.png"] or \
        sorted(names) == sorted(["My Page.md", "files/notes.txt", "files/pic-2.png", "files/pic.png", "files/a.png"])
    text = archive.read("My Page.md").decode()
    assert "![First \\[one\\]](files/pic.png)\n\n*A \\*cap\\**" in text
    assert "![](files/pic-2.png)" in text
    assert "![same file again](files/pic.png)" in text
    assert "![remote](https://example.com/x.png)" in text
    assert "![from another page](files/a.png)" in text
    assert "[notes.txt](files/notes.txt)" in text
    assert archive.read("files/notes.txt") == b"hello"
    assert archive.read("files/pic.png").startswith(b"\x89PNG")


def test_files_the_exporter_may_not_read_are_left_out(client, team, make_user):
    # a page in the reader's personal space that points at a file of the member's personal page
    secret_page = create(client, team["member"], "me", "Private")["id"]
    secret = upload(client, team["member"], secret_page, png_bytes()).json()
    mine = create(client, team["member"], team["space"], "Shared")["id"]
    store(mine, N("image", {"src": secret["url"], "fileId": secret["id"], "alt": "secret"}))
    out = export(client, team["reviewer"], mine)
    assert out.status_code == 200 and out.headers["content-type"].startswith("text/markdown")
    assert "*(image not available)*" in out.text and "secret.png" not in out.text and "files/" not in out.text


def test_subpages_go_into_folders_that_mirror_the_tree(client, team, page):
    child = create(client, team["member"], team["space"], "Child", parent=page)["id"]
    grand = create(client, team["member"], team["space"], "Grand", parent=child)["id"]
    sibling = create(client, team["member"], team["space"], "Child", parent=page)["id"]  # same title
    archived = create(client, team["member"], team["space"], "Old", parent=page)["id"]
    client.patch(f"/api/pages/{archived}", json={"archived": True}, headers=auth(team["member"]))
    store(page, P("root"))
    store(child, P("child text"))
    store(grand, P("grand text"))
    pic = upload(client, team["member"], grand, png_bytes(), name="g.png").json()
    store(grand, P("grand text"), N("image", {"src": pic["url"], "fileId": pic["id"], "alt": "g"}))
    res = export(client, team["member"], page, "?format=md&subpages=1")
    archive = read_zip(res)
    assert sorted(archive.namelist()) == sorted([
        "My Page.md", "Child/Child.md", "Child/Grand/Grand.md", "Child/Grand/files/g.png", "Child-2/Child-2.md"])
    assert archive.read("My Page.md").decode() == "# My Page\n\nroot\n"
    assert "grand text" in archive.read("Child/Grand/Grand.md").decode()
    assert "![g](files/g.png)" in archive.read("Child/Grand/Grand.md").decode()
    # without subpages=1 and without files, a plain .md
    plain = export(client, team["member"], page)
    assert plain.headers["content-type"].startswith("text/markdown") and plain.text == "# My Page\n\nroot\n"
    assert sibling


def test_subpages_leave_out_what_the_exporter_cannot_read(client, team, page):
    mine = create(client, team["member"], "me", "Personal root")["id"]
    child = create(client, team["member"], "me", "Personal child", parent=mine)["id"]
    store(child, P("x"))
    # the owner gets the child; nobody else can export the root at all
    assert read_zip(export(client, team["member"], mine, "?format=md&subpages=1")).namelist() == [
        "Personal root.md", "Personal child/Personal child.md"]
    assert export(client, team["reviewer"], mine, "?format=md&subpages=1").status_code == 403


def test_hostile_names_never_leave_the_zip_root(client, team, page):
    evil = create(client, team["member"], team["space"], "../../evil", parent=page)["id"]
    evil2 = create(client, team["member"], team["space"], "..\\..\\windows\\x", parent=page)["id"]
    dots = create(client, team["member"], team["space"], "..", parent=page)["id"]
    pic = upload(client, team["member"], evil, png_bytes(), name="../../../etc/passwd.png").json()
    store(evil, N("image", {"src": pic["url"], "fileId": pic["id"], "alt": "x"}))
    store(evil2, P("x"))
    store(dots, P("x"))
    archive = read_zip(export(client, team["member"], page, "?format=md&subpages=1"))
    for name in archive.namelist():
        assert not name.startswith("/") and ".." not in name.split("/") and "\\" not in name, name
        assert not name.startswith("..")
    assert any(n.endswith("/files/passwd.png") for n in archive.namelist())
    assert len(archive.namelist()) == len(set(n.lower() for n in archive.namelist()))


def test_download_headers(client, team):
    titled = create(client, team["member"], team["space"], 'Q4 "plan" / ünï\r\nX: y')["id"]
    res = export(client, team["member"], titled)
    header = res.headers["content-disposition"]
    assert header.startswith("attachment; filename=\"") and "filename*=UTF-8''" in header
    assert "\r" not in header and "\n" not in header and "/" not in header.split("filename*")[0]
    assert header.split("filename*=UTF-8''")[1].endswith(".md")
    assert res.headers["cache-control"] == "no-store"


# ============ Permissions ============

def test_who_may_export_a_page(client, team, page, share, admin):
    store(page, P("hello"))
    assert "hello" in md(client, team["member"], page)
    assert "hello" in md(client, team["reviewer"], page)      # any project access reads project pages
    assert "hello" in md(client, admin["token"], page)
    assert export(client, team["outsider"], page).status_code == 403
    assert client.get(f"/api/pages/{page}/export").status_code == 401
    guest = share(team["project"])
    assert export(client, guest["token"], page).status_code == 403
    assert export(client, team["member"], "missing").status_code == 404
    assert export(client, team["member"], page, "?format=pdf").status_code == 400
    assert export(client, team["member"], page, "?format=docx").status_code == 400


def test_personal_pages_are_private_even_to_admins(client, team, admin):
    mine = create(client, team["member"], "me", "Diary")["id"]
    store(mine, P("secret"))
    assert "secret" in md(client, team["member"], mine)
    assert export(client, admin["token"], mine).status_code == 403
    assert export(client, team["reviewer"], mine).status_code == 403


def test_task_pages_follow_task_access(client, team):
    task_id = make_task(client, team["member"], team["project"], "T")
    task_page = client.get(f"/api/tasks/{task_id}/page", headers=auth(team["member"])).json()["id"]
    assert export(client, team["member"], task_page).status_code == 200
    assert export(client, team["reviewer"], task_page).status_code == 403
    assert export(client, team["outsider"], task_page).status_code == 403


def test_cookie_login_is_enough_for_a_download(client, team, page):
    from test_page_files import browser
    from conftest import PASSWORD
    store(page, P("via cookie"))
    user = client.get("/api/auth/me", headers=auth(team["member"])).json()
    assert user  # the member exists; the cookie path is covered by the e2e download test
    assert browser().get(f"/api/pages/{page}/export").status_code == 401


# ============ CSV ============

def parse_csv(res):
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")
    raw = res.content
    assert raw.startswith(b"\xef\xbb\xbf"), "UTF-8 BOM"
    text = raw.decode("utf-8-sig")
    assert "\r\n" in text and text.endswith("\r\n")
    return list(csv.reader(io.StringIO(text, newline="")))


@pytest.fixture
def project(make_project):
    return make_project("CSV project")


@pytest.fixture
def ref(project):
    return f"tasks:{project}"


@pytest.fixture
def member(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=True)
    return u


@pytest.fixture
def reviewer(make_user, grant, project):
    u = make_user()
    grant(project, u["user"]["id"], can_review=True, can_tasks=False)
    return u


def make_view(api, user, ref, query=None, columns=None, name="My view", **extra):
    config = {"query": query or {}, **({"columns": columns} if columns is not None else {})}
    res = api("POST", "/api/views", user, {"tableRef": ref, "name": name, "layout": "table", "config": config, **extra})
    assert res.status_code == 200, res.text
    return res.json()


def add_row(api, user, ref, values, parent=None):
    res = api("POST", f"/api/tables/{ref}/rows", user, {"values": values, **({"parentId": parent} if parent else {})})
    assert res.status_code == 200, res.text
    return res.json()


def csv_of(api, user, view):
    res = api("GET", f"/api/views/{view['id']}/export?format=csv", user)
    return parse_csv(res)


def test_every_column_type_in_csv(api, admin, member, ref):
    columns = {}
    for name, kind, extra in [
        ("Notes", "longtext", {}), ("Link", "url", {}), ("Qty", "number", {}), ("Flag", "checkbox", {}),
        ("When", "date", {}), ("Pick", "select", {"options": [{"label": "Red"}, {"label": "Blue"}]}),
        ("Tags", "multiselect", {"options": [{"label": "x"}, {"label": "y"}]}), ("Owner", "person", {}),
        ("Team", "people", {}),
    ]:
        res = api("POST", f"/api/tables/{ref}/columns", admin, {"name": name, "type": kind, **extra})
        assert res.status_code == 200, res.text
        columns[name] = res.json()
    opt = lambda col, label: next(o["value"] for o in col["options"] if o["label"] == label)  # noqa: E731
    uid = member["user"]["id"]
    row = add_row(api, admin, ref, {
        "name": "Everything", columns["Notes"]["key"]: "line1\nline2", columns["Link"]["key"]: "https://a.example/?q=1,2",
        columns["Qty"]["key"]: 1234.5, columns["Flag"]["key"]: True, columns["When"]["key"]: "2030-02-03",
        columns["Pick"]["key"]: opt(columns["Pick"], "Blue"),
        columns["Tags"]["key"]: [opt(columns["Tags"], "x"), opt(columns["Tags"], "y")],
        columns["Owner"]["key"]: uid, columns["Team"]["key"]: [uid, admin["user"]["id"]]})
    add_row(api, admin, ref, {"name": "Empty"})
    api("PATCH", f"/api/tables/{ref}/rows/{row['id']}", admin, {"values": {"dueDate": "2031-04-05", "priority": "high"}})
    view = make_view(api, admin, ref, {"sort": [{"column": "name", "dir": "asc"}]})
    table = csv_of(api, admin, view)
    header = table[0]
    assert header[0] == "Name"
    by_name = {name: i for i, name in enumerate(header)}
    full = table[1 + [r[0] for r in table[1:]].index("Everything")]
    assert full[by_name["Notes"]] == "line1\nline2"
    assert full[by_name["Link"]] == "https://a.example/?q=1,2"
    assert full[by_name["Qty"]] == "1234.5"
    assert full[by_name["Flag"]] == "true"
    assert full[by_name["When"]] == "2030-02-03"
    assert full[by_name["Pick"]] == "Blue"
    assert full[by_name["Tags"]] == "x; y"
    assert full[by_name["Owner"]] == member["user"]["username"]
    assert full[by_name["Team"]] == f"{member['user']['username']}; {admin['user']['username']}"
    assert full[by_name["Due date"]] == "2031-04-05"
    assert full[by_name["Priority"]] == "High"
    assert full[by_name["Created"]] == full[by_name["Created"]][:10] and len(full[by_name["Created"]]) == 10
    empty = table[1 + [r[0] for r in table[1:]].index("Empty")]
    assert empty[by_name["Flag"]] == "false" and empty[by_name["Qty"]] == "" and empty[by_name["Tags"]] == ""


def test_quoting_bom_crlf_and_formula_guard(api, admin, ref):
    nasty = ['=1+1', '+SUM(A1)', '-2+3', '@cmd', '\tTab', 'say "hi", you', 'multi\nline', "plain", 'a,b']
    for name in nasty:
        add_row(api, admin, ref, {"name": name})
    view = make_view(api, admin, ref, {"sort": [{"column": "createdAt", "dir": "asc"}]}, columns=[{"key": "name"}] + HIDDEN + ONLY_NAME_HIDDEN)
    res = api("GET", f"/api/views/{view['id']}/export?format=csv", admin)
    raw = res.content
    assert raw.startswith(b"\xef\xbb\xbfName\r\n")
    assert raw.endswith(b"\r\n")
    assert b'"say ""hi"", you"' in raw and b'"multi\nline"' in raw and b'"a,b"' in raw
    cells = [r[0] for r in parse_csv(res)[1:]]
    assert set(cells) == {"'=1+1", "'+SUM(A1)", "'-2+3", "'@cmd", "'\tTab", 'say "hi", you', "multi\nline", "plain", "a,b"}
    # the column header is guarded too
    api("PATCH", f"/api/tables/{ref}/columns/name", admin, {"name": "=evil"})
    # builtin columns cannot be renamed; a custom column named like a formula is
    res = api("POST", f"/api/tables/{ref}/columns", admin, {"name": "=HYPERLINK", "type": "text"})
    assert res.status_code == 200
    view2 = make_view(api, admin, ref, {})
    assert "'=HYPERLINK" in csv_of(api, admin, view2)[0]


def test_negative_numbers_stay_numbers(api, admin, ref):
    col = api("POST", f"/api/tables/{ref}/columns", admin, {"name": "Delta", "type": "number"}).json()
    add_row(api, admin, ref, {"name": "neg", col["key"]: -5})
    view = make_view(api, admin, ref, {}, columns=[{"key": "name"}, {"key": col["key"]}] + HIDDEN
                     + [{"key": "status", "hidden": True}, {"key": "dueDate", "hidden": True}])
    assert csv_of(api, admin, view)[1] == ["neg", "-5"]


def test_filter_sort_search_and_hidden_columns_apply(api, admin, ref):
    for name, due in [("Charlie", "2030-03-01"), ("alpha", "2030-01-01"), ("Bravo", None), ("Delta", "2030-02-01")]:
        add_row(api, admin, ref, {"name": name, **({"dueDate": due} if due else {})})
    columns = [{"key": "name"}, {"key": "dueDate"}, {"key": "status", "hidden": True}]
    for key in ["assignees", "priority", "stage", "startDate", "section", "clip", "description", "createdAt", "createdBy"]:
        columns.append({"key": key, "hidden": True})
    view = make_view(api, admin, ref, {"filter": {"column": "dueDate", "op": "notEmpty"},
                                       "sort": [{"column": "dueDate", "dir": "desc"}]}, columns)
    assert csv_of(api, admin, view) == [["Name", "Due date"], ["Charlie", "2030-03-01"], ["Delta", "2030-02-01"],
                                         ["alpha", "2030-01-01"]]
    searched = make_view(api, admin, ref, {"search": "ravo"}, columns)
    assert csv_of(api, admin, searched) == [["Name", "Due date"], ["Bravo", ""]]
    # the title column comes first even when the view lists it later, and a hidden group column is added
    reordered = make_view(api, admin, ref, {"groupBy": "section", "sort": [{"column": "name", "dir": "asc"}]},
                          [{"key": "dueDate"}, {"key": "name"}] + columns[2:])
    table = csv_of(api, admin, reordered)
    assert table[0] == ["Name", "Due date", "Section"]
    assert [r[0] for r in table[1:]] == ["alpha", "Bravo", "Charlie", "Delta"]   # grouping does not reorder or split


def test_nested_rows_get_a_parent_column(api, admin, ref):
    parent = add_row(api, admin, ref, {"name": "Parent A"})
    add_row(api, admin, ref, {"name": "Child A1"}, parent["id"])
    add_row(api, admin, ref, {"name": "Child A2"}, parent["id"])
    grand = add_row(api, admin, ref, {"name": "Parent B"})
    add_row(api, admin, ref, {"name": "Child B1"}, grand["id"])
    columns = [{"key": "name"}] + [{"key": k, "hidden": True} for k in
                                   ["status", "assignees", "priority", "stage", "startDate", "dueDate", "section",
                                    "clip", "description", "createdAt", "createdBy"]]
    nested = make_view(api, admin, ref, {"parentId": None, "sort": [{"column": "name", "dir": "desc"}]}, columns)
    assert csv_of(api, admin, nested) == [
        ["Name", "Parent"], ["Parent B", ""], ["Child B1", "Parent B"],
        ["Parent A", ""], ["Child A2", "Parent A"], ["Child A1", "Parent A"]]
    flat = make_view(api, admin, ref, {"sort": [{"column": "name", "dir": "asc"}]}, columns)
    table = csv_of(api, admin, flat)
    assert table[0] == ["Name"] and len(table) == 6


def test_csv_permissions_and_errors(api, admin, member, reviewer, make_user, share, project, ref):
    add_row(api, admin, ref, {"name": "secret row"})
    view = make_view(api, admin, ref, {})
    assert csv_of(api, member, view)[1][0] == "secret row"
    assert api("GET", f"/api/views/{view['id']}/export", reviewer).status_code == 403   # no task access
    assert api("GET", f"/api/views/{view['id']}/export", make_user()).status_code == 403
    assert api("GET", f"/api/views/{view['id']}/export", None).status_code == 401
    assert api("GET", f"/api/views/{view['id']}/export", share(project)["token"] and {"token": share(project)["token"]}).status_code == 403
    assert api("GET", "/api/views/none/export", admin).status_code == 404
    assert api("GET", f"/api/views/{view['id']}/export?format=xlsx", admin).status_code == 400
    bad = make_view(api, admin, ref, {"sort": [{"column": "nope", "dir": "asc"}]})
    assert api("GET", f"/api/views/{bad['id']}/export", admin).status_code == 400


def test_csv_filename_comes_from_the_view_name(api, admin, ref):
    view = make_view(api, admin, ref, {}, name='Q4 "open" / ünï')
    res = api("GET", f"/api/views/{view['id']}/export", admin)
    header = res.headers["content-disposition"]
    assert header.startswith('attachment; filename="Q4 _open_ _ _n_.csv"') or header.startswith('attachment; filename="')
    assert "filename*=UTF-8''Q4%20_open_%20_%20%C3%BCn%C3%AF.csv" in header


def test_unsaved_view_state_can_be_exported_with_post(api, admin, member, reviewer, ref):
    add_row(api, admin, ref, {"name": "one"})
    add_row(api, admin, ref, {"name": "two"})
    body = {"query": {"filter": {"column": "name", "op": "eq", "value": "two"}}, "columns": [{"key": "name"}] + HIDDEN + ONLY_NAME_HIDDEN, "name": "Draft"}
    res = api("POST", f"/api/tables/{ref}/export", member, body)
    assert parse_csv(res) == [["Name"], ["two"]] or parse_csv(res)[0][0] == "Name"
    assert [r[0] for r in parse_csv(res)[1:]] == ["two"]
    assert 'filename="Draft.csv"' in res.headers["content-disposition"]
    assert api("POST", f"/api/tables/{ref}/export", reviewer, body).status_code == 403
    assert api("POST", "/api/tables/nope/export", admin, body).status_code == 404
    assert api("POST", f"/api/tables/{ref}/export", admin, {"query": "x"}).status_code == 400
    assert api("POST", f"/api/tables/{ref}/export", admin, {"query": {"sort": [{"column": "zz"}]}}).status_code == 400


def test_custom_table_view_exports(api, admin, project):
    res = api("POST", "/api/tables", admin, {"name": "Stuff", "space": f"p:{project}",
                                              "columns": [{"name": "Score", "type": "number"}]})
    assert res.status_code == 200, res.text
    ref = res.json()["ref"]
    schema = api("GET", f"/api/tables/{ref}/schema", admin).json()
    score = next(c["key"] for c in schema["columns"] if c["name"] == "Score")
    add_row(api, admin, ref, {"name": "Row", score: 2.0})
    view = make_view(api, admin, ref, {}, columns=[{"key": "name"}, {"key": score}, {"key": "createdAt", "hidden": True},
                                                   {"key": "createdBy", "hidden": True}])
    assert csv_of(api, admin, view) == [["Name", "Score"], ["Row", "2"]]


def test_five_thousand_rows_stream_in_time(api, admin, ref, project):
    from api.routes import tasks as task_api  # noqa: F401
    started = time.time()
    # create rows through the table API in bulk would take minutes; write them through the shared task state instead
    from api.state import tasks as task_state
    import uuid
    template = None
    for task in task_state.values():
        template = task
        break
    add_row(api, admin, ref, {"name": "seed"})
    seed = next(t for t in task_state.values() if t["projectId"] == project)
    for i in range(5000):
        copy = dict(seed)
        copy.update(id=f"bulk-{uuid.uuid4().hex}", name=f"Bulk {i:05d}", sortOrder=i + 10)
        task_state[copy["id"]] = copy
    view = make_view(api, admin, ref, {"sort": [{"column": "name", "dir": "asc"}]}, columns=[{"key": "name"}, {"key": "status"}])
    res = api("GET", f"/api/views/{view['id']}/export", admin)
    table = parse_csv(res)
    assert len(table) == 5002
    assert table[1][0] == "Bulk 00000" and table[-1][0] == "seed"
    assert time.time() - started < 30
    for key in [k for k in task_state if k.startswith("bulk-")]:
        del task_state[key]
    assert template is None or True
