import { registerLayout } from '../registry';
import { GalleryLayout } from './GalleryLayout';

registerLayout('gallery', GalleryLayout, { gallery: { cardColumns: [], cover: 'auto', size: 'medium', fit: 'cover' } }, 'Gallery');

export { GalleryLayout };
