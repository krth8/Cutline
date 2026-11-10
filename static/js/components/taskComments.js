/**
 * TaskComments Component
 * Reusable component for displaying and managing task comments
 */

class TaskComments {
    constructor(containerId, taskId) {
        this.container = document.getElementById(containerId);
        this.taskId = taskId;
        this.comments = [];
        this.isLoading = false;
    }

    /**
     * Initialize the component for a task
     */
    async init(taskId) {
        this.taskId = taskId;
        this.comments = [];
        await this.loadComments();
    }

    /**
     * Load comments from API
     */
    async loadComments() {
        if (!this.taskId) return;

        this.isLoading = true;
        this.render();

        const { data, error } = await API.getTaskComments(this.taskId);

        if (error) {
            console.error('Failed to load task comments:', error);
            this.comments = [];
        } else {
            this.comments = data?.comments || [];
        }

        this.isLoading = false;
        this.render();
    }

    /**
     * Submit a new comment (with optimistic UI)
     */
    async submitComment(text) {
        if (!text.trim() || !this.taskId) return;

        // Create optimistic comment immediately
        const tempId = 'temp-' + Date.now();
        const optimisticComment = {
            id: tempId,
            text: text,
            userName: AppState.userName || 'You',
            userId: AppState.userId,
            userProfileImage: AppState.userProfileImage,
            createdAt: new Date().toISOString(),
            isPending: true
        };

        // Add to UI immediately
        this.comments.push(optimisticComment);
        this.render();

        // Make API call in background
        const { data, error } = await API.createTaskComment(this.taskId, text);

        if (error) {
            console.error('Failed to create comment:', error);
            // Remove optimistic comment on failure
            this.comments = this.comments.filter(c => c.id !== tempId);
            this.render();
            showToast?.('Failed to add comment', 'error') || alert('Failed to add comment: ' + error);
            return false;
        }

        // Replace optimistic comment with real one
        if (data?.comment) {
            const idx = this.comments.findIndex(c => c.id === tempId);
            if (idx > -1) {
                this.comments[idx] = data.comment;
            }
            this.render();
        }

        return true;
    }

    /**
     * Delete a comment (with optimistic UI)
     */
    async deleteComment(commentId) {
        if (!confirm('Delete this comment?')) return;

        // Find comment and mark as deleting
        const comment = this.comments.find(c => c.id === commentId);
        if (!comment) return;

        // Optimistic: mark as deleting and re-render
        comment.isDeleting = true;
        this.render();

        const { error } = await API.deleteTaskComment(this.taskId, commentId);

        if (error) {
            console.error('Failed to delete comment:', error);
            // Restore comment on failure
            comment.isDeleting = false;
            this.render();
            showToast?.('Failed to delete comment', 'error') || alert('Failed to delete comment: ' + error);
            return;
        }

        // Remove from local list on success
        this.comments = this.comments.filter(c => c.id !== commentId);
        this.render();
    }

    /**
     * Get initials from a name
     */
    getInitials(name) {
        if (!name) return '?';
        const parts = name.split(/[\s_-]+/);
        if (parts.length >= 2) {
            return (parts[0][0] + parts[1][0]).toUpperCase();
        }
        return name.substring(0, 2).toUpperCase();
    }

    /**
     * Format relative time
     */
    formatTimeAgo(dateStr) {
        if (!dateStr) return '';

        const date = new Date(dateStr);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        if (diffMins < 1) return 'just now';
        if (diffMins < 60) return `${diffMins}m ago`;
        if (diffHours < 24) return `${diffHours}h ago`;
        if (diffDays < 7) return `${diffDays}d ago`;

        return date.toLocaleDateString('nb-NO', { day: 'numeric', month: 'short' });
    }

