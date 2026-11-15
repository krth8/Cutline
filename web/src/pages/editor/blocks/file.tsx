import { Node } from '@tiptap/core';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import { formatBytes } from './pageFiles';
import './blocks.css';

/** A short label for the icon: the file's extension, or "FILE". */
export function extensionLabel(name: string): string {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1) : '';
  return /^[A-Za-z0-9]{1,4}$/.test(ext) ? ext.toUpperCase() : 'FILE';
}

function FileView({ node, selected }: NodeViewProps) {
  const { url, name, size } = node.attrs as { url: string | null; name: string; size: number | null };
  const label = name || 'File';
  return (
    <NodeViewWrapper className="cl-file" data-selected={selected ? 'true' : 'false'}>
      <div className="cl-file__row" contentEditable={false}>
        <span className="cl-file__icon" aria-hidden="true">
          {extensionLabel(label)}
        </span>
        <span className="cl-file__name" title={label}>
          {label}
        </span>
        {size != null && <span className="cl-file__size">{formatBytes(size)}</span>}
        {url ? (
          <a className="cl-file__download" href={url} download={label} aria-label={`Download ${label}`}>
            Download
          </a>
        ) : (
          <span className="cl-file__size">Not available</span>
        )}
      </div>
    </NodeViewWrapper>
  );
}

/** A file attachment block: `fileId`, `url`, `name`, `size` (bytes) and `mime`. */
export const FileNode = Node.create({
  name: 'file',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      fileId: { default: null },
      url: { default: null },
      name: { default: '' },
      size: { default: null },
      mime: { default: null },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-file-block]' }];
  },

  renderHTML({ node }) {
    return ['div', { 'data-file-block': '', 'data-file-id': node.attrs.fileId ?? '' }, ['a', { href: node.attrs.url ?? '' }, node.attrs.name || 'File']];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileView);
  },
});
