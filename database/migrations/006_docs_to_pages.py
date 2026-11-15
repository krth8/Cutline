"""Docs move into Pages: every doc folder and document becomes a page (PLAN.md P7).

The old tables stay as they are; P8 drops them once the result has been checked on real data.
The copy itself is database/docs_to_pages.py.
"""

from database.docs_to_pages import copy_docs_to_pages


def up(conn):
    copy_docs_to_pages(conn)
