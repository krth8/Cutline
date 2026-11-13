/**
 * UserManager - Centralized user state and permissions
 * Wraps AppState auth properties with convenience methods
 */
const UserManager = (function() {
    // Private
    let currentProjectAccess = null;

    return {
        // ============ Getters ============
        getUser() {
            return AppState.adminUser;
        },

        getUserId() {
            return AppState.adminUser?.id || null;
        },

        getUsername() {
            return AppState.adminUser?.username || AppState.userName || 'Guest';
        },

        getRole() {
            return AppState.adminUser?.role || 'guest';
        },

        isLoggedIn() {
            return !!AppState.adminUser || AppState.isShareLinkGuest;
        },

        isAdmin() {
            return AppState.isAdmin || AppState.adminUser?.role === 'admin';
        },

        isGuest() {
            return AppState.isShareLinkGuest && !AppState.adminUser;
        },

        // ============ Project Access ============
        setCurrentProjectAccess(access) {
            currentProjectAccess = access;
        },

        getCurrentProjectAccess() {
            return currentProjectAccess;
        },

        /**
         * Check if user can review in current/specified project
         */
        canReview(projectId = null) {
            if (this.isAdmin()) return true;
            if (this.isGuest()) return true; // Guests can review via share link

            const access = currentProjectAccess;
            if (!access) return false;

            if (projectId && access.projectId !== projectId) {
                // Would need to fetch access for different project
                return false;
            }

            return access.canReview === true;
        },

        /**
         * Check if user can manage tasks in current/specified project
         */
        canTasks(projectId = null) {
            if (this.isAdmin()) return true;
            if (this.isGuest()) return false; // Guests cannot manage tasks

            const access = currentProjectAccess;
            if (!access) return false;

            if (projectId && access.projectId !== projectId) {
                return false;
            }

            return access.canTasks === true;
        },

        /**
         * Check if user owns the current project
         */
        isProjectOwner(projectId = null) {
            if (this.isAdmin()) return true;

            const access = currentProjectAccess;
            if (!access) return false;

            if (projectId && access.projectId !== projectId) {
                return false;
            }

            return access.isOwner === true;
        },

        /**
         * Check if user can perform admin actions
         */
        canAdmin() {
            return this.isAdmin();
        },

        /**
         * Check if user can delete clips/comments (owner or admin)
         */
        canDelete(resourceOwnerId = null) {
            if (this.isAdmin()) return true;
            if (this.isProjectOwner()) return true;

            // Can delete own resources
            if (resourceOwnerId && resourceOwnerId === this.getUserId()) {
                return true;
            }

            return false;
        },

        // ============ Auth Actions ============
        /**
         * Set project access from projects list data
         * (Projects API returns canReview, canTasks, isOwner per project)
         */
        setProjectAccessFromList(projectId) {
            if (this.isAdmin()) {
                currentProjectAccess = {
                    projectId,
                    canReview: true,
                    canTasks: true,
                    isOwner: true
                };
                return currentProjectAccess;
            }

            // Find project in AppState.projects (includes access info)
            const project = AppState.projects?.find(p => p.id === projectId);
            if (project) {
                currentProjectAccess = {
                    projectId,
                    canReview: project.canReview !== false, // Default true for backwards compat
                    canTasks: project.canTasks === true,
                    isOwner: project.isOwner === true
                };
            } else {
                currentProjectAccess = null;
            }

            return currentProjectAccess;
        },

        /**
         * Clear current session
         */
        logout() {
            localStorage.removeItem('authData');
            currentProjectAccess = null;
            AppState.reset();
        },

        // ============ Preferences ============
        /**
         * Get user preference from localStorage
         */
        getPreference(key, defaultValue = null) {
            const userId = this.getUserId() || 'guest';
            const storageKey = `pref_${userId}_${key}`;
            const stored = localStorage.getItem(storageKey);

            if (stored === null) return defaultValue;

            try {
                return JSON.parse(stored);
            } catch {
                return stored;
            }
        },

        /**
         * Set user preference in localStorage
         */
        setPreference(key, value) {
            const userId = this.getUserId() || 'guest';
            const storageKey = `pref_${userId}_${key}`;

            if (value === null || value === undefined) {
                localStorage.removeItem(storageKey);
            } else {
                localStorage.setItem(storageKey, JSON.stringify(value));
            }
        },

        // ============ Display Helpers ============
        getInitials() {
            const name = this.getUsername();
            if (!name) return '?';

            const parts = name.split(/[\s_-]+/);
            if (parts.length >= 2) {
                return (parts[0][0] + parts[1][0]).toUpperCase();
            }
            return name.substring(0, 2).toUpperCase();
        },

        getDisplayName() {
            return this.getUsername();
        },

        getProfileImage() {
            return AppState.adminUser?.profileImage || null;
        }
    };
})();

// Export to global scope
window.UserManager = UserManager;
