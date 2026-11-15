/**
 * What the palette shows for an empty query: the items the user opened from it and their last searches.
 * Kept in localStorage per user; every access is wrapped because storage can be blocked or full.
 */
import type { SearchItem } from './api';

const MAX_ITEMS = 6;
const MAX_QUERIES = 5;

export interface Recent {
  items: SearchItem[];
  queries: string[];
}

const keyOf = (userId: string) => `cl-search-recent:${userId}`;

export function loadRecent(userId: string): Recent {
  try {
    const raw = localStorage.getItem(keyOf(userId));
    if (!raw) return { items: [], queries: [] };
    const data = JSON.parse(raw) as Partial<Recent>;
    return {
      items: Array.isArray(data.items) ? data.items.filter((i) => i && typeof i.route === 'string' && typeof i.title === 'string').slice(0, MAX_ITEMS) : [],
      queries: Array.isArray(data.queries) ? data.queries.filter((q) => typeof q === 'string').slice(0, MAX_QUERIES) : [],
    };
  } catch {
    return { items: [], queries: [] };
  }
}

function save(userId: string, recent: Recent): void {
  try {
    localStorage.setItem(keyOf(userId), JSON.stringify(recent));
  } catch {
    /* storage unavailable: recents are just not remembered */
  }
}

/** Remember an opened item (moved to the front) and the search that found it. */
export function rememberOpened(userId: string, item: SearchItem, query: string): void {
  const recent = loadRecent(userId);
  const items = [item, ...recent.items.filter((i) => !(i.type === item.type && i.id === item.id))].slice(0, MAX_ITEMS);
  const text = query.trim();
  const queries = text && !text.startsWith('>') ? [text, ...recent.queries.filter((q) => q !== text)].slice(0, MAX_QUERIES) : recent.queries;
  save(userId, { items, queries });
}

export function clearRecent(userId: string): void {
  save(userId, { items: [], queries: [] });
}
