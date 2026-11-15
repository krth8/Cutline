/**
 * Images and files in pages: registers the `file` block, the upload plugin (paste and drop) and the
 * `/image` and `/file` slash entries. The `image` node itself is part of the base schema
 * (extensions/image.ts re-exports the one from ./image).
 */
import type { Editor, Range } from '@tiptap/core';
import { registerBlock, registerSlashItem } from '../registry';
import { FileNode } from './file';
import { INLINE_IMAGE_TYPES } from './pageFiles';
import './viewBlock'; // the view block (its node lives in this chunk, its content in the main bundle)
import './summary'; // the summary block and the inline number (same split as the view block)
import './clipEmbed'; // the clip block (same split)
import { PageFileUploads, pickFiles, startUpload } from './uploads';

/** Remove the typed "/query", open the file picker and upload what was chosen at that place. */
function pickAndUpload(accept: string) {
  return (editor: Editor, range: Range) => {
    editor.chain().focus().deleteRange(range).run();
    const at = range.from;
    void pickFiles(accept).then((files) => {
      for (const file of files) void startUpload(editor, file, at);
    });
  };
}

registerBlock({ name: 'file', node: FileNode });
registerBlock({ name: 'pageFileUploads', node: PageFileUploads });

registerSlashItem({
  id: 'image-upload',
  title: 'Image',
  description: 'Upload a picture',
  icon: '🖼',
  keywords: ['picture', 'photo', 'upload', 'img'],
  group: 'Media',
  run: pickAndUpload(INLINE_IMAGE_TYPES.join(',')),
});
registerSlashItem({
  id: 'file-upload',
  title: 'File',
  description: 'Attach a file',
  icon: '📎',
  keywords: ['attachment', 'upload', 'document', 'pdf'],
  group: 'Media',
  run: pickAndUpload(''),
});

export { startUpload, nodeForFile } from './uploads';
export { setEditorPageId, getEditorPageId } from './pageFiles';
