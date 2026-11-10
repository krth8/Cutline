"""
Cache module for in-memory data management with periodic persistence.
"""

from .manager import cache_manager, CacheManager

__all__ = ['cache_manager', 'CacheManager']
