"""activity: what happened in a project (the Activity panel of the Home tab).

One row per event: a task made or changed, a page made, a review comment. ``involves`` holds the ids of the
people the event concerns besides the actor (assignees, the author of the comment that was answered, people
who were tagged), written as ``,id,id,`` so one person can be found with LIKE.
"""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS activity (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            actor_id TEXT,
            actor_name TEXT,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            detail TEXT,
            link TEXT,
            involves TEXT NOT NULL DEFAULT ',',
            created_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id, created_at)")
