"""users.home_page_id: the personal page a user opens as Home (S4). NULL means none chosen yet."""

from database.engine import add_column_if_not_exists


def up(conn):
    add_column_if_not_exists(conn, "users", "home_page_id", "TEXT")
