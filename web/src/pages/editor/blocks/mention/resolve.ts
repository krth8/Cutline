/**
 * Current names for chips. Asks the server in batches (one request for all chips that appear in the same
 * moment) and remembers the answers for a short time. Runs in the main bundle.
 */
import { getPlatform } from '../../../../platform';
import type { MentionKind, ResolvedMention } from './model';

const TTL_MS = 30_000;
const SEP = '|';
const cache = new Map<string, { value: ResolvedMention; at: number }>();
const waiting = new Map<string, Array<(value: ResolvedMention | null) => void>>();
let timer: ReturnType<typeof setTimeout> | null = null;

const keyOf = (kind: MentionKind, id: string) => `${kind}${SEP}${id}`;

export function clearMentionCache(): void {
  cache.clear();
}

/** The answer already known for a chip (null when unknown yet). */
export function cachedMention(kind: MentionKind, id: string): ResolvedMention | null {
  const hit = cache.get(keyOf(kind, id));
  return hit && Date.now() - hit.at < TTL_MS ? hit.value : null;
}

async function flush(): Promise<void> {
  timer = null;
  const batch = [...waiting.entries()];
  waiting.clear();
  if (!batch.length) return;
  const items = batch.map(([key]) => {
    const at = key.indexOf(SEP);
    return { kind: key.slice(0, at), id: key.slice(at + 1) };
  });
  const answers = new Map<string, ResolvedMention>();
  try {
    for (let i = 0; i < items.length; i += 200) {
      const res = await getPlatform().fetch('/api/mentions/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: items.slice(i, i + 200) }),
      });
      if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
      for (const entry of ((await res.json()) as { items: ResolvedMention[] }).items) answers.set(keyOf(entry.kind, entry.id), entry);
    }
  } catch {
    /* unreachable server: chips keep their stored label, and ask again next time */
  }
  for (const [key, callbacks] of batch) {
    const value = answers.get(key) ?? null;
    if (value) cache.set(key, { value, at: Date.now() });
    callbacks.forEach((fn) => fn(value));
  }
}

/** Resolve one target (batched with the others asked for in the same moment). Resolves null when the server could not be asked. */
export function resolveMention(kind: MentionKind, id: string): Promise<ResolvedMention | null> {
  const hit = cachedMention(kind, id);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve) => {
    const key = keyOf(kind, id);
    waiting.set(key, [...(waiting.get(key) ?? []), resolve]);
    if (!timer) timer = setTimeout(() => void flush(), 10);
  });
}
