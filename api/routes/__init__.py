"""Route modules split out of server.py."""

from fastapi import APIRouter

from . import access, chat, documents, live, notifications, pages, settings, tables, tasks, users, views

router = APIRouter()
for _module in (access, notifications, pages, users, settings, tables, views, tasks, documents, chat, live):
    router.include_router(_module.router)
