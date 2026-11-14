# TODO

## Features
- [ ] Object storage (S3 / Hetzner Object Storage) for videos, thumbnails, covers and uploads
- [ ] Email notifications (comments, mentions, invites, due dates); users and guests can now have an email on file
- [ ] Suspend a user without deleting the account
- [ ] Export review comments as PDF and EDL/markers for Premiere/Resolve (Markdown, CSV and JSON are done)
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
- [ ] Simultaneous edits are merged per block (paragraph, heading, to-do); two people typing in the *same* block still end with one of the two texts. Character-level merging needs a CRDT (Yjs; `yjs_state` column is already there)
- [ ] Move off `document.execCommand` (deprecated) to an editor library (e.g. Tiptap)
- [ ] Link docs to tasks and clips; mention tasks inside docs
- [ ] Version history

## Tech debt
- [ ] HTML previews: move Chromium out of the Cutline image into a separate Playwright container (`mcr.microsoft.com/playwright`, `playwright run-server`) that `html_preview.py` connects to; then drop the bookworm pin in the Dockerfile
- [ ] App layout is not usable on phones (sidebar takes most of the width)
- [ ] In-memory project/task state: single process only. Clip status and task edits are still written back every 30 s (comments, annotations and new clips are saved at once)
- [ ] Share-link guests keep their token in `sessionStorage` (scoped to one project, ends with the tab)
- [ ] Continue splitting `server.py` (sessions, clips/transcoding, comments, websocket)
- [ ] More tests: tasks, documents, uploads/transcoding (auth, access, comments, live updates and media are covered; run `pytest`)
- [ ] Run `pytest` in GitHub Actions (needs a push with the `workflow` scope)
- [ ] Live updates for docs lists, clip uploads in progress and the sessions list (still polled / reload)
