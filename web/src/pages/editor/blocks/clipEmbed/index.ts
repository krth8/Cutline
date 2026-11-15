/**
 * The clip block: shows one clip of a project (thumbnail, version, status, comments) inside a page and opens
 * the review at the clip, and at a frame when one is stored. Importing this file registers the block and its
 * `/clip` slash entry. It is imported by the editor chunk through blocks/index.ts.
 */
import { registerBlock } from '../../registry';
import { ClipEmbed } from './clipEmbedNode';
import * as host from './host';
import { CLIP_EMBED } from './model';

export { ClipEmbed } from './clipEmbedNode';
export { CLIP_EMBED } from './model';

registerBlock({
  name: CLIP_EMBED,
  node: ClipEmbed,
  slash: {
    id: 'clip-embed',
    title: 'Clip',
    description: 'Show a clip and open its review',
    icon: '🎬',
    keywords: ['clip', 'video', 'review', 'shot', 'embed', 'thumbnail'],
    group: 'Media',
    run: (editor, range) => {
      // The new block opens the clip picker in this browser only
      host.markFreshClipBlock();
      editor.chain().focus().deleteRange(range).insertContent({ type: CLIP_EMBED, attrs: { projectId: null, baseName: null } }).run();
    },
  },
});
