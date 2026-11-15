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


import pytest


@pytest.mark.parametrize("path", [
    "/home",
    "/me",
    "/me/page/pg1",
    "/p/proj1/pages",
    "/p/proj1/page/pg1",
    "/p/proj1/review",
    "/p/proj1/review?clip=3&v=2&session=abc",
    "/p/proj1/pages?task=t1",
])
def test_app_routes_serve_the_main_page(client, path):
    res = client.get(path)
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "/static/dist/pages.js" in res.text
    assert 'id="viewPages"' in res.text


def test_unknown_app_paths_are_still_404(client):
    assert client.get("/me/other").status_code == 404
    assert client.get("/p/proj1/unknown").status_code == 404


def test_dev_theme_serves_the_main_page_with_theme_css_before_main_css(client):
    res = client.get("/dev/theme")
    assert res.status_code == 200
    assert res.text.index("/static/css/theme.css") < res.text.index("/static/css/main.css")
    # the inline script that sets data-theme runs before the first stylesheet
    assert res.text.index("CutlineTheme") < res.text.index("/static/css/theme.css")
