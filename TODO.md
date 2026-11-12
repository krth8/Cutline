# TODO

## Features
- [ ] Object storage (S3 / Hetzner Object Storage) for videos, thumbnails, covers and uploads
- [ ] Email notifications (comments, mentions, invites, due dates)
- [ ] Export review comments (PDF, CSV, EDL/markers for Premiere/Resolve)
- [ ] Share links: allow/deny download toggle

## Tasks
- [ ] Board (kanban) view grouped by status, with drag between columns
- [ ] Drag-and-drop reordering (backend `/tasks/reorder` exists, no UI)
- [ ] Sections in the list view (backend `/sections` API exists, no UI)
- [ ] Calendar view on due dates
- [ ] "My tasks" across all projects
- [ ] @mentions in task comments with notifications
- [ ] Create a task straight from a review comment / timecode

## Docs
- [ ] Replace whole-document sync with real CRDT sync (Yjs; `yjs_state` column is already there) so simultaneous edits don't overwrite each other
- [ ] Move off `document.execCommand` (deprecated) to an editor library (e.g. Tiptap)
- [ ] Link docs to tasks and clips; mention tasks inside docs
- [ ] Version history

## Tech debt
- [ ] HTML previews: move Chromium out of the Cutline image into a separate Playwright container (`mcr.microsoft.com/playwright`, `playwright run-server`) that `html_preview.py` connects to; then drop the bookworm pin in the Dockerfile
- [ ] `core/TaskQuery.js` is unused (reads wrong fields); remove or merge into `taskFilters.js`
- [ ] App layout is not usable on phones (sidebar takes most of the width)
- [ ] Media (`/video`, `/thumbnail`) is served without auth; use signed URLs
- [ ] In-memory project/task state with periodic write-back: single process only, recent changes can be lost on crash
- [ ] Continue splitting `server.py` (sessions, clips/transcoding, comments, websocket)
- [ ] Add automated tests (auth/access rules first)
