"""A local Cutline for development: its own database with demo data, the web bundle rebuilt on every change,
and the server restarted when Python code changes.

    python dev_server.py            start (seeds demo data the first time)
    python dev_server.py --reset    throw the dev data away and seed it again
    python dev_server.py --port 8095 --no-watch

Everything lives in .devdata/ (ignored by git); the normal database (start.bat) is never touched.
Log in as  admin / dev-password  (also: anna, jonas with password dev-password).
After a frontend change, reload the browser tab; after a Python change the server restarts by itself.
"""

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parent
DATA = REPO / ".devdata"
ADMIN = {"username": "admin", "password": "dev-password"}
PASSWORD = "dev-password"
WATCHED = ("server.py", "api", "database", "database.py")


# ---------------------------------------------------------------- the server process

def server_env(port: int) -> dict:
    env = dict(os.environ)
    env.update({
        "PORT": str(port),
        "DB_PATH": str(DATA / "dev.db"),
        "JWT_SECRET": "dev-secret",
        "UPLOAD_DIR": str(DATA / "uploads"),
        "PROXY_DIR": str(DATA / "transcoded"),
        "THUMBNAIL_DIR": str(DATA / "thumbnails"),
        "COVERS_DIR": str(DATA / "covers"),
        "PROFILES_DIR": str(DATA / "profiles"),
        "IDLE_TIMEOUT_MINUTES": "720",
        "PYTHONUNBUFFERED": "1",
    })
    env.pop("DATABASE_URL", None)
    return env


def start_server(port: int) -> subprocess.Popen:
    log = open(DATA / "server.log", "a", encoding="utf-8")
    return subprocess.Popen([sys.executable, "server.py"], cwd=REPO, env=server_env(port), stdout=log, stderr=subprocess.STDOUT)


def wait_ready(proc: subprocess.Popen, base: str) -> None:
    deadline = time.time() + 60
    while time.time() < deadline:
        if proc.poll() is not None:
            raise SystemExit("The server stopped while starting; see .devdata/server.log")
        try:
            urllib.request.urlopen(base + "/api/setup/status", timeout=1).read()
            return
        except Exception:
            time.sleep(0.3)
    raise SystemExit("The server did not start in time; see .devdata/server.log")


def stop(proc) -> None:
    if proc and proc.poll() is None:
        if os.name == "nt":  # npm.cmd starts node as a child: take the whole tree down
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
            return
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


def python_stamp() -> float:
    """The newest modification time of the server's Python code."""
    newest = 0.0
    for name in WATCHED:
        path = REPO / name
        files = [path] if path.is_file() else path.rglob("*.py") if path.is_dir() else []
        for f in files:
            try:
                newest = max(newest, f.stat().st_mtime)
            except OSError:
                pass
    return newest


# ---------------------------------------------------------------- a tiny API client

class Api:
    def __init__(self, base: str):
        self.base = base
        self.token = ""

    def call(self, path, body=None, method=None, token=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method=method or ("POST" if data is not None else "GET"))
        if raw is None and data is not None:
            req.add_header("Content-Type", "application/json")
        for k, v in (headers or {}).items():
            req.add_header(k, v)
        tok = self.token if token is None else token
        if tok:
            req.add_header("Authorization", f"Bearer {tok}")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                text = res.read().decode()
                return json.loads(text) if text else None
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"{method or 'POST'} {path}: HTTP {e.code} {e.read().decode(errors='replace')[:300]}") from None

    def upload(self, path, field, filename, content, ctype="image/png"):
        boundary = "----devserverboundary"
        head = (f'--{boundary}\r\nContent-Disposition: form-data; name="{field}"; filename="{filename}"\r\n'
                f"Content-Type: {ctype}\r\n\r\n").encode()
        body = head + content + f"\r\n--{boundary}--\r\n".encode()
        return self.call(path, raw=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})


def picture(hue: int, label: str = "") -> bytes:
    """A 640x400 gradient with a sun: something to look at on a card."""
    from PIL import Image, ImageDraw
    import colorsys
    img = Image.new("RGB", (640, 400))
    draw = ImageDraw.Draw(img)
    for x in range(640):
        r, g, b = colorsys.hsv_to_rgb(((hue + x / 640 * 60) % 360) / 360, 0.65, 0.75 - x / 640 * 0.4)
        draw.line([(x, 0), (x, 400)], fill=(int(r * 255), int(g * 255), int(b * 255)))
    draw.ellipse([380, 90, 520, 230], fill=(245, 240, 230))
    if label:
        draw.text((24, 360), label, fill=(255, 255, 255))
    out = io.BytesIO()
    img.save(out, "PNG")
    return out.getvalue()


