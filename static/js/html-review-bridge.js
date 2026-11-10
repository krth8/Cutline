/**
 * Cutline HTML review bridge.
 *
 * Injected by the server into uploaded HTML pages (served sandboxed, opaque origin).
 * Talks to the Cutline review UI in the parent window via postMessage:
 *
 *   parent -> page   { source: 'cutline', type: 'pick',  on }
 *                    { source: 'cutline', type: 'pins',  pins: [{ id, n, anchor, resolved }] }
 *                    { source: 'cutline', type: 'focus', id, anchor }
 *   page -> parent   { source: 'cutline-page', type: 'ready' | 'location', hash }
 *                    { source: 'cutline-page', type: 'picked', anchor }
 *                    { source: 'cutline-page', type: 'pickCancel' }
 *                    { source: 'cutline-page', type: 'pinClick', id }
 *                    { source: 'cutline-page', type: 'needsReload', hash, id }
 *
 * An anchor is { selector, hash, tag, label, ox, oy, vx, vy }:
 * ox/oy = click point inside the element (0..1), vx/vy = click point in the viewport (fallback).
 */
(function () {
    'use strict';
    if (window.__cutlineBridge || window.parent === window) return;
    window.__cutlineBridge = true;

    const ACCENT = '#6366f1';
    let host = null;
    let root = null;
    let hoverBox = null;
    let banner = null;
    let picking = false;
    let hoverEl = null;
    let pins = [];
    let pinEls = new Map();
    let pausedAnimations = [];
    let rafId = null;

    function send(type, data) {
        window.parent.postMessage(Object.assign({ source: 'cutline-page', type: type }, data || {}), '*');
    }

    function currentHash() {
        return location.hash || '';
    }

    // ---------- Overlay (shadow DOM, so page CSS can't touch it) ----------

    function ensureOverlay() {
        if (host && host.isConnected) return;
        host = document.createElement('cutline-review-overlay');
        host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;';
        root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
            <style>
                .hover { position: fixed; border: 2px solid ${ACCENT}; background: rgba(99,102,241,.12);
                         border-radius: 3px; pointer-events: none; display: none; box-sizing: border-box; }
                .hover-label { position: absolute; left: -2px; top: -22px; background: ${ACCENT}; color: #fff;
                         font: 600 11px/1 system-ui, sans-serif; padding: 4px 6px; border-radius: 3px; white-space: nowrap; }
                .banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); display: none;
                         background: rgba(17,17,24,.92); color: #fff; font: 500 13px/1.2 system-ui, sans-serif;
                         padding: 8px 14px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
                .banner b { color: #a5b4fc; }
                .pin { position: fixed; width: 26px; height: 26px; margin: -26px 0 0 -4px; pointer-events: auto;
                       cursor: pointer; border-radius: 13px 13px 13px 2px; background: ${ACCENT}; color: #fff;
                       font: 700 12px/26px system-ui, sans-serif; text-align: center;
                       box-shadow: 0 2px 8px rgba(0,0,0,.35); border: 2px solid #fff; box-sizing: border-box;
                       transition: transform .15s; }
                .pin:hover { transform: scale(1.15); }
                .pin.resolved { background: #22a06b; opacity: .75; }
                .pin.hidden { display: none; }
                .focus { position: fixed; border: 3px solid ${ACCENT}; border-radius: 4px; pointer-events: none;
                         box-sizing: border-box; animation: pulse 1.2s ease-out 2; }
                @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(99,102,241,.6); }
                                   100% { box-shadow: 0 0 0 18px rgba(99,102,241,0); } }
            </style>
            <div class="hover"><span class="hover-label"></span></div>
            <div class="banner">Click an element to comment · <b>Esc</b> to cancel</div>
        `;
        hoverBox = root.querySelector('.hover');
        banner = root.querySelector('.banner');
        document.documentElement.appendChild(host);
    }

    // ---------- Anchors ----------

    function isUniqueId(id) {
        if (!/^[A-Za-z][\w-]*$/.test(id)) return false;
        try {
            return document.querySelectorAll('#' + CSS.escape(id)).length === 1;
        } catch (e) {
            return false;
        }
    }

    function cssPath(el) {
        const parts = [];
        while (el && el.nodeType === 1 && el !== document.documentElement) {
            if (el.id && isUniqueId(el.id)) {
                parts.unshift('#' + CSS.escape(el.id));
                break;
            }
            let part = el.localName;
            const parent = el.parentElement;
            if (parent) {
                const same = Array.prototype.filter.call(parent.children, c => c.localName === el.localName);
                if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
            }
            parts.unshift(part);
            el = parent;
        }
        return parts.join(' > ');
    }

    function labelFor(el) {
        const text = el.getAttribute('aria-label') || el.getAttribute('alt') || el.getAttribute('title') || el.textContent || '';
        return text.replace(/\s+/g, ' ').trim().slice(0, 80);
    }

    function buildAnchor(el, x, y) {
        const r = el.getBoundingClientRect();
        const frac = (v, size) => (size > 0 ? Math.round((v / size) * 1000) / 1000 : 0.5);
        return {
            selector: cssPath(el),
            hash: currentHash(),
            tag: el.localName,
            label: labelFor(el),
            ox: frac(x - r.left, r.width),
            oy: frac(y - r.top, r.height),
            vx: frac(x, window.innerWidth),
            vy: frac(y, window.innerHeight)
        };
    }

    function findElement(anchor) {
        if (!anchor || !anchor.selector) return null;
        try {
            return document.querySelector(anchor.selector);
        } catch (e) {
            return null;
        }
    }

    function isShown(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
        if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
        if (typeof el.checkVisibility === 'function') {
            return el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
        }
        return true;
    }

    function anchorPoint(anchor) {
        const el = findElement(anchor);
        if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 || r.height > 0) {
                return {
                    x: r.left + (anchor.ox != null ? anchor.ox : 0.5) * r.width,
                    y: r.top + (anchor.oy != null ? anchor.oy : 0.5) * r.height,
                    el: el
                };
            }
        }
        if (anchor && anchor.vx != null && anchor.vy != null) {
            return { x: anchor.vx * window.innerWidth, y: anchor.vy * window.innerHeight, el: null };
        }
        return null;
    }

    // Anchors without a hash belong to every "page"; otherwise only show on the matching hash.
    function onThisView(anchor) {
        return !anchor.hash || anchor.hash === currentHash();
    }

    // ---------- Pick mode ----------

    function isOverlay(el) {
        return el === host;
    }

    function targetAt(x, y) {
        const el = document.elementFromPoint(x, y);
        if (!el || isOverlay(el) || el === document.documentElement) return null;
        return el;
    }

    function showHover(el) {
        hoverEl = el;
        if (!el) {
            hoverBox.style.display = 'none';
            return;
        }
        const r = el.getBoundingClientRect();
        Object.assign(hoverBox.style, {
            display: 'block',
            left: r.left + 'px',
            top: r.top + 'px',
            width: r.width + 'px',
            height: r.height + 'px'
        });
        hoverBox.querySelector('.hover-label').textContent = el.localName + (el.id ? '#' + el.id : '');
    }

    function swallow(e) {
        if (!picking) return;
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    function onMove(e) {
        if (!picking) return;
        showHover(targetAt(e.clientX, e.clientY));
    }

    function onClick(e) {
        if (!picking) return;
        swallow(e);
        const el = targetAt(e.clientX, e.clientY);
        if (!el) return;
        const anchor = buildAnchor(el, e.clientX, e.clientY);
        setPicking(false);
        send('picked', { anchor: anchor });
    }

    function onKey(e) {
        if (!picking) return;
        swallow(e);
        if (e.type === 'keydown' && e.key === 'Escape') {
            setPicking(false);
            send('pickCancel');
        }
    }

    function setPicking(on) {
        ensureOverlay();
        picking = !!on;
        banner.style.display = picking ? 'block' : 'none';
        document.documentElement.style.cursor = picking ? 'crosshair' : '';
        if (!picking) showHover(null);

        // Freeze CSS/WAAPI animations while choosing, so the target holds still.
        if (picking) {
            try {
                pausedAnimations = document.getAnimations().filter(a => a.playState === 'running');
                pausedAnimations.forEach(a => a.pause());
            } catch (e) {
                pausedAnimations = [];
            }
        } else {
            pausedAnimations.forEach(a => {
                try { a.play(); } catch (e) {}
            });
            pausedAnimations = [];
        }
        tick();
    }

    // Capture phase on window: runs before the page's own handlers.
    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'touchstart', 'touchend', 'contextmenu'].forEach(type => {
        window.addEventListener(type, swallow, { capture: true, passive: false });
    });
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onKey, true);

    // ---------- Pins ----------

    function renderPins() {
        ensureOverlay();
        const keep = new Set(pins.map(p => p.id));
        pinEls.forEach((el, id) => {
            if (!keep.has(id)) {
                el.remove();
                pinEls.delete(id);
            }
        });
        pins.forEach(p => {
            let el = pinEls.get(p.id);
            if (!el) {
                el = document.createElement('div');
                el.className = 'pin';
                el.addEventListener('click', e => {
                    e.preventDefault();
                    e.stopPropagation();
                    send('pinClick', { id: p.id });
                });
                root.appendChild(el);
                pinEls.set(p.id, el);
            }
            el.textContent = String(p.n);
            el.title = p.anchor.label || '';
            el.classList.toggle('resolved', !!p.resolved);
        });
        tick();
    }

    function placePins() {
        pins.forEach(p => {
            const el = pinEls.get(p.id);
            if (!el) return;
            const pt = onThisView(p.anchor) ? anchorPoint(p.anchor) : null;
            if (!pt) {
                el.classList.add('hidden');
                return;
            }
            el.classList.remove('hidden');
            el.style.left = pt.x + 'px';
            el.style.top = pt.y + 'px';
        });
        if (picking && hoverEl) showHover(hoverEl);
    }

    // Follow layout changes (scaling stage, scrolling, animations) while there is something to draw.
    function tick() {
        if (rafId) return;
        const loop = () => {
            rafId = null;
            placePins();
            if (pins.length || picking) rafId = requestAnimationFrame(loop);
        };
        rafId = requestAnimationFrame(loop);
    }

    function flash(el) {
        ensureOverlay();
        const r = el.getBoundingClientRect();
        const box = document.createElement('div');
        box.className = 'focus';
        Object.assign(box.style, {
            left: r.left - 4 + 'px',
            top: r.top - 4 + 'px',
            width: r.width + 8 + 'px',
            height: r.height + 8 + 'px'
        });
        root.appendChild(box);
        setTimeout(() => box.remove(), 2600);
    }

    function focusAnchor(id, anchor, retried) {
        if (anchor.hash && anchor.hash !== currentHash()) {
            location.hash = anchor.hash;
        }
        // Give the page a moment to react to the hash change (slide transitions etc.)
        setTimeout(() => {
            const el = findElement(anchor);
            if (el && !isShown(el)) {
                try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
            }
            setTimeout(() => {
                if (el && isShown(el)) {
                    flash(el);
                } else if (!retried && anchor.hash) {
                    // Page doesn't listen to hashchange: ask Cutline to reload at that hash.
                    send('needsReload', { hash: anchor.hash, id: id });
                }
            }, 350);
        }, anchor.hash ? 500 : 0);
    }

    // ---------- Messages from Cutline ----------

    window.addEventListener('message', e => {
        if (e.source !== window.parent) return;
        const msg = e.data;
        if (!msg || msg.source !== 'cutline') return;

        if (msg.type === 'pick') {
            setPicking(msg.on);
        } else if (msg.type === 'pins') {
            pins = Array.isArray(msg.pins) ? msg.pins.filter(p => p && p.anchor) : [];
            renderPins();
        } else if (msg.type === 'focus' && msg.anchor) {
            focusAnchor(msg.id, msg.anchor, !!msg.retried);
        }
    });

    window.addEventListener('hashchange', () => {
        send('location', { hash: currentHash() });
        placePins();
    });

    function ready() {
        ensureOverlay();
        send('ready', { hash: currentHash() });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ready, { once: true });
    } else {
        ready();
    }
})();
