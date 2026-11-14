import { Node, mergeAttributes, wrappingInputRule } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';

export const CALLOUT_TONES = ['info', 'success', 'warning', 'danger'] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

const SYMBOLS: Record<CalloutTone, string> = { info: 'i', success: '✓', warning: '!', danger: '×' };

function CalloutView({ node, updateAttributes, editor }: NodeViewProps) {
  const tone = (node.attrs.tone as CalloutTone) ?? 'info';
  const next = CALLOUT_TONES[(CALLOUT_TONES.indexOf(tone) + 1) % CALLOUT_TONES.length]!;
  return (
    <NodeViewWrapper className={`cl-callout cl-callout--${tone}`} data-tone={tone}>
      <button
        type="button"
        className="cl-callout__icon"
        contentEditable={false}
        disabled={!editor.isEditable}
        title={editor.isEditable ? `Change tone (${tone})` : tone}
        aria-label={`Callout tone: ${tone}`}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => updateAttributes({ tone: next })}
      >
        {SYMBOLS[tone]}
      </button>
      <NodeViewContent className="cl-callout__body" />
    </NodeViewWrapper>
  );
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      setCallout: (tone?: CalloutTone) => ReturnType;
    };
  }
}

/** A highlighted box with block content inside; `tone` picks the colour. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      tone: {
        default: 'info',
        parseHTML: (el) => {
          const t = el.getAttribute('data-tone');
          return (CALLOUT_TONES as readonly string[]).includes(t ?? '') ? t : 'info';
        },
        renderHTML: (attrs) => ({ 'data-tone': attrs.tone }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-callout]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '' }), 0];
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView);
  },

  addCommands() {
    return {
      setCallout:
        (tone = 'info') =>
        ({ commands }) =>
          commands.wrapIn(this.name, { tone }),
    };
  },

  addInputRules() {
    // "!> " starts a callout
    return [wrappingInputRule({ find: /^!>\s$/, type: this.type, getAttributes: () => ({ tone: 'info' }) })];
  },
});
