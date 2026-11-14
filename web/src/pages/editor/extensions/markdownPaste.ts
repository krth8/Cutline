import { Extension, type JSONContent } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';

const URL_ONLY = /^(https?:\/\/|mailto:)\S+$/i;

// A line that starts a block ("# ", "- ", "1. ", "> ", a fence, a rule) ...
const BLOCK_MARKER = /^(\s{0,3})(#{1,6}\s+\S|[-*+]\s+\S|\d+[.)]\s+\S|>\s?\S|```|~~~|(-{3,}|\*{3,}|_{3,})\s*$)/m;
// ... or inline syntax: **bold**, ~~strike~~, `code`, [text](url), *italic*
const INLINE_MARKER = /\*\*[^*\n]+\*\*|~~[^~\n]+~~|`[^`\n]+`|\[[^\]\n]+\]\([^)\s]+\)|(^|\s)\*[^*\s][^*\n]*\*(\s|$)/;

/** True when plain text reads like Markdown rather than prose. */
export function looksLikeMarkdown(text: string): boolean {
  if (!text.trim() || URL_ONLY.test(text.trim())) return false;
  return BLOCK_MARKER.test(text) || INLINE_MARKER.test(text);
}

/** Html that only wraps plain text (what some apps put on the clipboard next to the text). */
function isPlainWrapper(html: string): boolean {
  return !/<(h[1-6]|ul|ol|li|blockquote|pre|table|a|strong|b|em|i|u|s|del|code|img|hr)[\s>/]/i.test(html);
}

/**
 * Paste of Markdown text converts to nodes. HTML on the clipboard is left to the
 * schema parse rules (structure kept, styles dropped); a URL pasted over a
 * selection is handled by the link extension.
 */
export const MarkdownPaste = Extension.create({
  name: 'clMarkdownPaste',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key: new PluginKey('clMarkdownPaste'),
        props: {
          handlePaste(view, event) {
            const data = event.clipboardData;
            if (!data || !view.editable) return false;
            const text = data.getData('text/plain');
            const html = data.getData('text/html');
            if (view.state.selection.$from.parent.type.spec.code) return false; // plain text in code blocks
            if (data.getData('vscode-editor-data')) return false;
            if (html && !isPlainWrapper(html)) return false;
            if (!looksLikeMarkdown(text) || !editor.markdown) return false;
            let json: JSONContent;
            try {
              json = editor.markdown.parse(text);
            } catch {
              return false;
            }
            if (!json.content?.length) return false;
            const { from, to } = view.state.selection;
            editor.chain().insertContentAt({ from, to }, json.content, { updateSelection: true }).run();
            return true;
          },
        },
      }),
    ];
  },
});
