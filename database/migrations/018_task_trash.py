"""Task trash (PLAN.md H3): tasks.deleted_at and tasks.deleted_by.

A deleted task keeps its row (and so its checklist, comments, clip links, custom values, page and
comment link) until it is deleted for good. Everything deleted in one action carries the same
deleted_at, so restoring a parent brings back exactly the subtasks that went with it.

The unique index on tasks.comment_id only covers live tasks: a comment whose task is in the trash is
free again, so a new task can be made from it.
"""

from database.engine import add_column_if_not_exists, execute


def up(conn):
    add_column_if_not_exists(conn, "tasks", "deleted_at", "TEXT")
    add_column_if_not_exists(conn, "tasks", "deleted_by", "TEXT")
    execute(conn, "DROP INDEX IF EXISTS idx_tasks_comment_id")
    execute(conn, "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_comment_id ON tasks(comment_id) "
                  "WHERE deleted_at IS NULL")
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_tasks_deleted_at ON tasks(deleted_at)")
