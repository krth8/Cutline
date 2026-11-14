# Page editor

A Tiptap 3 editor bound to a Yjs document. It does no networking: it gets a
`Y.Doc` (and optionally an `Awareness`) as props; the collaboration provider is a
separate package.

```tsx
import { Editor } from './pages/editor';

<Editor
  doc={ydoc}                // content lives in the XmlFragment "default" (the server reads that name)
  awareness={awareness}     // optional: remote carets and selections
  user={{ id, name, color }}
  editable={canEdit}
  placeholder="Type '/' for blocks"
  autoFocus
  onReady={(editor) => { /* Tiptap Editor instance */ }}
/>
```

Undo and redo come from the Yjs binding: they only undo the local user's changes.
Tiptap's own history extension is switched off.

## What is in the base schema

Paragraph, headings 1 to 3, bullet / ordered / task lists (nested), blockquote,
code block, horizontal rule, image (node only: `src`, `alt`, `width`), hard break,
`callout` (attr `tone`: `info`, `success`, `warning`, `danger`); marks bold, italic,
underline, strike, code, link, highlight.

Markdown input rules (`#`, `-`, `1.`, `[ ]`, `>`, ` ``` `, `---`, `!>` for a callout,
`**bold**`, `*italic*`, `~~strike~~`, `` `code` ``), Markdown and HTML paste, slash
menu (`/`), floating toolbar (Ctrl/Cmd+K for links), drag handle, Tab / Shift+Tab in
lists, Mod+Alt+1..3 headings, Mod+Shift+7/8/9 lists.

## Block registry

Other work packages add blocks without editing this folder.

```ts
registerBlock({ name, node, slash?, shortcuts? }): () => void   // returns an "unregister" function
registerSlashItem(item): () => void                            // a slash entry without a node

interface SlashItem {
  id?: string;                       // defaults to title; same id replaces the entry
  title: string;
  description: string;
  icon?: string;                     // short text or emoji
  keywords: string[];                // fuzzy-matched together with the title
  group: string;                     // heading in the menu ("Basic", "Lists", "Advanced", "Media", ...)
  run(editor: Editor, range: Range): void;   // must delete `range` (the typed "/query")
}
```

Rules:

- Register at module load, before an editor mounts. The extension list is built when
  the editor is created; slash items are read every time the menu opens.
- `name` is the node name in the Y.Doc (the `XmlElement` name), so it is part of the
  document contract (PLAN.md 5.8). Attributes must be plain JSON values.
- `shortcuts` use Tiptap key notation (`Mod-Alt-9`); return `true` when handled.

### Example: a block with a React node view

```tsx
import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { registerBlock } from '../pages/editor';

function ViewBlockView({ node, editor, updateAttributes }: NodeViewProps) {
  return (
    // NodeViewWrapper is the root of every node view; contentEditable={false} keeps the
    // browser from putting a caret inside an atom.
    <NodeViewWrapper className="my-view-block" contentEditable={false}>
      <strong>View {String(node.attrs.viewId)}</strong>
      {editor.isEditable && (
        <button type="button" onClick={() => updateAttributes({ viewId: 'other' })}>
          Change
        </button>
      )}
    </NodeViewWrapper>
  );
}

const ViewBlock = Node.create({
  name: 'viewBlock',
  group: 'block',
  atom: true,            // a leaf block with no editable content
  draggable: true,       // can be moved with the drag handle
  addAttributes() {
    return { viewId: { default: null } };
  },
  parseHTML: () => [{ tag: 'div[data-view-block]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-view-block': '', ...HTMLAttributes }],
  addNodeView: () => ReactNodeViewRenderer(ViewBlockView),
});

registerBlock({
  name: 'viewBlock',
  node: ViewBlock,
  slash: {
    title: 'View',
    description: 'Show tasks as a table, board or calendar',
    icon: '▦',
    keywords: ['table', 'board', 'tasks', 'kanban'],
    group: 'Advanced',
    run: (editor, range) => {
      editor.chain().focus().deleteRange(range).insertContent({ type: 'viewBlock', attrs: { viewId: null } }).run();
    },
  },
  shortcuts: { 'Mod-Alt-v': (editor) => editor.commands.insertContent({ type: 'viewBlock' }) },
});
```

For a block with editable content use `content: 'block+'` (or `'inline*'`) and render
`<NodeViewContent />` inside the wrapper; see `extensions/callout.tsx`.

## Blocks the editor does not know

If the document holds an element whose node type is not registered (a block from a
newer client, or from a package that is not loaded), the editor adds a placeholder
node of the same name and attributes. It shows "Unsupported block (name)" and keeps the
data as it was; it is never dropped. This is decided when the editor is created: a
type that only appears later through a remote update is still dropped by the Yjs
binding, so make sure every package that can write a block registers it first.

## Testing helpers

`testing/linkedProvider.ts` links several `Y.Doc`s and awareness instances in memory
(`new LinkedNetwork(delayMs).join()`, `peer.setOnline(false)`). `testing/EditorDemo.tsx`
shows two editors side by side on linked docs, with toggles for editable, offline and delay.
`testing/helpers.tsx` has `mountEditor`, `typeText` (goes through the input-rule handlers),
`pressKey` and `paste` for vitest. `web/dev/check_editor.py` drives the demo in a real browser.
