"""The page that hosts the web bundle: routes and missing-bundle behaviour."""


def test_dev_ui_serves_the_main_page(client):
    res = client.get("/dev/ui")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "/static/dist/pages.js" in res.text


def test_index_loads_even_if_the_bundle_is_not_built(client, monkeypatch):
    import os

    import api.assets as assets

    real = os.path.getmtime
    monkeypatch.setattr(
        assets.os.path, "getmtime",
        lambda p: (_ for _ in ()).throw(OSError("missing")) if "dist" in str(p) else real(p),
    )
    res = client.get("/")
    assert res.status_code == 200
    # URL stays unstamped, so the browser just gets a 404 for it
    assert 'src="/static/dist/pages.js"' in res.text
