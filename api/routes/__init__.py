"""Route modules split out of server.py."""

from fastapi import APIRouter

from . import access, activity, chat, people, clips, comment_tasks, documents, export, home, live, mentions, notifications, page_files, pages, push, search, settings, table_images, tables, tasks, templates, users, views

router = APIRouter()
for _module in (home, access, activity, people, clips, comment_tasks, mentions, notifications, pages, page_files, export, push, search, users, settings, table_images, tables, templates, views, tasks, documents, chat, live):
    router.include_router(_module.router)
