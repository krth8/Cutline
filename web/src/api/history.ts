/** Typed client for the page history endpoints (versions of a page). */
import { requestJson } from './http';

export type VersionKind = 'auto' | 'named' | 'before_restore';

export interface VersionPerson {
  id: string;
  name: string;
}

export interface PageVersion {
  id: string;
  pageId: string;
  kind: VersionKind;
  /** Null for an automatic version nobody named. */
  name: string | null;
  createdAt: string;
  createdBy: VersionPerson | null;
  /** The people who edited between the previous version and this one. */
  editors: VersionPerson[];
  textLength: number;
  excerpt: string;
}

export interface PageVersionWithState extends PageVersion {
  /** The encoded Yjs document, base64. */
  state: string;
}

const base = (pageId: string) => `/api/pages/${encodeURIComponent(pageId)}/versions`;

export const listVersions = (pageId: string) => requestJson<PageVersion[]>('GET', base(pageId));

export const getVersion = (pageId: string, versionId: string) =>
  requestJson<PageVersionWithState>('GET', `${base(pageId)}/${encodeURIComponent(versionId)}`);

export const createVersion = (pageId: string, name: string) => requestJson<PageVersion>('POST', base(pageId), { name });

export const renameVersion = (pageId: string, versionId: string, name: string) =>
  requestJson<PageVersion>('PATCH', `${base(pageId)}/${encodeURIComponent(versionId)}`, { name });

export const deleteVersion = (pageId: string, versionId: string) =>
  requestJson<null>('DELETE', `${base(pageId)}/${encodeURIComponent(versionId)}`);

export const restoreVersion = (pageId: string, versionId: string) =>
  requestJson<{ ok: boolean }>('POST', `${base(pageId)}/${encodeURIComponent(versionId)}/restore`);

/** Decode the base64 `state` of a version into bytes for `Y.applyUpdate`. */
export function stateBytes(state: string): Uint8Array {
  const binary = atob(state);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
