# Cutline

## Development

The backend is FastAPI (Python 3.10+). The newer interface (Pages) is a TypeScript + React
bundle in `web/` that is built with esbuild into `static/dist/` (git-ignored) and loaded by
`static/index.html` next to the older script-tag code. The app still starts without the
bundle, but the new screens are missing.

### Windows: fresh clone to running app

1. Install Python 3.10+ and Node.js 20+ (`install.bat` installs Python and FFmpeg through winget if they are missing; Node.js comes from https://nodejs.org).
2. Run `install.bat`. It creates `venv`, installs the Python packages, then runs `npm ci` and `npm run build` in `web/` (with a warning if Node.js is missing).
3. Run `start.bat`. It builds the bundle if `static/dist/pages.js` is missing, then starts the server on http://localhost:8099.
4. On the first visit, create the admin account in the browser.

### Docker

```
docker build -t cutline .
docker run -p 8099:8099 -v cutline-data:/data cutline
```

The Dockerfile builds the bundle in a Node stage (`npm ci && npm run build`) and copies
`static/dist/` into the final image, so no local Node.js is needed.

### Web bundle (`web/`)

```
cd web
npm ci               # install (uses package-lock.json)
npm run build        # minified bundle + sourcemaps -> ../static/dist/pages.js and pages.css
npm run watch        # rebuild on change (reload the browser to see it)
npm run typecheck    # tsc --noEmit, strict
npm test             # vitest (jsdom)
```

Code in `web/src` reaches the old page only through `web/src/platform.ts`; tests inject
`createFakePlatform()` from `web/src/testing/fakePlatform.ts`. Shared components live in
`web/src/ui/`; admins can see all of them at `/dev/ui`.

The app is addressed by URL: `/p/<project>/review`, `/p/<project>/pages`, `/me` and more
(PLAN.md 5.3; `web/src/router.ts` and `static/js/features/routes.js`). The browser checks for
routes and the shell run against a throwaway server with `python web/dev/check_routes.py`
(needs Playwright and a built bundle).

### Backend

```
python -m pip install -r requirements.txt -r requirements-dev.txt
python server.py          # http://localhost:8099 (env PORT changes the port)
python -m pytest -q       # backend tests
```
