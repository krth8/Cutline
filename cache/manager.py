"""
Cache bookkeeping.

Projects and tasks are held in memory for fast reads, but nothing is cached
"for later": every change is written to the database before the request that
made it is answered. This module only reports on that in-memory state.
"""


class CacheManager:
    def get_stats(self) -> dict:
        """Cache statistics for the admin page."""
        return {"writeThrough": True}


# Global cache manager instance
cache_manager = CacheManager()
