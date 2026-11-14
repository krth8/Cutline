/**
 * DocMerge - lets several people edit a document at once without overwriting
 * each other.
 *
 * A document is a list of blocks: the top-level elements of the editor
 * (paragraphs, headings, to-dos, ...). Every block carries a stable id
 * (data-bid). The server only accepts a save made on top of the current
 * version; when someone else saved first, the editor merges three versions
 * block by block:
 *
 *   base    what both started from (the last version this editor got from the server)
 *   local   what is in this editor now
 *   remote  what is on the server now
 *
 * Blocks changed, added or removed on one side keep that side's change, so
 * edits in different blocks always both survive. Only when both sides changed
 * the same block does one have to give: the local text stays (nothing a
 * person is typing disappears under them) and the other side's change to that
 * one block is replaced when this editor saves.
 */
const DocMerge = (function () {
    function hash(text) {
        let h = 5381;
        for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }

    function randomId() {
        return 'b' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    }

    /**
     * Make sure every top-level element has its own id.
     *
     * deterministic: ids for blocks without one are derived from their content,
     * so everyone who opens the same (older, id-less) document agrees on them.
     * Otherwise new blocks get random ids - two people adding a block at the
     * same time must not end up with the same one.
     */
    function stamp(root, deterministic) {
        const seen = new Set();
        const derived = {};
        Array.from(root.children).forEach(el => {
            let id = el.getAttribute('data-bid');
            if (id && seen.has(id)) id = null; // a copy (Enter clones the block it splits): the first one keeps the id
            if (!id) {
                if (deterministic) {
                    const key = hash(el.outerHTML);
                    derived[key] = (derived[key] || 0) + 1;
                    id = `h${key}_${derived[key]}`;
                    if (seen.has(id)) id = randomId();
                } else {
                    id = randomId();
                }
                el.setAttribute('data-bid', id);
            }
            seen.add(id);
        });
    }

    function escapeText(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /** The blocks of an editor (or any container): [{id, html}]. Loose text counts as a block too. */
    function blocks(root) {
        const result = [];
        const loose = {};
        root.childNodes.forEach(node => {
            if (node.nodeType === 1) {
                result.push({ id: node.getAttribute('data-bid') || '', html: node.outerHTML });
            } else if (node.nodeType === 3 && node.textContent.trim()) {
                const key = hash(node.textContent);
                loose[key] = (loose[key] || 0) + 1;
                result.push({ id: `t${key}_${loose[key]}`, html: escapeText(node.textContent), text: true });
            }
        });
        return result;
    }

    /** Blocks of an HTML string (already sanitized by the caller). */
    function parse(html) {
        const container = document.createElement('div');
        container.innerHTML = html || '';
        stamp(container, true);
        return blocks(container);
    }

    function serialize(list) {
        return list.map(b => b.html).join('');
    }

    /** Three-way merge of block lists (see the top of this file). Pure: no DOM. */
    function merge(base, local, remote) {
        const B = new Map(base.map(b => [b.id, b.html]));
        const L = new Map(local.map(b => [b.id, b.html]));
        const R = new Map(remote.map(b => [b.id, b.html]));
        const changedHere = id => L.has(id) && (!B.has(id) || L.get(id) !== B.get(id));
        const changedThere = id => R.has(id) && (!B.has(id) || R.get(id) !== B.get(id));

        // The server's order is the starting point
        const result = [];
        remote.forEach(r => {
            if (L.has(r.id)) {
                result.push(changedHere(r.id) ? { ...r, html: L.get(r.id) } : r);
            } else if (!B.has(r.id) || changedThere(r.id)) {
                result.push(r); // new from the other side, or removed here but edited there: the edit stays
            }
        });

        // Blocks only this editor has: added here, or removed there while edited here
        local.forEach((l, i) => {
            if (R.has(l.id)) return;
            if (B.has(l.id) && !changedHere(l.id)) return; // removed there, untouched here
            let at = 0;
            for (let j = i - 1; j >= 0; j--) {
                const k = result.findIndex(b => b.id === local[j].id);
                if (k !== -1) {
                    at = k + 1;
                    break;
                }
            }
            result.splice(at, 0, l);
        });
        return result;
    }

    /**
     * Make the editor show `list`, touching only the blocks that differ - the
     * block someone is typing in keeps its DOM node, and with it the caret.
     */
    function apply(root, list) {
        const current = new Map();
        Array.from(root.children).forEach(el => {
            const id = el.getAttribute('data-bid');
            if (id && !current.has(id)) current.set(id, el);
        });

        const template = document.createElement('template');
        const nodes = list.map(block => {
            const existing = current.get(block.id);
            if (existing && existing.outerHTML === block.html) return existing;
            if (block.text) {
                const span = document.createElement('span');
                span.innerHTML = block.html;
                return document.createTextNode(span.textContent);
            }
            template.innerHTML = block.html;
            return template.content.firstChild;
        }).filter(Boolean);

        // Take out what is going away first, so the blocks that stay never have to
        // move (moving the block someone is typing in would lose their caret)
        const keep = new Set(nodes);
        Array.from(root.childNodes).forEach(node => {
            if (!keep.has(node)) root.removeChild(node);
        });
        nodes.forEach((node, i) => {
            if (root.childNodes[i] !== node) root.insertBefore(node, root.childNodes[i] || null);
        });
    }

    return { stamp, blocks, parse, serialize, merge, apply };
})();

if (typeof window !== 'undefined') window.DocMerge = DocMerge;
if (typeof module !== 'undefined') module.exports = DocMerge;
