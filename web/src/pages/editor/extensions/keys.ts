import { Extension, getMarkRange } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';

/** Fired on the editor's DOM element when Ctrl/Cmd+K asks the toolbar to open its link field. */
export const OPEN_LINK_EVENT = 'cl-editor-open-link';

/** Keyboard behaviour that the stock extensions do not have. */
export const EditorKeys = Extension.create({
  name: 'clEditorKeys',

  addKeyboardShortcuts() {
    return {
      // Backspace at the start of a heading, quote or callout turns it into a paragraph
      Backspace: ({ editor }) => {
        const { selection } = editor.state;
        if (!selection.empty || !(selection instanceof TextSelection)) return false;
        const { $from } = selection;
        if ($from.parentOffset !== 0) return false;
        if ($from.parent.type.name === 'heading') return editor.commands.setNode('paragraph');
        for (let depth = $from.depth - 1; depth > 0; depth--) {
          const name = $from.node(depth).type.name;
          if ((name === 'blockquote' || name === 'callout') && $from.index(depth) === 0) {
            return editor.commands.lift(name);
          }
          if (name === 'listItem' || name === 'taskItem') return false;
        }
        return false;
      },

      'Mod-k': ({ editor }) => {
        if (!editor.isEditable || editor.isActive('codeBlock')) return false;
        const { state } = editor;
        if (state.selection.empty) {
          // Inside an existing link: select it so the toolbar can edit it
          const range = getMarkRange(state.selection.$from, state.schema.marks.link!);
          if (!range) return false;
          editor.commands.setTextSelection(range);
        }
        editor.view.dom.dispatchEvent(new CustomEvent(OPEN_LINK_EVENT));
        return true;
      },
    };
  },
});
