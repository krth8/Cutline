"""Route modules split out of server.py."""

from fastapi import APIRouter

from . import access, chat, clips, comment_tasks, documents, live, mentions, notifications, page_files, pages, settings, tables, tasks, users, views

router = APIRouter()
for _module in (access, clips, comment_tasks, mentions, notifications, pages, page_files, users, settings, tables, views, tasks, documents, chat, live):
    router.include_router(_module.router)
