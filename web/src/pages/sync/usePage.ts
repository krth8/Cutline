import { useEffect, useState } from 'react';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { getPage, PageApiError, type PageInfo } from '../../api/pages';
import { getPlatform } from '../../platform';
import { importLegacyIfNeeded } from './legacyImport';
import { PageProvider, type PageProviderOptions, type PageStatus } from './PageProvider';

export interface UsePage {
  /** The page record; null until it is loaded (or when it is not available). */
  page: PageInfo | null;
  doc: Y.Doc | null;
  awareness: Awareness | null;
  provider: PageProvider | null;
  status: PageStatus;
  /** The person may type: the page says so, the server did not switch the socket to read-only, and it exists. */
  editable: boolean;
  /** True once the first sync is done: the editor may start (it must see the whole document). */
  ready: boolean;
  error: Error | null;
  /** The name and colour shown to others (the caret label). */
  user: { id: string; name: string; color: string };
}

const COLORS = [
  '#e8590c',
  '#1c7ed6',
  '#2f9e44',
  '#ae3ec9',
  '#d6336c',
  '#0c8599',
  '#f08c00',
  '#5f3dc4',
  '#c92a2a',
  '#087f5b',
];

/** A colour that stays the same for a user id, on every device. */
export function userColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

interface Live {
  page: PageInfo | null;
  doc: Y.Doc;
  awareness: Awareness;
  provider: PageProvider;
  ready: boolean;
  error: Error | null;
}

const NO_USER = { id: 'anonymous', username: 'Someone' };

/**
 * Everything a page needs to be edited together: the page record, a Y.Doc, its awareness and the
 * provider that connects them. Created for `pageId` and destroyed with the component or when the id changes.
 */
export function usePage(pageId: string, providerOptions: Partial<PageProviderOptions> = {}): UsePage {
  const platformUser = getPlatform().user() ?? NO_USER;
  const user = { id: platformUser.id, name: platformUser.username, color: userColor(platformUser.id) };

  const [live, setLive] = useState<Live | null>(null);
  const [status, setStatus] = useState<PageStatus>('connecting');
  const [, setReadonlyTick] = useState(0);

  useEffect(() => {
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    awareness.setLocalStateField('user', { name: user.name, color: user.color, id: user.id });
    const provider = new PageProvider({ pageId, doc, awareness, ...providerOptions });
    const state: Live = { page: null, doc, awareness, provider, ready: false, error: null };
    let cancelled = false;
    const update = (patch: Partial<Live>) => {
      if (cancelled) return;
      Object.assign(state, patch);
      setLive({ ...state });
    };

    setLive({ ...state });
    setStatus(provider.status);
    const off = provider.onStatus((s) => {
      if (cancelled) return;
      setStatus(s);
      setReadonlyTick((n) => n + 1);
    });

    provider.whenSynced().then(
      () => update({ ready: true }),
      () => undefined, // gone or destroyed: the status says it
    );

    getPage(pageId).then(
      (page) => {
        update({ page });
        importLegacyIfNeeded(page, doc, provider).catch((e) => {
          console.error('Legacy import failed', e);
          getPlatform().toast('error', 'Could not import the old document content');
        });
      },
      (e: unknown) => {
        // 403 and 404 both mean "not available" (the socket closes with 4403 for the same reason)
        if (e instanceof PageApiError && (e.status === 403 || e.status === 404)) update({ error: e });
        else update({ error: e instanceof Error ? e : new Error(String(e)) });
      },
    );

    return () => {
      cancelled = true;
      off();
      provider.destroy();
      awareness.destroy();
      doc.destroy();
    };
    // The options are for tests; the provider is tied to the page id only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId, user.id, user.name]);

  // Right after a change of pageId `live` still belongs to the previous page
  const current = live && live.provider.pageId === pageId ? live : null;
  const notAvailable =
    current?.error instanceof PageApiError && (current.error.status === 403 || current.error.status === 404);
  const effectiveStatus: PageStatus = notAvailable ? 'gone' : current ? status : 'connecting';
  const provider = current?.provider ?? null;
  const editable =
    !!current?.page?.canEdit && !provider?.readonly && effectiveStatus !== 'gone' && effectiveStatus !== 'error';

  return {
    page: current?.page ?? null,
    doc: current?.doc ?? null,
    awareness: current?.awareness ?? null,
    provider,
    status: effectiveStatus,
    editable,
    ready: current?.ready ?? false,
    error: current?.error ?? provider?.error ?? null,
    user,
  };
}