    /**
     * Escape HTML
     */
    escapeHtml(str) {
        if (str == null) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Render the comments UI
     */
    render() {
        if (!this.container) return;

        // Loading state
        if (this.isLoading) {
            this.container.innerHTML = `
                <div class="task-comments-loading">Loading comments...</div>
            `;
            return;
        }

        // Render comments list
        const commentsHtml = this.comments.length > 0
            ? this.comments.map(c => this.renderComment(c)).join('')
            : '<div class="task-comments-empty">No comments yet</div>';

        // Render full component with header inside
        this.container.innerHTML = `
            <div class="task-comments">
                <div class="task-modal-section-header">
                    <label>
                        <svg class="icon icon-sm"><use href="/static/icons.svg#icon-chat-circle"/></svg>
                        Comments <span class="task-modal-count" id="taskDetailCommentsCount">(${this.comments.length})</span>
                    </label>
                </div>
                <div class="task-comments-list">
                    ${commentsHtml}
                </div>
                <div class="task-comments-input">
                    <div class="task-comment-input-box">
                        <textarea class="task-comment-input"
                                  placeholder="Add a comment..."
                                  id="taskCommentInput"
                                  rows="1"
                                  onkeydown="window._taskCommentsInstance?.handleInputKeydown(event)"
                                  oninput="this.style.height = 'auto'; this.style.height = this.scrollHeight + 'px'"></textarea>
                    </div>
                    <button class="task-comment-submit-btn" onclick="window._taskCommentsInstance?.handleSubmit()" title="Post comment">
                        <svg class="icon"><use href="/static/icons.svg#icon-arrow-right"/></svg>
                    </button>
                </div>
            </div>
        `;

        // Store reference for event handlers
        window._taskCommentsInstance = this;
    }

    /**
     * Render a single comment
     */
    renderComment(comment) {
        const initials = this.getInitials(comment.userName);
        const canDelete = comment.userId === AppState.userId || AppState.isAdmin;
        const profileImage = comment.userProfileImage;
        const isPending = comment.isPending || comment.isDeleting;

        // Avatar: show profile image if available, otherwise initials
        const avatarContent = profileImage
            ? `<img src="${profileImage}" alt="${this.escapeHtml(comment.userName)}" class="task-comment-avatar-img">`
            : initials;
        const avatarStyle = profileImage ? 'background:transparent' : '';
        const pendingStyle = isPending ? 'opacity: 0.5; pointer-events: none;' : '';

        return `
            <div class="task-comment-item${isPending ? ' pending' : ''}" data-comment-id="${comment.id}" style="${pendingStyle}">
                <div class="task-comment-avatar" style="${avatarStyle}">${avatarContent}</div>
                <div class="task-comment-content">
                    <div class="task-comment-header">
                        <span class="task-comment-author">${this.escapeHtml(comment.userName)}</span>
                        <span class="task-comment-time">${this.formatTimeAgo(comment.createdAt)}</span>
                        ${canDelete && !isPending ? `
                            <button class="task-comment-delete" onclick="window._taskCommentsInstance?.deleteComment('${comment.id}')" title="Delete">
                                <svg class="icon icon-xs"><use href="/static/icons.svg#icon-trash"/></svg>
                            </button>
                        ` : ''}
                    </div>
                    <div class="task-comment-text">${this.escapeHtml(comment.text)}</div>
                </div>
            </div>
        `;
    }

    /**
     * Handle input keydown
     */
    handleInputKeydown(event) {
        if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            this.handleSubmit();
        }
    }

    /**
     * Handle submit button click
     */
    async handleSubmit() {
        const input = document.getElementById('taskCommentInput');
        if (!input) return;

        const text = input.value.trim();
        if (!text) return;

        // Clear input and reset height immediately
        input.value = '';
        input.style.height = 'auto';

        const success = await this.submitComment(text);
        if (!success) {
            // Restore text if failed
            input.value = text;
            input.style.height = input.scrollHeight + 'px';
        }

        // Re-focus input
        input.focus();
    }

    /**
     * Get comment count
     */
    getCount() {
        return this.comments.length;
    }
}

// Export to global scope
window.TaskComments = TaskComments;
