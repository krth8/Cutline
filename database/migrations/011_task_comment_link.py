"""tasks.comment_id and tasks.clip_frame: a task made from a review comment (PLAN.md S6).

comment_id is the id of the review comment the task was made from (one task per comment, enforced
by the unique index); clip_frame is the frame of that comment, so the task's clip link can open the
review at that frame. Both are NULL for every other task.
"""

from database.engine import add_column_if_not_exists, execute


def up(conn):
    add_column_if_not_exists(conn, "tasks", "comment_id", "TEXT")
    add_column_if_not_exists(conn, "tasks", "clip_frame", "INTEGER")
    execute(conn, "CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_comment_id ON tasks(comment_id)")
