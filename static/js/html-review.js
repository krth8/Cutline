/**
 * HTML clip review (Cutline side).
 *
 * HTML clips are shown in a sandboxed iframe (#htmlFrame). The page gets a small
 * bridge script injected by the server (html-review-bridge.js); this file talks to it:
 * - "Comment on element" puts the page in pick mode; the picked element's anchor is
 *   attached to the next comment (AppState.pendingAnchor).
 * - Comments with anchors on the current version are shown as numbered pins in the page.
 * - Drawings use the normal SVG overlay on top of the page. Each drawing stores the page
 *   view it was made on (drawing.view: hash, page state, scroll, landmark, overlay size).
 * - Clicking a comment navigates the page to the element or drawn-on view, then shows its
 *   drawing until the page view changes. Clicking a pin highlights the comment.
 */
const HtmlReview = (() => {
    const SVG_NS = 'http://www.w3.org/2000/svg';

    let frame = null;
    let baseUrl = null;          // tokened page URL without hash
    let loadedKey = null;        // `${baseName}:${version}` currently in the frame
    let ready = false;
    let picking = false;
    let lastFocus = null;        // { msg, drawing } of the last focused comment
    let pendingFocusMsg = null;  // focus message to send once the page is ready
    let shownDrawing = null;     // drawing currently shown on the overlay
    let drawView = null;         // page view captured when draw mode was turned on
    let resizeObserver = null;
    let snapSeq = 0;
    const snapWaiters = new Map();

    function getFrame() {
        if (!frame) frame = document.getElementById('htmlFrame');
        return frame;
    }

    function overlay() {
        return document.getElementById('svgOverlay');
    }

    function post(msg) {
        const f = getFrame();
        if (f && f.contentWindow && ready) {
            // The page has an opaque origin (sandboxed), so '*' is the only usable target.
            f.contentWindow.postMessage({ source: 'cutline', ...msg }, '*');
        }
    }

    function isActive() {
        return AppState.currentMediaType === 'html';
    }

    function hasStrokes(drawing) {
        return !!(drawing && Array.isArray(drawing.strokes) && drawing.strokes.length > 0);
    }

    // ---------- Loading ----------

    async function load(clip, baseName) {
        const f = getFrame();
        if (!f) return;

        const video = document.getElementById('video');
        const stillImage = document.getElementById('stillImage');
        if (video) {
            video.pause();
            video.style.display = 'none';
        }
        if (stillImage) stillImage.style.display = 'none';
        f.style.display = 'block';
        AppState.currentFrame = 0;
        watchResize();
        requestAnimationFrame(syncOverlay);

        const key = `${baseName}:${clip.version}`;
        if (key === loadedKey && ready) {
            sendPins();
            return;
        }

        loadedKey = key;
        ready = false;
        lastFocus = null;
        pendingFocusMsg = null;
        drawView = null;
        hideDrawing();
        setPicking(false);
        clearPendingAnchor();

        try {
            const res = await fetch(`/api/projects/${encodeURIComponent(AppState.projectId)}/clips/${encodeURIComponent(baseName)}/html-url?version=${clip.version}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            if (loadedKey !== key) return;  // user switched clip meanwhile
            baseUrl = data.url;
            f.src = baseUrl;
        } catch (e) {
            console.error('Could not load HTML clip', e);
            if (typeof showToast === 'function') showToast('Could not load HTML page', 'error');
        }
    }

    function unload() {
        const f = getFrame();
        if (!f) return;
        f.style.display = 'none';
        if (loadedKey) {
            f.src = 'about:blank';
            loadedKey = null;
            baseUrl = null;
            ready = false;
        }
        lastFocus = null;
        pendingFocusMsg = null;
        drawView = null;
        hideDrawing();
        setPicking(false);
        clearPendingAnchor();
    }

    function reloadAtHash(hash) {
        const f = getFrame();
        if (!f || !baseUrl) return;
        ready = false;
        // A changed query forces a real reload; only changing the hash would not.
        f.src = `${baseUrl}&reload=${Date.now()}${hash || ''}`;
    }

    function openInNewTab() {
        if (baseUrl) window.open(baseUrl, '_blank', 'noopener');
    }

    // ---------- Pick mode & pending anchor ----------

    function setPicking(on) {
        picking = !!on;
        document.getElementById('htmlPickBtn')?.classList.toggle('active', picking);
        post({ type: 'pick', on: picking });
        if (picking) getFrame()?.focus();
    }

    function togglePick() {
        if (!isActive()) return;
        // Picking needs the page to get clicks: step out of draw mode but keep what's drawn,
        // so one comment can have both an element and a drawing.
        if (!picking && AppState.drawMode) leaveDrawMode();
        setPicking(!picking);
    }

    function setPendingAnchor(anchor) {
        AppState.pendingAnchor = anchor;
        const area = document.getElementById('commentAnchorArea');
        const label = document.getElementById('commentAnchorLabel');
        if (area && label) {
            const text = anchor.label ? `${anchor.tag} “${anchor.label.slice(0, 40)}”` : `<${anchor.tag}>`;
            label.textContent = text;
            area.classList.add('visible');
        }
        const input = document.getElementById('commentInput');
        if (input) input.focus();
    }

    function clearPendingAnchor() {
        AppState.pendingAnchor = null;
        document.getElementById('commentAnchorArea')?.classList.remove('visible');
    }

    // ---------- Drawing overlay ----------

    function overlaySize() {
        const r = overlay()?.getBoundingClientRect();
        return { w: Math.round(r?.width || 0), h: Math.round(r?.height || 0) };
    }

    /** In HTML mode one overlay unit = one CSS pixel of the page area. */
    function syncOverlay() {
        const svg = overlay();
        if (!svg || !isActive()) return;
        const { w, h } = overlaySize();
        if (!w || !h) return;
        svg.style.transform = '';
        svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
        svg.setAttribute('preserveAspectRatio', 'none');
        if (shownDrawing) renderDrawing(shownDrawing);
    }

    function watchResize() {
        if (resizeObserver || typeof ResizeObserver === 'undefined') return;
        const wrapper = document.getElementById('videoWrapper');
        if (!wrapper) return;
        resizeObserver = new ResizeObserver(() => {
            if (isActive()) syncOverlay();
        });
        resizeObserver.observe(wrapper);
    }

    function requestSnapshot() {
        return new Promise(resolve => {
            if (!ready) return resolve(null);
            const reqId = ++snapSeq;
            snapWaiters.set(reqId, resolve);
            post({ type: 'snapshot', reqId });
            setTimeout(() => {
                if (snapWaiters.delete(reqId)) resolve(null);
            }, 800);
        });
    }

    /** Called when draw mode turns on: size the overlay and remember the page view. */
    function onDrawMode() {
        if (picking) setPicking(false);
        hideDrawing();
        syncOverlay();
        // Back in draw mode with strokes already made (e.g. after picking an element): keep their view
        if (drawView && hasStrokes(AppState.pendingDrawing)) return;
        const size = overlaySize();
        const captured = { ...size };
        drawView = captured;
        requestSnapshot().then(view => {
            if (view && drawView === captured) drawView = { ...view, w: size.w, h: size.h };
        });
    }

    function leaveDrawMode() {
        AppState.drawMode = false;
        overlay()?.classList.remove('drawing');
        document.getElementById('drawToggleBtn')?.classList.remove('active');
        document.getElementById('drawPaletteArea')?.classList.remove('visible');
    }

    /** View stored with a new drawing: { hash, state, sx, sy, sel, ox, oy, w, h }. */
    function drawingView() {
        const view = drawView ? { ...drawView } : { ...overlaySize() };
        drawView = null;
        return view;
    }

    /** Draw a saved drawing, scaled from the size it was drawn at to the current page area. */
    function renderDrawing(drawing) {
        const svg = overlay();
        if (!svg || typeof showCommentDrawing !== 'function') return;
        svg.querySelectorAll('.html-drawing').forEach(g => g.remove());

        const { w, h } = overlaySize();
        const v = drawing.view || {};
        const vw = v.w || w;
        const vh = v.h || h;
        if (!w || !h || !vw || !vh) return;
        // Uniform scale, centered: matches decks that letterbox a fixed-size stage
        const s = Math.min(w / vw, h / vh);
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('class', 'html-drawing');
        g.setAttribute('transform', `translate(${(w - vw * s) / 2} ${(h - vh * s) / 2}) scale(${s})`);
        svg.appendChild(g);
        showCommentDrawing(drawing, true, g);
        shownDrawing = drawing;
    }

    function hideDrawing() {
        shownDrawing = null;
        overlay()?.querySelectorAll('.html-drawing').forEach(g => g.remove());
    }

    /** Show a drawing on the current view; it hides again once the page view changes. */
    function showDrawing(drawing) {
        if (!hasStrokes(drawing)) return;
        syncOverlay();
        renderDrawing(drawing);
        post({ type: 'watchView' });
    }

    // ---------- Pins ----------

    /** Root comments with an anchor on the current version, numbered in posting order. */
    function pinNumbers(comments) {
        const numbers = new Map();
        const version = AppState.currentClip?.version;
        let n = 0;
        comments.forEach(c => {
            if (!c.parentId && c.anchor && c.clipVersion === version) {
                numbers.set(c.id, ++n);
            }
        });
        return numbers;
    }

    function currentComments() {
        return commentsForCurrentClip();
    }

    function sendPins() {
        if (!isActive()) return;
        const comments = currentComments();
        const numbers = pinNumbers(comments);
        const pins = comments
            .filter(c => numbers.has(c.id))
            .map(c => ({ id: c.id, n: numbers.get(c.id), anchor: c.anchor, resolved: !!c.resolved }));
        post({ type: 'pins', pins });
    }

    // ---------- Focusing a comment ----------

    /**
     * Navigate the page to a comment: its element anchor, or the view its drawing was made on,
     * then show the drawing. Replies without their own anchor or drawing use their parent's.
     */
    function focusComment(comment) {
        if (!comment) return;
        let target = comment;
        if (!target.anchor && !hasStrokes(target.drawing) && target.parentId) {
            target = (AppState.comments || []).find(c => c.id === target.parentId) || target;
        }

        const drawing = hasStrokes(target.drawing) ? target.drawing : null;
        const view = drawing?.view || null;
        let anchor = target.anchor || null;
        if (!anchor && view && (view.sel || view.hash || view.state)) {
            anchor = { selector: view.sel, hash: view.hash, state: view.state, ox: view.ox, oy: view.oy };
        }

        hideDrawing();
        if (!anchor) {
            if (drawing) showDrawing(drawing);
            return;
        }

        const msg = {
            type: 'focus',
            id: target.id,
            anchor,
            quiet: !target.anchor,  // a drawing's landmark element isn't what the comment is about
            scroll: view && view.sy != null ? { sx: view.sx || 0, sy: view.sy } : null
        };
        lastFocus = { msg, drawing };
        if (!ready) {
            pendingFocusMsg = msg;
            return;
        }
        post(msg);
    }

    function highlightComment(commentId) {
        const el = document.querySelector(`[data-comment-id="${CSS.escape(commentId)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        el.classList.add('highlighted');
        setTimeout(() => el.classList.remove('highlighted'), 3000);
    }

    // ---------- Messages from the page ----------

    window.addEventListener('message', e => {
        const f = getFrame();
        if (!f || e.source !== f.contentWindow) return;
        const msg = e.data;
        if (!msg || msg.source !== 'cutline-page') return;

        switch (msg.type) {
            case 'ready':
                ready = true;
                sendPins();
                if (picking) post({ type: 'pick', on: true });
                if (pendingFocusMsg) {
                    const m = pendingFocusMsg;
                    pendingFocusMsg = null;
                    post({ ...m, retried: true });
                }
                break;
            case 'picked':
                picking = false;
                document.getElementById('htmlPickBtn')?.classList.remove('active');
                if (msg.anchor) setPendingAnchor(msg.anchor);
                break;
            case 'pickCancel':
                picking = false;
                document.getElementById('htmlPickBtn')?.classList.remove('active');
                break;
            case 'diag':
                console.info(`[HTML review] WebGPU in sandboxed page: ${msg.webgpu ? 'available' : 'NOT available (three.js falls back to WebGL)'}`);
                break;
            case 'pinClick':
                if (typeof msg.id === 'string') highlightComment(msg.id);
                break;
            case 'needsReload':
                if (lastFocus && msg.id === lastFocus.msg.id && typeof msg.hash === 'string' && msg.hash.startsWith('#')) {
                    pendingFocusMsg = lastFocus.msg;
                    reloadAtHash(msg.hash);
                }
                break;
            case 'focused':
                if (lastFocus && msg.id === lastFocus.msg.id && lastFocus.drawing) {
                    showDrawing(lastFocus.drawing);
                }
                break;
            case 'viewChanged':
                hideDrawing();
                break;
            case 'snapshot': {
                const resolve = snapWaiters.get(msg.reqId);
                if (resolve) {
                    snapWaiters.delete(msg.reqId);
                    resolve(msg.view && typeof msg.view === 'object' ? msg.view : null);
                }
                break;
            }
        }
    });

    document.addEventListener('keydown', e => {
        if (!isActive()) return;
        const tag = (e.target?.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
        if (e.key === 'e' || e.key === 'E') {
            e.preventDefault();
            togglePick();
        }
    });

    return {
        load,
        unload,
        togglePick,
        openInNewTab,
        setPicking,
        clearPendingAnchor,
        pinNumbers,
        sendPins,
        focusComment,
        onDrawMode,
        drawingView,
        showDrawing,
        isActive
    };
})();
