import Image from '@tiptap/extension-image';

/**
 * The image node with the attributes of PLAN.md 5.8 (src, alt, width). It only
 * renders; uploading and picking images is added by the files WP through the
 * block registry.
 */
export const ImageNode = Image.extend({
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
    };
  },
});
