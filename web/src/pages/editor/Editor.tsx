import { useEffect, useMemo } from 'react';
import { EditorContent, useEditor, type Editor as TiptapEditor } from '@tiptap/react';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { BlockHandle } from './BlockHandle';
import { SlashMenu } from './SlashMenu';
import { Toolbar } from './Toolbar';
import { buildExtensions, type EditorUser } from './buildExtensions';
import { SlashStore } from './extensions/slash';
import './editor.css';

export interface EditorProps {
  /** The document. Content lives in its XmlFragment "default". */
  doc: Y.Doc;
  /** Presence (cursors and selections of other people). Without it no carets are shown. */
  awareness?: Awareness;
  user: EditorUser;
  editable: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  onReady?(editor: TiptapEditor): void;
}

/**
 * The page editor: a Tiptap editor bound to a Y.Doc. Blocks registered through
 * `registerBlock` before this mounts are part of its schema.
 */
export function Editor({ doc, awareness, user, editable, placeholder, autoFocus, onReady }: EditorProps) {
  const slashStore = useMemo(() => new SlashStore(), [doc]);
  const extensions = useMemo(
    () => buildExtensions({ doc, awareness, user, placeholder, slashStore }),
    // The user object may be re-created by the parent on every render: depend on its fields
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, awareness, user.id, user.name, user.color, placeholder, slashStore],
  );

  const editor = useEditor(
    {
      extensions,
      editable,
      autofocus: autoFocus ? 'end' : false,
      editorProps: {
        attributes: { class: 'cl-editor__prose', role: 'textbox', 'aria-multiline': 'true', 'aria-label': 'Page content' },
      },
    },
    [extensions],
  );

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  useEffect(() => {
    if (editor) onReady?.(editor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  return (
    <div className="cl-editor" data-editable={editable ? 'true' : 'false'}>
      <EditorContent editor={editor} />
      {editor && editable && <BlockHandle editor={editor} />}
      {editor && <Toolbar editor={editor} />}
      <SlashMenu store={slashStore} />
    </div>
  );
}
