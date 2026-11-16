"""Who is in a project and what they are doing (the people panel of the Lounge tab).

GET /api/projects/{project_id}/people -> {people: [{id, username, profileImage, role, online, place, lastSeen}]}

Everyone with access to the project and every admin. ``place`` is what their open tab shows in this project
("Review: shot_010", "Creative brief"), told by the tab over the live socket ({"type": "place", ...}); it is null
when they are online but elsewhere, and for people who are away. Only people with the project's Lounge tab
may ask.
"""

from fastapi import APIRouter, Depends, HTTPException

from api.auth import can_use_lounge, require_auth
from api.events import live
from api.state import projects
from database.access import db_list_project_access
from database.users import db_list_users

router = APIRouter()


@router.get("/api/projects/{project_id}/people")
async def project_people(project_id: str, user: dict = Depends(require_auth)):
    if project_id not in projects:
        raise HTTPException(status_code=404, detail="Project not found")
    if not can_use_lounge(user, project_id):
        raise HTTPException(status_code=403, detail="Access denied")
    members = {}
    for row in db_list_project_access(project_id):
        members[row["userId"]] = {"id": row["userId"], "username": row["username"], "profileImage": row["profileImage"],
                                  "role": "owner" if row["isOwner"] else row["userRole"]}
    for person in db_list_users():
        if person["isAdmin"] and person["id"] not in members:
            members[person["id"]] = {"id": person["id"], "username": person["username"],
                                     "profileImage": person["profileImage"], "role": "admin"}
    people = []
    for person in members.values():
        online, place = live.presence(person["id"], project_id)
        people.append({**person, "online": online, "place": place, "lastSeen": live.last_seen.get(person["id"])})
    people.sort(key=lambda p: (not p["online"], p["place"] is None, p["username"].lower()))
    return {"people": people}
