/**
 * Plain logic of the clip block (no React, no Tiptap, no platform): what the node stores, the review link
 * a card opens and how a card labels its clip. Used by the node (editor chunk) and by the content (main bundle).
 */

/** The node name in the document (PLAN.md 5.8). */
export const CLIP_EMBED = 'clipEmbed';

/**
 * The attributes of the node. A clip is named by its project and base name (clips have no id of their own).
 * `version` and `frame` are optional: without a version the card follows the clip's active version.
 * An empty block (no clip chosen yet) has projectId and baseName null.
 */
export interface ClipEmbedAttrs {
  projectId: string | null;
  baseName: string | null;
  version: number | null;
  frame: number | null;
}

/** What `GET /api/projects/{id}/clips/{name}/summary` returns (api/routes/clips.py). */
export interface ClipSummary {
  projectId: string;
  baseName: string;
  version: number | null;
  versionStr: string | null;
  activeVersion: number | null;
  versionCount: number;
  /** File name under /thumbnail/, or null when the clip has none. */
  thumbnail: string | null;
  mediaType: string;
  status: { id: string; name: string; color: string } | null;
  commentCount: number;
}

/** A whole number >= 0, or null (attributes come from HTML attributes and pasted content, so they may be text). */
export function cleanCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** The review link of a card (PLAN.md 5.3): `/p/<project>/review?clip=<name>[&v=<version>][&frame=<n>]`. */
export function reviewLink(attrs: ClipEmbedAttrs): string {
  const params = new URLSearchParams({ clip: attrs.baseName ?? '' });
  if (attrs.version !== null) params.set('v', String(attrs.version));
  if (attrs.frame !== null) params.set('frame', String(attrs.frame));
  return `/p/${encodeURIComponent(attrs.projectId ?? '')}/review?${params.toString()}`;
}

/** The URL of a clip thumbnail (an `<img>` sends the login cookie). */
export function thumbnailSrc(file: string): string {
  return `/thumbnail/${encodeURIComponent(file)}`;
}

/** "v2" for a summary (the stored label when there is one). */
export function versionLabel(clip: Pick<ClipSummary, 'version' | 'versionStr'>): string {
  return clip.versionStr || (clip.version !== null ? `v${clip.version}` : '');
}

/** How the stored frame is shown on a card. */
export function frameLabel(frame: number | null): string {
  return frame === null ? '' : `Frame ${frame}`;
}

/** True once a block names a clip. */
export function hasClip(attrs: Pick<ClipEmbedAttrs, 'projectId' | 'baseName'>): attrs is { projectId: string; baseName: string } {
  return !!attrs.projectId && !!attrs.baseName;
}
