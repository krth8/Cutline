import type { SlashItem } from './registry';

/** Score of `query` against one string: higher is better, 0 means no match. */
function scoreText(text: string, query: string): number {
  const t = text.toLowerCase();
  if (t === query) return 100;
  if (t.startsWith(query)) return 80;
  if (t.split(/[\s-]+/).some((w) => w.startsWith(query))) return 60;
  if (t.includes(query)) return 40;
  // Fuzzy: every query letter appears in order ("h1" in "heading 1", "tdl" in "to-do list")
  let at = 0;
  for (const ch of query) {
    at = t.indexOf(ch, at);
    if (at < 0) return 0;
    at++;
  }
  return 10;
}

/** Items matching `query` (title weighs more than keywords), best first; an empty query keeps the order. */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items
    .map((item, index) => {
      const title = scoreText(item.title, q);
      const keyword = Math.max(0, ...item.keywords.map((k) => scoreText(k, q) * 0.8));
      return { item, index, score: Math.max(title * 1.2, keyword) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((r) => r.item);
}
