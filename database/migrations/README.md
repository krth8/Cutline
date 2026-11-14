# Database migrations

Schema changes made after the baseline go here, not into `database/engine.py` (do not edit
`engine.py`). `database/migrate.py` applies pending migrations at startup, after `init_schema`.

## Adding a migration

1. Create `database/migrations/NNN_short_name.py`, where NNN is the next free 3-digit number
   (`002_add_pages_table.py`). Numbers are applied in numeric order. If two branches pick the
   same number, rename yours when merging; duplicates stop startup.
2. Define `up(conn)`. It runs in its own transaction: if it raises, everything it did is rolled
   back and startup stops with a clear error. Do not commit or roll back yourself.
3. Never edit a migration that has been merged; add a new one.

## Helpers (import from `database.engine`, they work on SQLite and PostgreSQL)

- `execute(conn, sql, params)` with `?` placeholders (converted to `%s` for PostgreSQL)
- `fetchall(cursor)`, `fetchone(cursor)`
- `table_exists(conn, table)`, `column_exists(conn, table, column)`
- `add_column_if_not_exists(conn, table, column, "TYPE DEFAULT ...")`
- `insert_ignore(conn, table, columns, values, conflict_columns)`
- `DB_TYPE` / `DatabaseType` when SQL really differs between the two databases

Write portable SQL: `TEXT` ids and timestamps, `INTEGER` flags, `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`. Avoid SQLite-only features (`AUTOINCREMENT`, `PRAGMA`) unless
guarded by `DB_TYPE`.

```python
from database.engine import execute, add_column_if_not_exists


def up(conn):
    execute(conn, "CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT NOT NULL)")
    add_column_if_not_exists(conn, "projects", "page_id", "TEXT")
```
