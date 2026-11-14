import { act, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { FRAGMENT_NAME } from './buildExtensions';
import { LinkedNetwork } from './testing/linkedProvider';
import { mountEditor, outline, setContent, typeText } from './testing/helpers';

const nets: LinkedNetwork[] = [];
afterEach(() => nets.splice(0).forEach((n) => n.dispose()));

async function pair() {
  const net = new LinkedNetwork();
  nets.push(net);
  const a = net.join();
  const b = net.join();
  const ea = await mountEditor({ doc: a.doc, awareness: a.awareness, user: { id: 'a', name: 'Ada', color: '#e8590c' } });
  const eb = await mountEditor({ doc: b.doc, awareness: b.awareness, user: { id: 'b', name: 'Grace', color: '#1c7ed6' } });
  return { a, b, ea, eb };
}

describe('two linked editors', () => {
  it('see each other edits', async () => {
    const { ea, eb } = await pair();
    ea.editor.commands.focus();
    await act(async () => typeText(ea.editor, '# Plan'));
    expect(outline(eb.editor.getJSON())).toBe('h1(Plan)');
  });

  it('converge after concurrent edits, also in the same paragraph', async () => {
    const { a, b, ea, eb } = await pair();
    ea.editor.commands.focus();
    await act(async () => typeText(ea.editor, 'middle'));
    expect(outline(eb.editor.getJSON())).toBe('paragraph(middle)');

    a.setOnline(false);
    b.setOnline(false);
    ea.editor.commands.setTextSelection(1);
    await act(async () => typeText(ea.editor, 'A:'));
    eb.editor.commands.setTextSelection(eb.editor.state.doc.firstChild!.nodeSize - 1);
    await act(async () => typeText(eb.editor, ':B'));
    eb.editor.commands.focus('end');
    await act(async () => typeText(eb.editor, ' extra'));
    expect(outline(ea.editor.getJSON())).not.toBe(outline(eb.editor.getJSON()));

    await act(async () => {
      a.setOnline(true);
      b.setOnline(true);
    });
    const left = outline(ea.editor.getJSON());
    expect(left).toBe(outline(eb.editor.getJSON()));
    expect(left).toContain('A:middle');
    expect(left).toContain(':B');
    expect(Y.encodeStateVector(a.doc)).toEqual(Y.encodeStateVector(b.doc));
  });

  it('undo in one editor does not undo the other user change', async () => {
    const { ea, eb } = await pair();
    ea.editor.commands.focus();
    await act(async () => typeText(ea.editor, 'mine'));
    await new Promise((r) => setTimeout(r, 650)); // let the undo manager close the first group
    eb.editor.commands.focus('end');
    await act(async () => {
      eb.editor.commands.insertContent(' theirs');
    });
    expect(outline(ea.editor.getJSON())).toBe('paragraph(mine theirs)');
    await act(async () => {
      ea.editor.commands.undo();
    });
    const after = outline(eb.editor.getJSON());
    expect(after).toContain('theirs');
    expect(after).not.toContain('mine');
    expect(outline(ea.editor.getJSON())).toBe(after);
  });

  it('knows the other user (name and colour) through awareness, for the caret labels', async () => {
    const { ea, eb } = await pair();
    const users = (e: typeof ea) => e.editor.storage.collaborationCaret.users.map((u: any) => `${u.name}:${u.color}`);
    expect(users(ea)).toContain('Grace:#1c7ed6');
    expect(users(eb)).toContain('Ada:#e8590c');
  });

  it('an offline editor keeps working and syncs when it comes back', async () => {
    const { a, ea, eb } = await pair();
    a.setOnline(false);
    ea.editor.commands.focus();
    await act(async () => typeText(ea.editor, 'offline work'));
    expect(outline(eb.editor.getJSON())).toBe('paragraph()');
    await act(async () => a.setOnline(true));
    expect(outline(eb.editor.getJSON())).toBe('paragraph(offline work)');
  });

  it('content is stored in the fragment named "default"', async () => {
    const { a, ea } = await pair();
    ea.editor.commands.focus();
    await act(async () => typeText(ea.editor, 'x'));
    expect(a.doc.getXmlFragment(FRAGMENT_NAME).toString()).toContain('x');
    expect(a.doc.share.has('default')).toBe(true);
  });
});

describe('read-only', () => {
  it('cannot be edited', async () => {
    const m = await mountEditor({ editable: false });
    expect(m.editor.isEditable).toBe(false);
    expect(m.editor.view.dom.getAttribute('contenteditable')).toBe('false');
    // The view refuses user input: PM does not run input handlers when it is not editable
    expect(m.editor.view.editable).toBe(false);
    expect(document.querySelector('.cl-handle')).toBeNull(); // no drag handle
    expect(m.editor.commands.undo()).toBeDefined();
    expect(m.doc.getXmlFragment(FRAGMENT_NAME).length).toBeLessThanOrEqual(1);
    expect(screen.queryByRole('toolbar')).toBeNull();
    m.unmount();
  });

  it('switching editable on and off takes effect without losing the content', async () => {
    const doc = new Y.Doc();
    const m = await mountEditor({ doc, editable: true });
    setContent(m.editor, [{ type: 'paragraph', content: [{ type: 'text', text: 'keep' }] }]);
    m.editor.setEditable(false);
    expect(m.editor.isEditable).toBe(false);
    m.editor.setEditable(true);
    expect(outline(m.editor.getJSON())).toBe('paragraph(keep)');
    m.unmount();
  });
});
