import { useEffect, useRef, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import { cx } from '../../ui';
import { BLOCK_KINDS, currentBlockKind, setBlockKind, type BlockKind } from './blocks';
import { OPEN_LINK_EVENT } from './extensions/keys';

interface Mark {
  id: 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'highlight';
  label: string;
  glyph: string;
  className?: string;
  toggle: (e: Editor) => void;
}

const MARKS: Mark[] = [
  { id: 'bold', label: 'Bold', glyph: 'B', className: 'is-bold', toggle: (e) => e.chain().focus().toggleBold().run() },
  { id: 'italic', label: 'Italic', glyph: 'I', className: 'is-italic', toggle: (e) => e.chain().focus().toggleItalic().run() },
  { id: 'underline', label: 'Underline', glyph: 'U', className: 'is-underline', toggle: (e) => e.chain().focus().toggleUnderline().run() },
  { id: 'strike', label: 'Strikethrough', glyph: 'S', className: 'is-strike', toggle: (e) => e.chain().focus().toggleStrike().run() },
  { id: 'code', label: 'Code', glyph: '</>', toggle: (e) => e.chain().focus().toggleCode().run() },
  { id: 'highlight', label: 'Highlight', glyph: 'H', className: 'is-highlight', toggle: (e) => e.chain().focus().toggleHighlight().run() },
];

/** Add a protocol to what the person typed ("example.com" becomes "https://example.com"). */
export function normalizeUrl(input: string): string {
  const v = input.trim();
  if (!v) return '';
  return /^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('/') || v.startsWith('#') ? v : `https://${v}`;
}

/** The floating toolbar for the current text selection. Not shown in code blocks or read-only editors. */
export function Toolbar({ editor }: { editor: Editor }) {
  const [mode, setMode] = useState<'main' | 'link' | 'turn'>('main');
  const [url, setUrl] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);

  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      active: MARKS.filter((m) => e.isActive(m.id)).map((m) => m.id),
      link: e.isActive('link') ? (e.getAttributes('link').href as string) : null,
      kind: currentBlockKind(e),
    }),
  });

  function openLink() {
    setUrl(editor.isActive('link') ? String(editor.getAttributes('link').href ?? '') : '');
    setMode('link');
  }

  useEffect(() => {
    const dom = editor.view.dom;
    const handler = () => openLink();
    dom.addEventListener(OPEN_LINK_EVENT, handler);
    return () => dom.removeEventListener(OPEN_LINK_EVENT, handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    if (mode === 'link') urlRef.current?.focus();
  }, [mode]);

  function applyLink() {
    const href = normalizeUrl(url);
    if (href) editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    else editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setMode('main');
  }

  function removeLink() {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setMode('main');
  }

  function turnInto(kind: BlockKind) {
    setBlockKind(editor.chain().focus(), kind).run();
    setMode('main');
  }

  return (
    <BubbleMenu
      editor={editor}
      className="cl-toolbar"
      options={{ placement: 'top', offset: 8, flip: true, shift: { padding: 8 }, onHide: () => setMode('main') }}
      shouldShow={({ editor: e, state: s }) => {
        if (!e.isEditable || e.isActive('codeBlock')) return false;
        const sel = s.selection;
        return sel instanceof TextSelection && !sel.empty && s.doc.textBetween(sel.from, sel.to).trim().length > 0;
      }}
    >
      <div className="cl-toolbar__inner" role="toolbar" aria-label="Text formatting" onMouseDown={(e) => {
        // Buttons must not steal the editor selection; the link field needs normal focus
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}>
        {mode === 'link' ? (
          <form
            className="cl-toolbar__link"
            onSubmit={(e) => {
              e.preventDefault();
              applyLink();
            }}
          >
            <input
              ref={urlRef}
              className="cl-toolbar__input"
              type="text"
              inputMode="url"
              placeholder="Paste or type a link"
              aria-label="Link URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setMode('main');
                  editor.commands.focus();
                }
              }}
            />
            <button type="submit" className="cl-toolbar__btn" title="Apply link">
              Apply
            </button>
            {state.link && (
              <button type="button" className="cl-toolbar__btn" title="Remove link" onClick={removeLink}>
                Remove
              </button>
            )}
          </form>
        ) : (
          <>
            <div className="cl-toolbar__turn">
              <button
                type="button"
                className="cl-toolbar__btn cl-toolbar__btn--wide"
                aria-haspopup="menu"
                aria-expanded={mode === 'turn'}
                title="Turn into"
                onClick={() => setMode(mode === 'turn' ? 'main' : 'turn')}
              >
                {BLOCK_KINDS.find((k) => k.id === state.kind)?.label ?? 'Text'} {'▾'}
              </button>
              {mode === 'turn' && (
                <div className="cl-toolbar__menu" role="menu">
                  {BLOCK_KINDS.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      role="menuitem"
                      className={cx('cl-toolbar__menuitem', k.id === state.kind && 'is-active')}
                      onClick={() => turnInto(k.id)}
                    >
                      {k.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="cl-toolbar__sep" />
            {MARKS.map((m) => (
              <button
                key={m.id}
                type="button"
                className={cx('cl-toolbar__btn', m.className, state.active.includes(m.id) && 'is-active')}
                aria-pressed={state.active.includes(m.id)}
                aria-label={m.label}
                title={m.label}
                onClick={() => m.toggle(editor)}
              >
                {m.glyph}
              </button>
            ))}
            <button
              type="button"
              className={cx('cl-toolbar__btn', state.link !== null && 'is-active')}
              aria-pressed={state.link !== null}
              aria-label="Link"
              title="Link (Ctrl+K)"
              onClick={openLink}
            >
              Link
            </button>
          </>
        )}
      </div>
    </BubbleMenu>
  );
}
