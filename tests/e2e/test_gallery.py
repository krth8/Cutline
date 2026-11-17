"""The gallery layout and image columns: upload a thumbnail from the table cell, see it as the card picture in a
gallery view, a money column, and a new card typed into the gallery."""

import io
import time

import pytest
from PIL import Image

from e2e.e2e_support import ADMIN, login

pytestmark = pytest.mark.e2e


def wait_for(fn, timeout=12.0):
    end = time.time() + timeout
    last = None
    while time.time() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.2)
    raise AssertionError(f"condition not met, last value: {last!r}")


@pytest.fixture(scope="module")
def scene(server):
    project = server.create_project("Gallery")
    ref = f"tasks:{project}"
    img = server.api(f"/api/tables/{ref}/columns", {"name": "Thumbnail", "type": "image"})
    money = server.api(f"/api/tables/{ref}/columns", {"name": "Budget", "type": "number", "config": {"currency": "NOK"}})
    ids = {n: server.create_task(project, n)["task"]["id"] for n in ("Phoria", "Jotun")}
    server.api(f"/api/tables/{ref}/rows/{ids['Phoria']}", {"values": {money["key"]: 577000}}, method="PATCH")
    table = server.api("/api/views", {"tableRef": ref, "name": "Rows", "layout": "table", "config": {"query": {}}})
    gallery = server.api("/api/views", {"tableRef": ref, "name": "Cards", "layout": "gallery", "config": {"query": {}}})
    return {"project": project, "ref": ref, "img": img["key"], "money": money["key"], "ids": ids,
            "table": table["id"], "gallery": gallery["id"]}


def png(path):
    Image.new("RGB", (64, 40), (30, 140, 90)).save(path, "PNG")
    return path


def test_a_thumbnail_uploaded_in_the_table_is_the_card_picture(server, scene, new_page, tmp_path):
    page = new_page(name="admin-gallery")
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{scene['project']}/view/{scene['table']}")
    page.wait_for_selector("[data-testid=table-layout]", timeout=20000)
    cell = page.locator(f"[data-testid=table-row]:has-text('Phoria') [data-col={scene['img']}] .cl-cellhost")
    cell.click()
    page.set_input_files("[data-testid=image-file]", str(png(tmp_path / "thumb.png")))
    page.wait_for_selector(f"[data-testid=table-row]:has-text('Phoria') [data-col={scene['img']}] [data-testid=cell-image]", timeout=15000)
    stored = wait_for(lambda: next((r["values"].get(scene["img"]) for r in server.api(f"/api/tables/{scene['ref']}/query", {})["rows"]
                                   if r["id"] == scene["ids"]["Phoria"]), None))
    assert stored.endswith(".png")

    page.goto(f"{server.base_url}/p/{scene['project']}/view/{scene['gallery']}")
    page.wait_for_selector("[data-testid=gallery-layout]", timeout=20000)
    card = page.locator("[data-testid=gallery-card]:has-text('Phoria')")
    src = card.locator("[data-testid=gallery-cover]").get_attribute("src")
    assert src == f"/api/table-images/{stored}"
    page.wait_for_function("() => { const i = document.querySelector('[data-testid=gallery-cover]'); return i && i.complete && i.naturalWidth === 64 }",
                           timeout=10000)
    money = page.evaluate("new Intl.NumberFormat(undefined, {style: 'currency', currency: 'NOK'}).format(577000)")
    assert money.replace(" ", " ") in card.inner_text().replace(" ", " ")
    assert page.locator("[data-testid=gallery-card]:has-text('Jotun') [data-testid=gallery-cover]").count() == 0


def test_a_card_typed_into_the_gallery_becomes_a_row(server, scene, new_page):
    page = new_page(name="admin-gallery-add")
    login(page, server.base_url, ADMIN["username"], ADMIN["password"], goto=f"/p/{scene['project']}/view/{scene['gallery']}")
    page.wait_for_selector("[data-testid=gallery-layout]", timeout=20000)
    page.click("[data-testid=gallery-add]")
    page.fill("[data-testid=gallery-add-form] input", "global ocean tech")
    page.keyboard.press("Enter")
    page.wait_for_selector("[data-testid=gallery-card]:has-text('global ocean tech')", timeout=15000)
    assert any(r["values"]["name"] == "global ocean tech" for r in server.api(f"/api/tables/{scene['ref']}/query", {})["rows"])
