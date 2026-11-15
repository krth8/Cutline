import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import Image from '@tiptap/extension-image';
import { NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import './blocks.css';

export const IMAGE_ALIGNS = ['left', 'center'] as const;
export type ImageAlign = (typeof IMAGE_ALIGNS)[number];

const MIN_WIDTH = 48;

/** The width after dragging the corner by `dx` pixels, kept between the minimum and the room available. */
export function resizedWidth(startWidth: number, dx: number, maxWidth: number): number {
  const max = Math.max(MIN_WIDTH, maxWidth);
  return Math.round(Math.max(MIN_WIDTH, Math.min(max, startWidth + dx)));
}

/** Only the two known alignments; anything else (older or newer clients) is shown as left. */
export function cleanAlign(value: unknown): ImageAlign {
  return value === 'center' ? 'center' : 'left';
}

/** Full-size view of an image. Closes on Escape or a click anywhere. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="cl-lightbox" role="dialog" aria-modal="true" aria-label="Image" onClick={onClose}>
      <img className="cl-lightbox__img" src={src} alt={alt} />
      <button type="button" className="cl-lightbox__close" aria-label="Close" onClick={onClose}>
        ×
      </button>
    </div>,
    document.body,
  );
}

function ImageView({ node, editor, updateAttributes, selected }: NodeViewProps) {
  const { src, alt, width, caption } = node.attrs as { src: string | null; alt: string | null; width: number | null; caption: string | null };
  const align = cleanAlign(node.attrs.align);
  const editable = editor.isEditable;
  const imgRef = useRef<HTMLImageElement>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);

  useEffect(() => setBroken(false), [src]);

  const startResize = (e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const img = imgRef.current;
    if (!img) return;
    const startX = e.clientX;
    const startWidth = img.getBoundingClientRect().width;
    const room = img.closest('.cl-editor__prose')?.clientWidth ?? startWidth * 4;
    let latest = startWidth;
    const move = (ev: globalThis.PointerEvent) => {
      latest = resizedWidth(startWidth, ev.clientX - startX, room);
      setDragWidth(latest);
    };
    const up = () => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      setDragWidth(null);
      updateAttributes({ width: Math.round(latest) });
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  };

  const shownWidth = dragWidth ?? width ?? undefined;
  const stop = (e: KeyboardEvent) => e.stopPropagation();

  return (
    <NodeViewWrapper className={`cl-image cl-image--${align}`} data-align={align} data-selected={selected ? 'true' : 'false'}>
      <figure className="cl-image__figure" contentEditable={false} style={shownWidth ? { width: shownWidth } : undefined}>
        {broken || !src ? (
          <div className="cl-image__missing">Image not available</div>
        ) : (
          <img
            ref={imgRef}
            className="cl-image__img"
            src={src}
            alt={alt ?? ''}
            draggable={false}
            onError={() => setBroken(true)}
            onClick={() => setOpen(true)}
          />
        )}
        {editable && !broken && src && (
          <span className="cl-image__handle" role="separator" aria-label="Resize image" onPointerDown={startResize} />
        )}
        {editable && selected && (
          <div className="cl-image__controls" onMouseDown={(e) => e.stopPropagation()}>
            <input
              className="cl-image__alt"
              type="text"
              aria-label="Alt text"
              placeholder="Alt text"
              value={alt ?? ''}
              onChange={(e) => updateAttributes({ alt: e.target.value })}
              onKeyDown={stop}
            />
            {IMAGE_ALIGNS.map((a) => (
              <button
                key={a}
                type="button"
                className="cl-image__align"
                aria-pressed={align === a}
                title={a === 'left' ? 'Align left' : 'Centre'}
                onClick={() => updateAttributes({ align: a })}
              >
                {a === 'left' ? 'Left' : 'Centre'}
              </button>
            ))}
          </div>
        )}
        {editable ? (
          <input
            className="cl-image__caption"
            type="text"
            aria-label="Caption"
            placeholder="Add a caption"
            value={caption ?? ''}
            data-empty={caption ? 'false' : 'true'}
            onChange={(e) => updateAttributes({ caption: e.target.value || null })}
            onKeyDown={stop}
          />
        ) : (
          caption && <figcaption className="cl-image__caption cl-image__caption--text">{caption}</figcaption>
        )}
      </figure>
      {open && src && <Lightbox src={src} alt={alt ?? ''} onClose={() => setOpen(false)} />}
    </NodeViewWrapper>
  );
}

/**
 * The image block: `src`, `alt`, `width` (pixels, null = natural size), plus `fileId` (the page file it
 * shows), `caption` and `align` ('left' | 'center').
 */
export const ImageNode = Image.extend({
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      alt: { default: null },
      width: {
        default: null,
        parseHTML: (el) => {
          const w = Number.parseInt(el.getAttribute('width') ?? '', 10);
          return Number.isFinite(w) ? w : null;
        },
        renderHTML: (attrs) => (attrs.width ? { width: attrs.width } : {}),
      },
      fileId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-file-id'),
        renderHTML: (attrs) => (attrs.fileId ? { 'data-file-id': attrs.fileId } : {}),
      },
      caption: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-caption'),
        renderHTML: (attrs) => (attrs.caption ? { 'data-caption': attrs.caption } : {}),
      },
      align: {
        default: 'left',
        parseHTML: (el) => cleanAlign(el.getAttribute('data-align')),
        renderHTML: (attrs) => ({ 'data-align': cleanAlign(attrs.align) }),
      },
    };
  },

  addNodeView() {
    return ReactNodeViewRenderer(ImageView);
  },
});
