"""The tasks table source: ``tasks:<projectId>`` and ``tasks:*``.

Builtin columns are mapped from the task fields. Reads come from the in-memory task
state (kept in step with the database by the task API); every write goes through the
shared functions in api/routes/tasks.py, so validation, persistence, in-memory state
and the live events are exactly those of the task endpoints.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional

from fastapi import HTTPException

from api.routes import tasks as task_api
from api.state import projects, tasks
from database import (
    db_check_project_access,
    db_get_effective_setting,
    db_get_priority_preset,
    db_get_project_access,
    db_get_section,
    db_get_user_by_id,
    db_list_project_access,
    db_list_sections,
    db_list_statuses,
)

from .query import run_query
from .source import TableSource, custom_columns_for

DEFAULT_PRIORITIES = [
    {"value": "low", "label": "Low", "color": "#6b7280"},
    {"value": "medium", "label": "Medium", "color": "#f59e0b"},
    {"value": "high", "label": "High", "color": "#ef4444"},
]

# column key -> task API field (writable columns only)
WRITABLE = {
    "name": "name",
    "status": "statusId",
    "assignees": "assigneeIds",
    "priority": "priority",
    "stage": "stageTag",
    "dueDate": "dueDate",
    "section": "sectionId",
    "description": "description",
}
READONLY_KEYS = {"clip", "createdAt", "createdBy", "project"}


def _bad(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def _may_read(principal: dict, project_id: str) -> bool:
    return db_check_project_access(principal["id"], project_id, require_tasks=True)


class TasksSource(TableSource):
    def __init__(self, scope: str):
        self.scope = scope  # a project id, or "*"
        self.ref = f"tasks:{scope}"
        self.all_projects = scope == "*"

    # ------------------------------------------------------------ access

    def project_ids(self, principal: dict) -> List[str]:
        """The projects whose tasks this principal may read (403/404 for a single project)."""
        if principal.get("is_guest"):
            raise HTTPException(status_code=403, detail="Not available to share-link guests")
        if self.all_projects:
            return [pid for pid in projects if _may_read(principal, pid)]
        if self.scope not in projects:
            raise HTTPException(status_code=404, detail="Project not found")
        if not _may_read(principal, self.scope):
            raise HTTPException(status_code=403, detail="Task access denied for this project")
        return [self.scope]

    def _task_in_scope(self, principal: dict, task_id: str) -> dict:
        """A task of this table that the principal may read (404 for anything else)."""
        task = tasks.get(task_id)
        if not task or (not self.all_projects and task["projectId"] != self.scope):
            raise HTTPException(status_code=404, detail="Row not found")
        if task["projectId"] not in self.project_ids(principal):
            raise HTTPException(status_code=404, detail="Row not found")
        return task

    def _need_edit(self, principal: dict, project_id: str) -> None:
        if not task_api.can_edit_tasks(principal, project_id):
            raise HTTPException(status_code=403, detail="Task access denied for this project")

    # ------------------------------------------------------------ schema

    def _people_options(self, project_ids: List[str], scoped_tasks: List[dict]) -> List[dict]:
        """Project members with task access, plus anyone already assigned or creating tasks."""
        seen: Dict[str, str] = {}
        for pid in project_ids:
            for member in db_list_project_access(pid):
                if member["canTasks"]:
                    seen.setdefault(member["userId"], member["username"])
        for task in scoped_tasks:
            for uid in [a["id"] for a in task.get("assignees", [])] + [task.get("createdBy")]:
                if uid and uid not in seen:
                    user = db_get_user_by_id(uid)
                    if user:
                        seen[uid] = user["username"]
        return [{"value": uid, "label": name} for uid, name in seen.items()]

    def _priority_options(self) -> List[dict]:
        preset_id = db_get_effective_setting("priorityPreset", None if self.all_projects else self.scope)
        preset = db_get_priority_preset(preset_id) if isinstance(preset_id, str) else None
        if preset and preset["options"]:
            ordered = sorted(preset["options"], key=lambda o: o.get("sortOrder", 0))
            return [{"value": o["id"], "label": o.get("label", o["id"]), "color": o.get("color")} for o in ordered]
        return [dict(o) for o in DEFAULT_PRIORITIES]

    def _stage_options(self, project_ids: List[str]) -> List[dict]:
        used, suggested = set(), []
        for pid in project_ids:
            info = task_api.stage_tags(pid)
            used.update(info["usedStages"])
            suggested = info["suggestedStages"]
        names = sorted(used) + [s for s in suggested if s not in used]
        return [{"value": n, "label": n} for n in names]

    def _columns(self, project_ids: List[str], scoped_tasks: List[dict]) -> List[dict]:
        sections = [{"value": s["id"], "label": s["name"], "color": s["color"]}
                    for pid in project_ids for s in db_list_sections(pid)]
        people = self._people_options(project_ids, scoped_tasks)
        columns = [
            {"key": "name", "name": "Name", "type": "text", "builtin": True},
            {"key": "status", "name": "Status", "type": "status", "builtin": True,
             "options": [{"value": s["id"], "label": s["name"], "color": s["color"]} for s in db_list_statuses()]},
            {"key": "assignees", "name": "Assignees", "type": "people", "builtin": True, "options": people},
            {"key": "priority", "name": "Priority", "type": "priority", "builtin": True,
             "options": self._priority_options()},
            {"key": "stage", "name": "Stage", "type": "select", "builtin": True,
             "options": self._stage_options(project_ids)},
            {"key": "dueDate", "name": "Due date", "type": "date", "builtin": True},
            {"key": "section", "name": "Section", "type": "select", "builtin": True, "options": sections},
            {"key": "clip", "name": "Clip", "type": "clip", "builtin": True, "readonly": True},
            {"key": "description", "name": "Description", "type": "longtext", "builtin": True},
            {"key": "createdAt", "name": "Created", "type": "date", "builtin": True, "readonly": True},
            {"key": "createdBy", "name": "Created by", "type": "person", "builtin": True, "readonly": True,
             "options": people},
        ]
        if self.all_projects:
            columns.append({"key": "project", "name": "Project", "type": "select", "builtin": True,
                            "readonly": True,
                            "options": [{"value": pid, "label": projects[pid].get("name", pid)}
                                        for pid in project_ids]})
        return columns + custom_columns_for(self.ref)

    def _scoped_tasks(self, project_ids: List[str]) -> List[dict]:
        order = {pid: i for i, pid in enumerate(project_ids)}
        found = [t for t in tasks.values() if t.get("projectId") in order]
        return sorted(found, key=lambda t: (order[t["projectId"]], t.get("sortOrder") or 0, t.get("createdAt") or ""))

    def schema(self, principal: dict) -> dict:
        project_ids = self.project_ids(principal)
        if self.all_projects:
            name, edit_schema = "All tasks", False
        else:
            access = db_get_project_access(principal["id"], self.scope)
            admin = principal.get("role") == "admin" or principal.get("is_admin")
            name = f"{projects[self.scope].get('name', 'Project')} tasks"
            edit_schema = bool(admin or (access and access["isOwner"]))
        return {
            "ref": self.ref,
            "name": name,
            "columns": self._columns(project_ids, self._scoped_tasks(project_ids)),
            "titleColumn": "name",
            "capabilities": {"create": True, "delete": True, "hierarchy": True, "editSchema": edit_schema},
        }

    # ------------------------------------------------------------ rows

    def _row(self, task: dict, can_edit: bool) -> dict:
        clip = {"id": task["clipId"], "name": task.get("clipName")} if task.get("clipId") is not None else None
        values = {
            "name": task.get("name"),
            "status": task.get("statusId"),
            "assignees": [a["id"] for a in task.get("assignees", [])],
            "priority": task.get("priority"),
            "stage": task.get("stageTag"),
            "dueDate": task.get("dueDate"),
            "section": task.get("sectionId"),
            "clip": clip,
            "description": task.get("description"),
            "createdAt": task.get("createdAt"),
            "createdBy": task.get("createdBy"),
        }
        if self.all_projects:
            values["project"] = task["projectId"]
        return {
            "id": task["id"],
            "tableRef": f"tasks:{task['projectId']}",
            "parentId": task.get("parentId"),
            "childCount": task.get("childCount", 0),
            "values": values,
            "canEdit": can_edit,
        }

    def _rows(self, principal: dict, tasks_list: List[dict]) -> List[dict]:
        editable: Dict[str, bool] = {}
        rows = []
        for task in tasks_list:
            pid = task["projectId"]
            if pid not in editable:
                editable[pid] = task_api.can_edit_tasks(principal, pid)
            rows.append(self._row(task, editable[pid]))
        return rows

    def query(self, principal: dict, query: Optional[dict], today: Optional[date] = None) -> dict:
        project_ids = self.project_ids(principal)
        scoped = self._scoped_tasks(project_ids)
        columns = self._columns(project_ids, scoped)
        return run_query(self._rows(principal, scoped), columns, query, me=principal["id"], today=today,
                         title_column="name")

    def _one_row(self, principal: dict, task_id: str) -> dict:
        return self._rows(principal, [tasks[task_id]])[0]

    # ------------------------------------------------------------ writes

    def _to_task_fields(self, values: Any, project_id: str, for_create: bool) -> dict:
        """Row values (by column key) -> fields of the task API, validated."""
        if not isinstance(values, dict):
            raise _bad("values must be an object of column key -> value")
        fields: Dict[str, Any] = {}
        for key, value in values.items():
            if key in READONLY_KEYS:
                raise _bad(f"Column '{key}' is read-only")
            if key not in WRITABLE:
                raise _bad(f"Unknown column '{key}'. Writable columns: {', '.join(WRITABLE)}")
            fields[WRITABLE[key]] = self._check_value(key, value, project_id)
        if for_create and fields.get("priority") is None:
            fields.pop("priority", None)  # the task API default (medium)
        return fields

    def _check_value(self, key: str, value: Any, project_id: str) -> Any:
        if key == "name":
            if not isinstance(value, str) or not value.strip():
                raise _bad("Task name is required")
            return value
        if key == "assignees":
            if value is None:
                return []
            if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
                raise _bad("assignees must be a list of user ids")
            return list(dict.fromkeys(value))
        if value == "":
            value = None
        if value is None:
            return None
        if key == "description":
            if not isinstance(value, str):
                raise _bad("description must be text")
            return value
        if not isinstance(value, str):
            raise _bad(f"Value for '{key}' must be text or null")
        if key == "status" and not any(s["id"] == value for s in db_list_statuses()):
            raise _bad("Unknown status")
        if key == "section":
            section = db_get_section(value)
            if not section or section["projectId"] != project_id:
                raise _bad("Unknown section for this project")
        if key == "dueDate":
            try:
                date.fromisoformat(value)
            except ValueError:
                raise _bad("dueDate must be a date like 2030-01-31")
        return value

    async def create_row(self, principal: dict, values: dict, parent_id: Optional[str] = None,
                         project_id: Optional[str] = None) -> dict:
        self.project_ids(principal)  # access to the table itself (403/404)
        if self.all_projects:
            if not project_id:
                raise _bad("projectId is required to create a row in tasks:*")
        elif project_id and project_id != self.scope:
            raise _bad("projectId does not match this table")
        else:
            project_id = self.scope
        if project_id not in projects:
            raise HTTPException(status_code=404, detail="Project not found")
        self._need_edit(principal, project_id)

        fields = self._to_task_fields(values, project_id, for_create=True)
        if parent_id:
            fields["parentId"] = parent_id
        task = await task_api.create_task_record(principal, project_id, fields)
        return self._one_row(principal, task["id"])

    async def update_row(self, principal: dict, row_id: str, values: dict) -> dict:
        task = self._task_in_scope(principal, row_id)
        self._need_edit(principal, task["projectId"])
        fields = self._to_task_fields(values, task["projectId"], for_create=False)
        await task_api.update_task_record(task, fields)
        return self._one_row(principal, row_id)

    async def delete_row(self, principal: dict, row_id: str) -> None:
        task = self._task_in_scope(principal, row_id)
        self._need_edit(principal, task["projectId"])
        await task_api.delete_task_record(task)

    async def reorder(self, principal: dict, ids: List[str], before: Optional[str] = None) -> None:
        if not isinstance(ids, list) or not ids or not all(isinstance(i, str) for i in ids):
            raise _bad("ids must be a non-empty list of row ids")
        moved = [self._task_in_scope(principal, i) for i in dict.fromkeys(ids)]
        project_id, parent_id = moved[0]["projectId"], moved[0].get("parentId")
        if any(t["projectId"] != project_id or t.get("parentId") != parent_id for t in moved):
            raise _bad("Rows can only be reordered among siblings of one project")
        self._need_edit(principal, project_id)

        siblings = sorted((t for t in tasks.values()
                           if t["projectId"] == project_id and t.get("parentId") == parent_id),
                          key=lambda t: (t.get("sortOrder") or 0, t.get("createdAt") or ""))
        moving = {t["id"] for t in moved}
        rest = [t["id"] for t in siblings if t["id"] not in moving]
        order = [t["id"] for t in moved]
        if before is None:
            result = rest + order
        elif before in moving:
            raise _bad("'before' cannot be one of the moved rows")
        elif before in rest:
            at = rest.index(before)
            result = rest[:at] + order + rest[at:]
        else:
            raise _bad("'before' is not a sibling of the moved rows")
        await task_api.reorder_task_records(project_id, result)
