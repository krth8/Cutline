"""Route modules split out of server.py."""

from fastapi import APIRouter

from . import access, chat, documents, notifications, settings, tasks, users

router = APIRouter()
for _module in (access, notifications, users, settings, tasks, documents, chat):
    router.include_router(_module.router)
