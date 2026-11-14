# Browser tests

Playwright (Python) tests that drive a real Cutline server in headless Chromium. They are
excluded from the normal run (`pytest.ini` has `addopts = -m "not e2e"`).

## Run

```
pip install -r requirements.txt -r requirements-dev.txt
playwright install chromium            # once (CI: playwright install --with-deps chromium)

python -m pytest -m e2e                # everything, about 2.5 minutes
python -m pytest -m "e2e and not slow" # skip the idle-timeout module (~15 s)
python -m pytest -m e2e tests/e2e/test_collaboration.py -k comment
```

Each test module starts its own server (`python server.py`, cwd = repo root) on a free port with a
throwaway database and folders, and removes them at the end. Nothing here touches your real data
and no fixed port is used, so runs can happen next to a running dev server.

## Write a test

1. Create `tests/e2e/test_<topic>.py` and mark it
   `pytestmark = pytest.mark.e2e`.
2. Use the fixtures from `conftest.py`: `server` (one per module, admin already set up),
   `server_factory(**env)` for a server with other environment variables (for example
   `IDLE_TIMEOUT_MINUTES=1`), `new_page(context=None, name="a")` for pages.
3. Import helpers from `e2e.e2e_support` (`from e2e.e2e_support import ...`; never `import conftest`, that is `tests/conftest.py`):
   `login(page, base_url, username)`, `open_guest(page, server, link_id)`, `wait_js(page, expr)`,
   `login_visible`, `wait_logged_in/out`. The `server` object has `api(...)`, `create_user`,
   `create_project`, `grant_access`, `revoke_access`, `create_share_link`, `create_task`,
   `create_document`, `upload_png_clip`, `add_comment`.
4. Set up state through the API (fast), check the result in the browser. Wait with
   `wait_js(page, "AppState.comments.length === 2")`, never with fixed sleeps, except where the
   app itself batches (the live watch list is sent within 2 s).
5. Tests in a module may build on each other (shared server and pages); they run in file order.
6. Uncaught page errors, and a token in any WebSocket URL, fail the test during which they happen.

## Debug

- `E2E_HEADED=1 python -m pytest -m e2e tests/e2e/test_docs_editing.py -x` shows the browser;
  add `E2E_SLOWMO=300` (ms per action) to follow along.
- When a test fails, the tail of the server log is printed under "server log tail".
- `page.pause()` inside a test (headed) opens the Playwright inspector.
