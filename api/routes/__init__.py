"""Route modules split out of server.py."""

from fastapi import APIRouter

from . import access, chat, clips, comment_tasks, documents, export, home, live, mentions, notifications, page_files, pages, push, search, settings, tables, tasks, templates, users, views

router = APIRouter()
for _module in (home, access, clips, comment_tasks, mentions, notifications, pages, page_files, export, push, search, users, settings, tables, templates, views, tasks, documents, chat, live):
    router.include_router(_module.router)
