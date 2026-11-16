"""push_subscriptions: the browsers and installed web apps that asked for push notifications.

One row per browser (``endpoint`` is the push service's address for it and is unique). The row belongs
to the user who last enabled notifications there, so a shared device notifies its current user only.
"""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL UNIQUE,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            user_agent TEXT,
            created_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)")
