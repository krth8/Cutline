import { visibleColumns } from '../../viewColumns';
import type { Column, TableSchema, View } from '../../types';
import { coverColumnsOf, type CoverChoice } from '../cover';

export type GallerySize = 'small' | 'medium' | 'large';
export type GalleryFit = 'cover' | 'contain';

/** The `gallery` part of a view's config. */
export interface GalleryConfig {
  /** Fields under the title, in order; empty means "the visible columns of the view". */
  cardColumns: string[];
  /** Where the picture comes from: 'auto' (an image, else the clip's frame), 'none', or one column. */
  cover: CoverChoice;
  size: GallerySize;
  /** Crop the picture to fill the card, or show all of it. */
  fit: GalleryFit;
}

const SIZES: GallerySize[] = ['small', 'medium', 'large'];

/** The smallest width of a card per size (the grid fits as many as the width allows). */
export const CARD_MIN_WIDTH: Record<GallerySize, number> = { small: 160, medium: 220, large: 300 };

export function readGalleryConfig(config: View['config']): GalleryConfig {
  const raw = (config.gallery ?? {}) as Partial<GalleryConfig>;
  return {
    cardColumns: Array.isArray(raw.cardColumns) ? raw.cardColumns.filter((k): k is string => typeof k === 'string') : [],
    cover: typeof raw.cover === 'string' && raw.cover ? raw.cover : 'auto',
    size: SIZES.includes(raw.size as GallerySize) ? (raw.size as GallerySize) : 'medium',
    fit: raw.fit === 'contain' ? 'contain' : 'cover',
  };
}

/**
 * The fields a card shows under its title. Chosen ones in their order; without a choice the visible columns of the
 * view, leaving out the title, the picture columns (the picture is already on top) and read-only bookkeeping.
 */
export function galleryFieldsOf(schema: TableSchema, config: View['config']): Column[] {
  const gallery = readGalleryConfig(config);
  const byKey = new Map(schema.columns.map((c) => [c.key, c]));
  if (gallery.cardColumns.length) {
    return gallery.cardColumns.map((k) => byKey.get(k)).filter((c): c is Column => !!c && c.key !== schema.titleColumn);
  }
  const pictures = new Set(coverColumnsOf(schema.columns).map((c) => c.key));
  return visibleColumns(schema, config).filter((c) => c.key !== schema.titleColumn && !pictures.has(c.key) && !c.readonly);
}
