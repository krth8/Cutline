/**
 * HTML clip review (Cutline side).
 *
 * HTML clips are shown in a sandboxed iframe (#htmlFrame). The page gets a small
 * bridge script injected by the server (html-review-bridge.js); this file talks to it:
 * - "Comment on element" puts the page in pick mode; the picked element's anchor is
 *   attached to the next comment (AppState.pendingAnchor).
 * - Comments with anchors on the current version are shown as numbered pins in the page.
 * - Clicking a comment navigates the page to the element; clicking a pin highlights the comment.
 */
const HtmlReview = (() => {
    let frame = null;
    let baseUrl = null;          // tokened page URL without hash
    let loadedKey = null;        // `${baseName}:${version}` currently in the frame
    let ready = false;
    let pendingFocus = null;     // comment to focus once the page is ready
    let picking = false;

    function getFrame() {
        if (!frame) frame = document.getElementById('htmlFrame');
        return frame;
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

        const key = `${baseName}:${clip.version}`;
        if (key === loadedKey && ready) {
            sendPins();
            return;
        }

        loadedKey = key;
        ready = false;
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
        setPicking(false);
        clearPendingAnchor();
    }

    function reloadAtHash(hash) {
        const f = getFrame();
        if (!f || !baseUrl) return;
        ready = false;
        f.src = baseUrl + (hash || '');
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
        const baseName = AppState.currentClip?.baseName;
        return (AppState.comments || []).filter(c => c.clipBaseName === baseName);
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

    function focusComment(comment) {
        if (!comment?.anchor) return;
        if (!ready) {
            pendingFocus = comment;
            return;
        }
        post({ type: 'focus', id: comment.id, anchor: comment.anchor });
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
                if (pendingFocus) {
                    const c = pendingFocus;
                    pendingFocus = null;
                    post({ type: 'focus', id: c.id, anchor: c.anchor, retried: true });
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
            case 'pinClick':
                if (typeof msg.id === 'string') highlightComment(msg.id);
                break;
            case 'needsReload': {
                const comment = (AppState.comments || []).find(c => c.id === msg.id);
                if (comment && typeof msg.hash === 'string' && msg.hash.startsWith('#')) {
                    pendingFocus = comment;
                    reloadAtHash(msg.hash);
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
        setPicking,
        clearPendingAnchor,
        pinNumbers,
        sendPins,
        focusComment,
        isActive
    };
})();
