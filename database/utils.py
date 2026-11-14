"""
Database utility functions
"""

from contextlib import contextmanager
from typing import Dict
from .engine import get_connection, init_schema
from .migrate import run_migrations


@contextmanager
def get_db():
    """Context manager for database connections - wrapper for compatibility."""
    with get_connection() as conn:
        yield conn


def init_database():
    """Initialize the database schema and built-in data."""
    with get_db() as conn:
        init_schema(conn)
    run_migrations()

    # Initialize built-in presets
    from .settings import db_init_builtin_priority_presets, db_init_builtin_status_presets, db_init_builtin_stage_presets
    db_init_builtin_priority_presets()
    db_init_builtin_status_presets()
    db_init_builtin_stage_presets()

    print("Database initialized successfully")


def load_all_projects_to_memory() -> Dict[str, dict]:
    """Load all projects from database into memory for fast access."""
    from .projects import db_get_project
    from .engine import execute, fetchall

    projects = {}

    with get_db() as conn:
        cursor = execute(conn, "SELECT id FROM projects")

        for row in fetchall(cursor):
            project = db_get_project(row["id"])
            if project:
                projects[project["id"]] = project

    return projects


def load_all_tasks_to_memory() -> Dict[str, dict]:
    """Load all tasks from database into memory for fast access."""
    from .tasks import db_get_task
    from .engine import execute, fetchall

    tasks = {}

    with get_db() as conn:
        cursor = execute(conn, "SELECT id FROM tasks")

        for row in fetchall(cursor):
            task = db_get_task(row["id"])
            if task:
                tasks[task["id"]] = task

    return tasks


# Initialize database on module import
init_database()
