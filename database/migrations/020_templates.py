"""templates: frozen copies of pages that can be used to create new pages (PLAN.md H4).

``bundle`` is the serialised page tree (JSON: pages with their Yjs documents, views, custom table
schemas and the list of files); the files themselves live on disk under UPLOAD_DIR/templates/<id>.
``scope`` is 'personal' (only ``owner_id`` sees it) or 'workspace' (everyone). Built-in templates are
defined in code and have no row here.
"""

from database.engine import execute


def up(conn):
    execute(conn, """
        CREATE TABLE IF NOT EXISTS templates (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
            owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
            page_count INTEGER NOT NULL DEFAULT 1,
            bundle TEXT NOT NULL,
            created_at TEXT NOT NULL
        )
    """)
    execute(conn, "CREATE INDEX IF NOT EXISTS idx_templates_owner ON templates(owner_id)")
