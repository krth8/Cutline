import { act, screen } from '@testing-library/react';
import { Node } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FRAGMENT_NAME } from './buildExtensions';
import { getRegisteredBlocks, getRegisteredSlashItems, registerBlock, registerSlashItem } from './registry';
import { mountEditor, outline, pressKey, typeText } from './testing/helpers';

const Widget = Node.create({
  name: 'testWidget',
  group: 'block',
  atom: true,
  addAttributes() {
    return { label: { default: 'none' } };
  },
  parseHTML: () => [{ tag: 'div[data-test-widget]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', { 'data-test-widget': '', ...HTMLAttributes }],
});

const cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn());
});

describe('block registry', () => {
  it('a registered block shows up in the slash menu, inserts, and round-trips through the Y.Doc', async () => {
    cleanup.push(
      registerBlock({
        name: 'testWidget',
        node: Widget,
        slash: {
          title: 'Test widget',
          description: 'A block from another package',
          keywords: ['gadget'],
          group: 'Extras',
          run: (editor, range) => {
            editor.chain().focus().deleteRange(range).insertContent({ type: 'testWidget', attrs: { label: 'hello' } }).run();
          },
        },
      }),
    );

    const m = await mountEditor();
    m.editor.commands.focus();
    await act(async () => typeText(m.editor, '/gadg'));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('Test widget')]);
    await act(async () => {
      pressKey(m.editor, 'Enter');
    });

    expect(outline(m.editor.getJSON())).toContain('testWidget');
    // The Y.Doc holds an element with the node name and the attribute
    const el = m.doc.getXmlFragment(FRAGMENT_NAME).toArray().find((n) => n instanceof Y.XmlElement && n.nodeName === 'testWidget') as Y.XmlElement;
    expect(el.getAttribute('label')).toBe('hello');

    // A second editor on a copy of the document renders the same block
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(m.doc));
    const other = await mountEditor({ doc: copy });
    expect(outline(other.editor.getJSON())).toContain('testWidget');
    expect(other.editor.getJSON().content?.find((n) => n.type === 'testWidget')?.attrs?.label).toBe('hello');
    other.unmount();
    m.unmount();
  });

  it('shows the slash entries of the base blocks and the registry together, without a node', async () => {
    cleanup.push(
      registerSlashItem({
        title: 'Insert sample',
        description: 'x',
        keywords: [],
        group: 'Extras',
        run: (editor, range) => editor.chain().focus().deleteRange(range).insertContent('sample').run(),
      }),
    );
    const m = await mountEditor();
    m.editor.commands.focus();
    await act(async () => typeText(m.editor, '/sample'));
    await act(async () => {
      pressKey(m.editor, 'Enter');
    });
    expect(outline(m.editor.getJSON())).toBe('paragraph(sample)');
    m.unmount();
  });

  it('keyboard shortcuts of a block are active', async () => {
    let hit = 0;
    cleanup.push(registerBlock({ name: 'testWidget', node: Widget, shortcuts: { 'Mod-Alt-w': () => ((hit += 1), true) } }));
    const m = await mountEditor();
    pressKey(m.editor, 'w', { ctrl: true, alt: true });
    expect(hit).toBe(1);
    m.unmount();
  });

  it('unregistering removes the block and its slash items', () => {
    const off = registerBlock({
      name: 'testWidget',
      node: Widget,
      slash: { title: 'Gone soon', description: '', keywords: [], group: 'x', run: () => {} },
    });
    expect(getRegisteredBlocks().map((b) => b.name)).toContain('testWidget');
    off();
    expect(getRegisteredBlocks().map((b) => b.name)).not.toContain('testWidget');
    expect(getRegisteredSlashItems().map((i) => i.title)).not.toContain('Gone soon');
  });
});

describe('unknown node types', () => {
  function docWithUnknown() {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(FRAGMENT_NAME);
    const p = new Y.XmlElement('paragraph');
    p.insert(0, [new Y.XmlText('before')]);
    const unknown = new Y.XmlElement('futureBlock');
    unknown.setAttribute('viewId', 'v-42');
    unknown.setAttribute('mode', 'kanban');
    const q = new Y.XmlElement('paragraph');
    q.insert(0, [new Y.XmlText('after')]);
    frag.insert(0, [p, unknown, q]);
    return doc;
  }

  it('renders a neutral placeholder instead of crashing', async () => {
    const m = await mountEditor({ doc: docWithUnknown() });
    expect(screen.getByText(/Unsupported block \(futureBlock\)/)).toBeTruthy();
    expect(m.editor.getJSON().content?.map((n) => n.type)).toEqual(['paragraph', 'futureBlock', 'paragraph']);
    m.unmount();
  });

  it('keeps the data, also after other parts of the document are edited', async () => {
    const doc = docWithUnknown();
    const m = await mountEditor({ doc });
    m.editor.commands.focus('start');
    await act(async () => typeText(m.editor, 'hello '));
    m.editor.commands.focus('end');
    await act(async () => typeText(m.editor, '!'));
    const children = doc.getXmlFragment(FRAGMENT_NAME).toArray();
    const el = children.find((n) => n instanceof Y.XmlElement && n.nodeName === 'futureBlock') as Y.XmlElement;
    expect(el).toBeTruthy();
    expect(el.getAttributes()).toEqual({ viewId: 'v-42', mode: 'kanban' });
    expect(doc.getXmlFragment(FRAGMENT_NAME).toString()).toContain('hello before');
    expect(doc.getXmlFragment(FRAGMENT_NAME).toString()).toContain('after!');
    expect(children.map((n) => (n as Y.XmlElement).nodeName)).toEqual(['paragraph', 'futureBlock', 'paragraph']);
    m.unmount();
  });

  it('keeps an unknown block that contains blocks', async () => {
    const doc = new Y.Doc();
    const frag = doc.getXmlFragment(FRAGMENT_NAME);
    const box = new Y.XmlElement('futureBox');
    const inner = new Y.XmlElement('paragraph');
    inner.insert(0, [new Y.XmlText('inside')]);
    box.insert(0, [inner]);
    frag.insert(0, [box]);
    const m = await mountEditor({ doc });
    expect(screen.getByText('inside')).toBeTruthy();
    m.editor.commands.focus('end');
    await act(async () => typeText(m.editor, 'x'));
    expect((frag.get(0) as Y.XmlElement).nodeName).toBe('futureBox');
    expect((frag.get(0) as Y.XmlElement).toString()).toContain('inside');
    m.unmount();
  });
});
