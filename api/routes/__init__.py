"""Route modules split out of server.py."""

from fastapi import APIRouter

from . import access, chat, documents, live, notifications, settings, tables, tasks, users

router = APIRouter()
for _module in (access, notifications, users, settings, tables, tasks, documents, chat, live):
    router.include_router(_module.router)
