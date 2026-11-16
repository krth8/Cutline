"""The activity list of the Home tab's panel.

GET /api/activity?scope=me|project&projectId=&limit=   -> {events: [...]}
  scope=me        what concerns the caller (assigned, answered, tagged) in every project they have, done by others
  scope=project   everything in one project

Task and page events need the Home tab of the project (can_tasks), comment events the Review tab.
"""

from fastapi import APIRouter, Depends, HTTPException

from api.auth import require_auth
from api.state import projects
from database.access import db_list_accessible_projects
from database.activity import db_list_activity
from database.users import db_get_user_by_id

router = APIRouter()

MAX_EVENTS = 100


@router.get("/api/activity")
async def list_activity(scope: str = "me", projectId: str = "", limit: int = 40, user: dict = Depends(require_auth)):
    limit = max(1, min(MAX_EVENTS, limit))
    mine = {p["id"]: p for p in db_list_accessible_projects(user["id"]) if p["id"] in projects}
    if scope == "project":
        if projectId not in mine:
            raise HTTPException(status_code=404, detail="Project not found")
        chosen = [projectId]
    elif scope == "me":
        chosen = list(mine)
    else:
        raise HTTPException(status_code=400, detail="scope must be me or project")

    hidden = {}
    for project_id in chosen:
        project = mine[project_id]
        prefixes = []
        if not project.get("canTasks", True):
            prefixes += ["task.", "page."]
        if not project.get("canReview", True):
            prefixes += ["comment."]
        if prefixes:
            hidden[project_id] = tuple(prefixes)

    events = db_list_activity(chosen, involving=user["id"] if scope == "me" else None, kinds_hidden=hidden, limit=limit)
    images = {}
    for event in events:
        actor_id = event["actorId"]
        if actor_id and actor_id not in images:
            images[actor_id] = (db_get_user_by_id(actor_id) or {}).get("profileImage")
        event["actorImage"] = images.get(actor_id)
        event["projectName"] = projects.get(event["projectId"], {}).get("name")
    return {"events": events}