# ---------------------------------------------------------------- demo data

def seed(api: Api) -> None:
    res = api.call("/api/setup/complete", ADMIN, token="")
    api.token = res["token"]
    users = {}
    for name in ("anna", "jonas"):
        api.call("/api/admin/users", {"username": name, "password": PASSWORD})
    for u in api.call("/api/admin/users")["users"]:
        users[u["username"]] = u["id"]

    st = {}
    for name, color, done in (("Å gjøre", "#8a8aa0", False), ("Pågår", "#e0a030", False),
                              ("Til godkjenning", "#8b6cf0", False), ("Ferdig", "#3fb98a", True)):
        st[name] = api.call("/api/statuses", {"name": name, "color": color, "isDone": done})["status"]["id"]

    today = date.today()
    day = lambda n: (today + timedelta(days=n)).isoformat()  # noqa: E731

    # ---- Flipship: client projects with thumbnails, budgets and a timeline
    flip = api.call("/api/projects", {"name": "Flipship"})["project_id"]
    for name in ("anna", "jonas"):
        api.call(f"/api/projects/{flip}/access", {"userId": users[name], "canReview": True, "canTasks": True, "canLounge": True})
    ref = f"tasks:{flip}"
    thumb = api.call(f"/api/tables/{ref}/columns", {"name": "Thumbnail", "type": "image"})["key"]
    budget = api.call(f"/api/tables/{ref}/columns", {"name": "Budsjett", "type": "number", "config": {"currency": "NOK"}})["key"]
    client = api.call(f"/api/tables/{ref}/columns", {"name": "Kunde", "type": "select",
                                                    "options": [{"label": "Alf Løvvold", "color": "#e05a5a"},
                                                                {"label": "Broomstick", "color": "#3fb6d6"},
                                                                {"label": "Phoria", "color": "#8b6cf0"}]})
    clients = {o["label"]: o["value"] for o in client["options"]}
    projects = [
        ("Phoria - The Sphere", "Phoria", "Ferdig", 95000, -40, -5, "The 20th thumb wrestling tournament, now global."),
        ("Alf Løvvold - Dragonlord", "Alf Løvvold", "Ferdig", 120000, -30, -2, ""),
        ("Alf Løvvold - La Palma", "Alf Løvvold", "Til godkjenning", 64000, -14, 3, "Reisefilm, 3 x 30 s."),
        ("Alf Løvvold - NR24", "Alf Løvvold", "Pågår", 88000, -7, 10, ""),
        ("Broomstick - Kanalbyen", "Broomstick", "Pågår", 140000, -3, 18, "Boligprosjekt, dronebilder og intervjuer."),
        ("Broomstick - Xtensity", "Broomstick", "Å gjøre", 70000, 5, 25, ""),
        ("Xtensity gifs", "Broomstick", "Å gjøre", None, 8, 12, ""),
        ("Global ocean tech", None, "Å gjøre", None, 14, 40, "Pitch, ikke bekreftet."),
    ]
    for i, (name, who, status, money, start, end, desc) in enumerate(projects):
        task = api.call(f"/api/projects/{flip}/tasks", {
            "name": name, "statusId": st[status], "priority": ("high", "medium", "low")[i % 3],
            "assigneeIds": [users["anna"]] if i % 2 else [users["jonas"]],
            "startDate": day(start), "dueDate": day(end), **({"description": desc} if desc else {})})["task"]
        values = {}
        if money:
            values[budget] = money
        if who:
            values[client["key"]] = clients[who]
        if i < 6:
            values[thumb] = api.upload(f"/api/tables/{ref}/images", "file", "thumb.png", picture(i * 47, name))["value"]
        api.call(f"/api/tables/{ref}/rows/{task['id']}", {"values": values}, method="PATCH")
    views = [
        ("Prosjekter Thumbnails", "gallery", {"gallery": {"cardColumns": ["status", client["key"], budget], "cover": "auto", "size": "medium", "fit": "cover"}}),
        ("Prosjekter Oversikt", "table", {}),
        ("Tidslinje prosjekter", "gantt", {"gantt": {"startColumn": "startDate", "endColumn": "dueDate", "scale": "week"}}),
        ("Etter status", "board", {"board": {"groupBy": "status", "cardColumns": []}}),
    ]
    for name, layout, extra in views:
        api.call("/api/views", {"tableRef": ref, "name": name, "layout": layout, "config": {"query": {}, **extra}})

    # ---- Sommerkampanje 2027: a production with clips and everyday tasks
    camp = api.call("/api/projects", {"name": "Sommerkampanje 2027"})["project_id"]
    for name in ("anna", "jonas"):
        api.call(f"/api/projects/{camp}/access", {"userId": users[name], "canReview": True, "canTasks": True, "canLounge": True})
    clip_ids = []
    for n, hue in (("strand_v1.png", 200), ("fjell_v1.png", 110)):
        res = api.upload(f"/api/projects/{camp}/clips", "files", n, picture(hue, n))
        found = res.get("clips") if isinstance(res, dict) else None
        if found and isinstance(found, list) and isinstance(found[0], dict) and found[0].get("id"):
            clip_ids.append(found[0]["id"])
    todo = [
        ("Skriv kreativ brief", "Ferdig", "high", -10), ("Storyboard 30-sekunders film", "Til godkjenning", "high", -1),
        ("Casting - to skuespillere", "Pågår", "medium", 2), ("Opptak dag 1 - strand", "Pågår", "high", 5),
        ("Opptak dag 2 - fjell", "Å gjøre", "high", 6), ("Fargekorrigering", "Å gjøre", "low", 12),
        ("Klipp 6 s, 15 s og 30 s versjoner", "Å gjøre", "medium", 14), ("Bestill flybilletter til Lofoten", "Å gjøre", "high", -2),
        ("Publiseringsplan SoMe", "Pågår", "low", 20), ("Gjennomgang med kunde", "Pågår", "medium", 1),
    ]
    for i, (name, status, prio, due) in enumerate(todo):
        body = {"name": name, "statusId": st[status], "priority": prio, "dueDate": day(due),
                "assigneeIds": [users["admin"]] + ([users["anna"]] if i % 3 == 0 else [])}
        if clip_ids and name.startswith("Opptak"):
            body["clipId"] = clip_ids[0 if "strand" in name else -1]
        api.call(f"/api/projects/{camp}/tasks", body)

    # ---- Lounge channels next to the project rooms
    for name in ("Generelt", "Salg"):
        api.call("/api/chat/channels", {"name": name})

    # ---- a custom table in Flipship
    api.call("/api/tables", {"name": "Utstyr", "space": f"p:{flip}", "columns": [
        {"name": "Antall", "type": "number"}, {"name": "Pris", "type": "number"}, {"name": "Bestilt", "type": "checkbox"}]})
    print(f"  Seeded: projects Flipship and Sommerkampanje 2027, users admin, anna, jonas (password {PASSWORD}).")


