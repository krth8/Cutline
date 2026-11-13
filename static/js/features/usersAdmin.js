/**
 * Settings > Users (admin only)
 * Accounts with their role, email and per-project access, plus share-link guests.
 */
const UsersAdmin = (() => {
    const ROLES = [
        { id: 'admin', label: 'Admin' },
        { id: 'editor', label: 'Editor' },
        { id: 'viewer', label: 'Viewer' },
    ];
    const ROLE_COLORS = { admin: '#6366f1', editor: '#22c55e', viewer: '#4a5568' };
    const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

    let users = [];
    let projects = [];
    const openUsers = new Set();
    let bound = false;

    const icon = (name) => `<svg class="icon icon-sm"><use href="/static/icons.svg#${name}"/></svg>`;
    const initials = (name) => escapeHtml((name || '?').substring(0, 2).toUpperCase());
    const isSelf = (user) => user.id === AppState.adminUser?.id;
    const findUser = (id) => users.find(u => u.id === id);

    // ---------- Users ----------

    async function loadUsers() {
        const container = document.getElementById('settingsUsersList');
        if (!container) return;
        bind();

        const [usersRes, projectsRes] = await Promise.all([
            API.request('/admin/users'),
            API.request('/projects'),
        ]);
        if (usersRes.error) {
            container.innerHTML = '<div class="users-list-empty">Failed to load users</div>';
            return;
        }
        users = usersRes.data?.users || [];
        projects = (projectsRes.data?.projects || []).slice().sort((a, b) => a.name.localeCompare(b.name));
        renderUsers();
    }

    function renderUsers() {
        const container = document.getElementById('settingsUsersList');
        if (!container) return;
        container.innerHTML = users.length
            ? users.map(userCard).join('')
            : '<div class="users-list-empty">No users</div>';
    }

    function accessSummary(user) {
        if (user.role === 'admin') return 'All projects';
        const n = (user.access || []).length;
        return n === 0 ? 'No projects' : `${n} project${n === 1 ? '' : 's'}`;
    }

    function userCard(user) {
        const open = openUsers.has(user.id);
        const self = isSelf(user);
        const meta = [user.email, accessSummary(user)].filter(Boolean).map(escapeHtml).join(' · ');
        const roleOptions = ROLES.map(r =>
            `<option value="${r.id}" ${r.id === user.role ? 'selected' : ''}>${r.label}</option>`).join('');

        return `
            <div class="user-card ${open ? 'open' : ''}" data-user-id="${escapeHtml(user.id)}">
                <div class="user-item" data-action="toggle">
                    <div class="user-item-avatar" style="background: ${ROLE_COLORS[user.role] || ROLE_COLORS.viewer}">${initials(user.username)}</div>
                    <div class="user-item-info">
                        <span class="user-item-name">${escapeHtml(user.username)}${self ? ' <span class="user-item-you">(you)</span>' : ''}</span>
                        <span class="user-item-role">${meta}</span>
                    </div>
                    <select class="input-small user-role-select" data-action="role" title="${self ? 'You cannot change your own role' : 'Role'}" ${self ? 'disabled' : ''}>${roleOptions}</select>
                    <button class="btn btn-ghost btn-small user-item-caret" title="${open ? 'Hide details' : 'Show details'}">${icon(open ? 'icon-caret-down' : 'icon-caret-right')}</button>
                </div>
                ${open ? userDetails(user, self) : ''}
            </div>`;
    }

    function userDetails(user, self) {
        return `
            <div class="user-details">
                <div class="user-detail-row">
                    <label class="input-label">Email</label>
                    <input type="email" class="input-small user-email-input" data-action="email" value="${escapeHtml(user.email || '')}" placeholder="No email on file" autocomplete="off">
                </div>
                <div class="user-detail-heading">Project access</div>
                ${accessEditor(user)}
                ${self ? '' : `
                <div class="user-detail-actions">
                    <button class="btn btn-ghost btn-small" data-action="password">${icon('icon-lock')} Set new password</button>
                    <button class="btn btn-ghost btn-small user-remove-btn" data-action="remove">${icon('icon-sign-out')} Remove user</button>
                </div>`}
            </div>`;
    }

    function accessEditor(user) {
        if (user.role === 'admin') {
            return '<div class="user-access-note">Admins can open every project. Change the role to limit access.</div>';
        }
        if (!projects.length) {
            return '<div class="user-access-note">There are no projects yet.</div>';
        }
        const byProject = Object.fromEntries((user.access || []).map(a => [a.projectId, a]));
        const rows = projects.map(p => {
            const a = byProject[p.id];
            const owner = a?.isOwner;
            return `
                <div class="access-row ${a ? 'has-access' : ''}" data-project-id="${escapeHtml(p.id)}">
                    <label class="access-project" title="${owner ? 'Project owner' : ''}">
                        <input type="checkbox" data-action="access" ${a ? 'checked' : ''} ${owner ? 'disabled' : ''}>
                        <span>${escapeHtml(p.name)}</span>
                        ${owner ? '<span class="access-owner">Owner</span>' : ''}
                    </label>
                    <label class="access-flag"><input type="checkbox" data-action="review" ${a?.canReview ? 'checked' : ''} ${a ? '' : 'disabled'}> Review</label>
                    <label class="access-flag"><input type="checkbox" data-action="tasks" ${a?.canTasks ? 'checked' : ''} ${a ? '' : 'disabled'}> Tasks</label>
                </div>`;
        }).join('');
        return `
            <div class="access-list">${rows}</div>
            <div class="user-access-note">Review covers clips and comments. Tasks covers the task list and docs.</div>`;
    }

    async function changeRole(user, select) {
        const role = select.value;
        const { error } = await API.request(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
        if (error) {
            Toast.error(error);
            select.value = user.role;
            return;
        }
        Toast.success(`${user.username} is now ${role === 'viewer' ? 'a viewer' : role === 'editor' ? 'an editor' : 'an admin'}`);
        await loadUsers();
    }

    async function changeEmail(user, input) {
        const email = input.value.trim();
        if (email === (user.email || '')) return;
        if (email && !EMAIL_RE.test(email)) {
            Toast.error("That doesn't look like an email address");
            input.value = user.email || '';
            return;
        }
        const { error } = await API.request(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ email }) });
        if (error) {
            Toast.error(error);
            input.value = user.email || '';
            return;
        }
        user.email = email || null;
        Toast.success(email ? 'Email saved' : 'Email removed');
        renderUsers();
    }

    async function changeAccess(user, projectId, action, checkbox) {
        const project = projects.find(p => p.id === projectId);
        const current = (user.access || []).find(a => a.projectId === projectId);
        let res;
        if (action === 'access' && checkbox.checked) {
            res = await API.request(`/projects/${projectId}/access`, {
                method: 'POST',
                body: JSON.stringify({ userId: user.id, canReview: true, canTasks: false }),
            });
        } else if (action === 'access') {
            res = await API.request(`/projects/${projectId}/access/${user.id}`, { method: 'DELETE' });
        } else {
            res = await API.request(`/projects/${projectId}/access/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify({
                    canReview: action === 'review' ? checkbox.checked : !!current?.canReview,
                    canTasks: action === 'tasks' ? checkbox.checked : !!current?.canTasks,
                }),
            });
        }
        if (res.error) {
            Toast.error(res.error);
            checkbox.checked = !checkbox.checked;
            return;
        }
        if (action === 'access') {
            Toast.success(checkbox.checked
                ? `${user.username} can now open ${project?.name || 'the project'}`
                : `${user.username} was removed from ${project?.name || 'the project'}`);
        }
        await loadUsers();
    }

    function setPassword(user) {
        const modal = new Modal({
            title: `New password for ${user.username}`,
            content: `
                <p class="register-description">They are not told about this. Send them the new password yourself.</p>
                <div class="form-group">
                    <input type="text" id="adminNewPassword" class="input-large" placeholder="At least 12 characters" autocomplete="off">
                </div>
                <div class="register-error hidden" id="adminNewPasswordError"></div>
                <button class="btn btn-primary btn-large" id="adminNewPasswordSave" style="width: 100%;">Save password</button>`,
            size: 'small',
            onOpen: () => setTimeout(() => {
                const input = document.getElementById('adminNewPassword');
                const errorEl = document.getElementById('adminNewPasswordError');
                const save = async () => {
                    const password = input.value;
                    const fail = (msg) => { errorEl.textContent = msg; errorEl.classList.remove('hidden'); };
                    if (password.length < 12) return fail('Password must be at least 12 characters');
                    const { error } = await API.request(`/admin/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ password }) });
                    if (error) return fail(error);
                    modal.close();
                    Toast.success(`Password changed for ${user.username}`);
                };
                document.getElementById('adminNewPasswordSave')?.addEventListener('click', save);
                input?.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
                input?.focus();
            }, 50),
        });
        modal.open();
    }

    async function removeUser(user) {
        const confirmed = await Confirm.danger(
            `Remove ${user.username}? They are logged out right away and lose access to every project. Their comments stay.`,
            'Remove user');
        if (!confirmed) return;
        const { error } = await API.request(`/admin/users/${user.id}`, { method: 'DELETE' });
        if (error) {
            Toast.error('Could not remove user: ' + error);
            return;
        }
        openUsers.delete(user.id);
        Toast.success(`${user.username} was removed`);
        await loadUsers();
    }

    // ---------- Guests ----------

    let guests = [];

    async function loadGuests() {
        const container = document.getElementById('settingsGuestsList');
        if (!container) return;
        bind();

        const { data, error } = await API.request('/admin/guests');
        if (error) {
            container.innerHTML = '<div class="users-list-empty">Failed to load guests</div>';
            return;
        }
        guests = data?.guests || [];
        if (!guests.length) {
            container.innerHTML = '<div class="users-list-empty">No guests yet</div>';
            return;
        }
        container.innerHTML = guests.map(guest => {
            const meta = [guest.email, guest.projectName, `last seen ${formatRelativeTime(guest.lastSeen)}`]
                .filter(Boolean).map(escapeHtml).join(' · ');
            return `
                <div class="user-item guest-item" data-guest-id="${escapeHtml(guest.id)}">
                    <div class="user-item-avatar" style="background: #10b981">${initials(guest.name)}</div>
                    <div class="user-item-info">
                        <span class="user-item-name">${escapeHtml(guest.name)}</span>
                        <span class="user-item-role">${meta}</span>
                    </div>
                    <button class="btn btn-ghost btn-small user-remove-btn" data-action="kick-guest" title="Kick this guest out">${icon('icon-sign-out')} Kick</button>
                </div>`;
        }).join('');
    }

    async function kickGuest(guest) {
        const confirmed = await Confirm.show({
            title: `Kick ${guest.name}?`,
            message: `They lose access to ${guest.projectName || 'the project'} right away. `
                + 'They can come back through the share link while it is active. Delete the link under Sharing to keep them out.',
            confirmText: 'Kick guest',
            type: 'warning',
        });
        if (!confirmed) return;
        const { error } = await API.request(`/admin/guests/${guest.id}`, { method: 'DELETE' });
        if (error) {
            Toast.error('Could not kick guest: ' + error);
            return;
        }
        Toast.success(`${guest.name} was kicked out`);
        loadGuests();
    }

    // ---------- Events ----------

    function bind() {
        if (bound) return;
        const usersEl = document.getElementById('settingsUsersList');
        const guestsEl = document.getElementById('settingsGuestsList');
        if (!usersEl || !guestsEl) return;
        bound = true;

        usersEl.addEventListener('click', (e) => {
            const card = e.target.closest('.user-card');
            const user = card && findUser(card.dataset.userId);
            if (!user) return;
            const action = e.target.closest('[data-action]')?.dataset.action;
            if (action === 'password') return setPassword(user);
            if (action === 'remove') return removeUser(user);
            // Clicking the row (not a control inside it) opens or closes the details
            if (action === 'toggle' && !e.target.closest('select, input')) {
                openUsers.has(user.id) ? openUsers.delete(user.id) : openUsers.add(user.id);
                renderUsers();
            }
        });

        usersEl.addEventListener('change', (e) => {
            const card = e.target.closest('.user-card');
            const user = card && findUser(card.dataset.userId);
            if (!user) return;
            const action = e.target.dataset.action;
            if (action === 'role') return changeRole(user, e.target);
            if (action === 'email') return changeEmail(user, e.target);
            const row = e.target.closest('.access-row');
            if (row && ['access', 'review', 'tasks'].includes(action)) {
                changeAccess(user, row.dataset.projectId, action, e.target);
            }
        });

        usersEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && e.target.dataset.action === 'email') e.target.blur();
        });

        guestsEl.addEventListener('click', (e) => {
            if (e.target.closest('[data-action="kick-guest"]')) {
                const guest = guests.find(g => g.id === e.target.closest('.guest-item')?.dataset.guestId);
                if (guest) kickGuest(guest);
            }
        });
    }

    return { loadUsers, loadGuests };
})();

function loadSettingsUsers() { return UsersAdmin.loadUsers(); }
function loadSettingsGuests() { return UsersAdmin.loadGuests(); }
window.loadSettingsUsers = loadSettingsUsers;
window.loadSettingsGuests = loadSettingsGuests;
