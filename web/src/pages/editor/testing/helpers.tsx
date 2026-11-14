import { act, render } from '@testing-library/react';
import type { Editor as TiptapEditor, JSONContent } from '@tiptap/core';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { Editor } from '../Editor';

// jsdom has no layout: give ranges and elements empty geometry so ProseMirror can ask for coordinates
const rangeProto = Range.prototype as unknown as Record<string, unknown>;
if (!rangeProto.getClientRects) rangeProto.getClientRects = () => [];
if (!rangeProto.getBoundingClientRect) rangeProto.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
if (!document.elementFromPoint) document.elementFromPoint = () => null;

export interface Mounted {
  editor: TiptapEditor;
  doc: Y.Doc;
  awareness: Awareness;
  unmount(): void;
}

const USER = { id: 'u1', name: 'Ada', color: '#e8590c' };

/** Render an Editor on `doc` and wait until Tiptap hands back the instance. */
export async function mountEditor(
  opts: { doc?: Y.Doc; editable?: boolean; user?: typeof USER; awareness?: Awareness } = {},
): Promise<Mounted> {
  const doc = opts.doc ?? new Y.Doc();
  const awareness = opts.awareness ?? new Awareness(doc);
  let editor: TiptapEditor | null = null;
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Editor
        doc={doc}
        awareness={awareness}
        user={opts.user ?? USER}
        editable={opts.editable ?? true}
        onReady={(e) => {
          editor = e;
        }}
      />,
    );
  });
  if (!editor) throw new Error('editor did not start');
  return { editor, doc, awareness, unmount: () => result.unmount() };
}

/** Type like a keyboard does: each character goes through the text-input handlers (input rules), then into the doc. */
export function typeText(editor: TiptapEditor, text: string) {
  const view = editor.view;
  for (const ch of text) {
    const { from, to } = view.state.selection;
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch, () => view.state.tr.insertText(ch, from, to)));
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to));
  }
}

/** Press a key through the keymap handlers (Enter, Tab, Backspace, Mod-Alt-1 ...). */
export function pressKey(editor: TiptapEditor, key: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', {
    key,
    code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    metaKey: mods.meta ?? false,
    bubbles: true,
    cancelable: true,
  });
  const view = editor.view;
  return view.someProp('handleKeyDown', (f) => f(view, event)) === true;
}

/** Dispatch a paste event with the given clipboard flavours. */
export function paste(editor: TiptapEditor, data: { text?: string; html?: string }) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type: string) => (type === 'text/plain' ? data.text ?? '' : type === 'text/html' ? data.html ?? '' : ''), types: [] },
  });
  editor.view.dom.dispatchEvent(event);
}

/** Replace the content with the given block JSON and put the cursor at the end. */
export function setContent(editor: TiptapEditor, content: JSONContent[]) {
  editor.commands.setContent({ type: 'doc', content });
  editor.commands.focus('end');
}

/** Compact description of the document: "heading1(Hello) | paragraph(text)" style, for readable assertions. */
export function outline(node: JSONContent): string {
  const text = (n: JSONContent): string =>
    n.type === 'text' ? `${(n.marks ?? []).map((m) => `<${m.type}>`).join('')}${n.text}` : (n.content ?? []).map(text).join('');
  const one = (n: JSONContent): string => {
    const kids = n.content ?? [];
    const label = n.type === 'heading' ? `h${n.attrs?.level}` : n.type!;
    const inner = kids.some((k) => k.type !== 'text' && k.type !== 'hardBreak') ? kids.map(one).join(' ') : text(n);
    return `${label}(${inner})`;
  };
  // The trailing-node extension keeps an empty paragraph at the end; it is not part of what a test cares about
  const blocks = [...(node.content ?? [])];
  const last = blocks[blocks.length - 1];
  if (blocks.length > 1 && last?.type === 'paragraph' && !last.content?.length) blocks.pop();
  return blocks.map(one).join(' ');
}