# ---------------------------------------------------------------- main

def main() -> None:
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8090)
    parser.add_argument("--reset", action="store_true", help="delete the dev data and seed it again")
    parser.add_argument("--no-watch", action="store_true", help="no web rebuilds and no server restarts")
    args = parser.parse_args()

    if args.reset and DATA.exists():
        shutil.rmtree(DATA)
    fresh = not (DATA / "dev.db").exists()
    DATA.mkdir(exist_ok=True)
    base = f"http://127.0.0.1:{args.port}"

    bundler = None
    if not args.no_watch:
        npm = "npm.cmd" if os.name == "nt" else "npm"
        bundler = subprocess.Popen([npm, "run", "watch"], cwd=REPO / "web", stdout=open(DATA / "web.log", "a", encoding="utf-8"),
                                   stderr=subprocess.STDOUT)
    elif not (REPO / "static" / "dist" / "pages.js").exists():
        subprocess.run(["npm.cmd" if os.name == "nt" else "npm", "run", "build"], cwd=REPO / "web", check=True)

    server = start_server(args.port)
    try:
        wait_ready(server, base)
        if fresh:
            print("  Seeding demo data ...")
            seed(Api(base))
        print(f"\n  Cutline (dev)  {base}   log in: {ADMIN['username']} / {ADMIN['password']}")
        print("  Web code: rebuilt on save, reload the tab.  Python code: the server restarts by itself.")
        print("  Logs: .devdata/server.log and .devdata/web.log.  Ctrl+C stops everything.\n")
        stamp = python_stamp()
        while True:
            time.sleep(1)
            if server.poll() is not None and args.no_watch:
                raise SystemExit("The server stopped; see .devdata/server.log")
            if args.no_watch:
                continue
            now = python_stamp()
            if now != stamp:
                stamp = now
                print(time.strftime("  %H:%M:%S"), "Python changed: restarting the server ...", flush=True)
                stop(server)
                server = start_server(args.port)
                try:
                    wait_ready(server, base)
                    print(time.strftime("  %H:%M:%S"), "Ready.", flush=True)
                except SystemExit as e:
                    print("  ", e, "(waiting for the next change)", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        stop(server)
        stop(bundler)


if __name__ == "__main__":
    main()
