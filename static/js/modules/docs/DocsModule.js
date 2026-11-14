/**
 * DocsModule - Document management with nested folders
 * Handles document CRUD, folder tree, and real-time collaboration
 */

const DocsModule = {
    projectId: null,
    currentProject: null,
    folders: [],
    documents: [],
    currentDocId: null,
    currentDoc: null,
    expandedFolders: new Set(),
    expandedProjects: new Set(),  // Track which projects are expanded
    projectDocuments: {},          // Cache documents per project { projectId: [] }
    projectFolders: {},            // Cache folders per project { projectId: [] }
    loadingProjects: new Set(),    // Track which projects are currently loading
    saveTimeout: null,
    titleSaveTimeout: null,        // Debounce for title autosave

    // WebSocket collaboration
    ws: null,
    userId: null,
    userName: null,
    collaborators: [],
    isRemoteUpdate: false,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    heartbeatInterval: null,

    /**
     * Initialize the docs module (with optional project)
     */
    async init(projectId = null) {
        // The server knows us by our account, so use the same id to tell ourselves from others
        this.userId = AppState.adminUser?.id || this.getOrCreateUserId();
        this.userName = AppState.adminUser?.username || `User ${this.userId.slice(0, 4)}`;

        // Try to restore project from: parameter > AppState > localStorage
        let targetProjectId = projectId;

        if (!targetProjectId && typeof AppState !== 'undefined' && AppState.projectId) {
            targetProjectId = AppState.projectId;
        }

        if (!targetProjectId) {
            targetProjectId = localStorage.getItem('docsProjectId');
        }

        if (targetProjectId) {
            // Don't await - selectProject renders immediately then loads in background
            this.selectProject(targetProjectId);
        } else {
            this.render();
        }

        // Subscribe to projects changes to re-render when projects load
        if (typeof AppState !== 'undefined' && AppState.subscribe) {
            AppState.subscribe(['projects'], () => {
                // Re-render to show projects list
                if (!this.currentDocId) {
                    this.render();
                }
            });
        }

        this.attachEventListeners();
    },

    /**
     * Select a project and load its documents
     */
    async selectProject(projectId) {
        this.projectId = projectId;

        // Save selected project for persistence
        localStorage.setItem('docsProjectId', projectId);

        // Get project info
        if (typeof AppState !== 'undefined' && AppState.projects) {
            this.currentProject = AppState.projects.find(p => p.id === projectId);
        }

        // Auto-expand the selected project
        this.expandedProjects.add(projectId);

        // Render immediately with loading state (non-blocking UI)
        this.loadingProjects.add(projectId);
        this.render();

        // Load data in background
        await this.loadData();

        // Re-render with actual data
        this.loadingProjects.delete(projectId);
        this.render();
    },

    /**
     * Toggle project expansion (load documents if not cached)
     */
    async toggleProject(projectId) {
        if (this.expandedProjects.has(projectId)) {
            this.expandedProjects.delete(projectId);
            this.render();
        } else {
            this.expandedProjects.add(projectId);
            // Load documents for this project if not cached
            if (!this.projectDocuments[projectId]) {
                // Show loading state immediately
                this.loadingProjects.add(projectId);
                this.render();

                // Load data in background
                await this.loadProjectData(projectId);

                // Re-render with actual data
                this.loadingProjects.delete(projectId);
            }
            this.render();
        }
    },

    /**
     * Load documents and folders for a specific project
     */
    async loadProjectData(projectId) {
        try {
            // Use consolidated endpoint for better performance (1 request instead of 2)
            const res = await API.request(`/projects/${projectId}/docs-tree`);

            this.projectFolders[projectId] = res.data?.folders || [];
            this.projectDocuments[projectId] = res.data?.documents || [];
        } catch (err) {
            console.error('Failed to load project data:', err);
            this.projectFolders[projectId] = [];
            this.projectDocuments[projectId] = [];
        }
    },

    /**
     * Get or create a persistent user ID
     */
    getOrCreateUserId() {
        let userId = localStorage.getItem('docsUserId');
        if (!userId) {
            userId = 'u' + Math.random().toString(36).substr(2, 8);
            localStorage.setItem('docsUserId', userId);
        }
        return userId;
    },

    /**
     * Load folders and documents from API
     */
    async loadData() {
        if (!this.projectId) return;

        try {
            // Use consolidated endpoint for better performance (1 request instead of 2)
            const res = await API.request(`/projects/${this.projectId}/docs-tree`);

            console.log('Docs tree response:', res);

            this.folders = res.data?.folders || [];
            this.documents = res.data?.documents || [];

            // Also cache in project-specific storage
            this.projectFolders[this.projectId] = this.folders;
            this.projectDocuments[this.projectId] = this.documents;

            console.log('Loaded folders:', this.folders);
            console.log('Loaded documents:', this.documents);
        } catch (err) {
            console.error('Failed to load docs data:', err);
            this.folders = [];
            this.documents = [];
        }
    },

    /**
     * Render the docs view
     */
    render() {
        const container = document.getElementById('viewDocs');
        if (!container) return;

        const projects = (typeof AppState !== 'undefined' && AppState.projects) || [];

        // If no projects, show empty state
        if (projects.length === 0) {
            container.innerHTML = this.renderProjectSelector();
            return;
        }

        // Render projects as expandable tree items
        const projectsTree = projects.map(p => {
            const isExpanded = this.expandedProjects.has(p.id);
            const isActive = p.id === this.projectId;
            const projectDocs = this.projectDocuments[p.id] || [];
            const projectFlds = this.projectFolders[p.id] || [];

            return `
                <div class="docs-tree-project ${isActive ? 'active' : ''}" data-project-id="${p.id}">
                    <div class="docs-tree-item docs-tree-project-header"
                         onclick="DocsModule.toggleProject('${p.id}')">
                        <svg class="icon icon-sm docs-tree-chevron ${isExpanded ? 'expanded' : ''}">
                            <use href="/static/icons.svg#icon-caret-right"/>
                        </svg>
                        <div class="docs-project-thumb-mini" ${p.coverImage ? `style="background-image: url('${p.coverImage}')"` : ''}></div>
                        <span class="docs-tree-name">${this.escapeHtml(p.name)}</span>
                        <div class="docs-tree-item-actions">
                            <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.selectProject('${p.id}'); DocsModule.createFolder()" title="New folder">
                                <svg class="icon"><use href="/static/icons.svg#icon-folder-plus"/></svg>
                            </button>
                            <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.selectProject('${p.id}'); DocsModule.createDocument()" title="New document">
                                <svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg>
                            </button>
                        </div>
                    </div>
                    <div class="docs-tree-children ${isExpanded ? '' : 'hidden'}">
                        ${isExpanded ? this.renderProjectTree(p.id, projectFlds, projectDocs) : ''}
                    </div>
                </div>
            `;
        }).join('');

        container.innerHTML = `
            <div class="docs-layout">
                <aside class="docs-sidebar">
                    <div class="docs-sidebar-section">
                        <div class="docs-sidebar-section-header">
                            <span>Projects</span>
                        </div>
                        <div class="docs-tree" id="docsTree">
                            ${projectsTree}
                        </div>
                    </div>
                </aside>
                <main class="docs-editor-area">
                    ${this.currentDoc ? this.renderEditor() : this.renderEmptyState()}
                </main>
            </div>
        `;
        this.restoreTodoState(document.getElementById('docsEditorContent'));
    },

    /**
     * Render document tree for a specific project
     */
    renderProjectTree(projectId, folders, documents) {
        // Show loading indicator if project is loading
        if (this.loadingProjects.has(projectId)) {
            return '<div class="docs-loading-tree" style="padding-left: 28px; opacity: 0.7;"><span class="spinner-sm" style="margin-right: 8px;"></span>Loading...</div>';
        }

        const tree = this.buildTreeForProject(folders, documents);
        if (tree.length === 0) {
            return '<div class="docs-empty-tree" style="padding-left: 28px;">No documents yet</div>';
        }
        return this.renderTreeNodesForProject(tree, 1, projectId);
    },

    /**
     * Build tree from folders/documents for a specific project
     */
    buildTreeForProject(folders, documents) {
        const nodes = [];

        // Add root-level folders
        const rootFolders = folders.filter(f => !f.parentId);
        rootFolders.sort((a, b) => a.sortOrder - b.sortOrder);

        for (const folder of rootFolders) {
            nodes.push(this.buildFolderNodeForProject(folder, folders, documents));
        }

        // Add root-level documents
        const rootDocs = documents.filter(d => !d.folderId);
        rootDocs.sort((a, b) => a.sortOrder - b.sortOrder);

        for (const doc of rootDocs) {
            nodes.push({ type: 'document', data: doc });
        }

        return nodes;
    },

    /**
     * Recursively build folder node with children for a project
     */
    buildFolderNodeForProject(folder, folders, documents) {
        const children = [];

        // Add subfolders
        const subfolders = folders.filter(f => f.parentId === folder.id);
        subfolders.sort((a, b) => a.sortOrder - b.sortOrder);
        for (const sub of subfolders) {
            children.push(this.buildFolderNodeForProject(sub, folders, documents));
        }

        // Add documents in this folder
        const docs = documents.filter(d => d.folderId === folder.id);
        docs.sort((a, b) => a.sortOrder - b.sortOrder);
        for (const doc of docs) {
            children.push({ type: 'document', data: doc });
        }

        return { type: 'folder', data: folder, children };
    },

    /**
     * Render tree nodes for a project
     */
    renderTreeNodesForProject(nodes, depth, projectId) {
        if (!nodes.length) return '';

        return nodes.map(node => {
            if (node.type === 'folder') {
                const isExpanded = this.expandedFolders.has(node.data.id);
                return `
                    <div class="docs-tree-folder" data-folder-id="${node.data.id}">
                        <div class="docs-tree-item docs-tree-folder-header"
                             style="padding-left: ${12 + depth * 16}px"
                             onclick="DocsModule.toggleFolder('${node.data.id}')">
                            <svg class="icon icon-sm docs-tree-chevron ${isExpanded ? 'expanded' : ''}">
                                <use href="/static/icons.svg#icon-caret-right"/>
                            </svg>
                            <svg class="icon icon-sm docs-tree-icon">
                                <use href="/static/icons.svg#icon-folder${isExpanded ? '-open' : ''}"/>
                            </svg>
                            <span class="docs-tree-name">${this.escapeHtml(node.data.name)}</span>
                            <div class="docs-tree-item-actions">
                                <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.selectProject('${projectId}'); DocsModule.createDocument('${node.data.id}')" title="Add document">
                                    <svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg>
                                </button>
                                <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.deleteFolder('${node.data.id}')" title="Delete folder">
                                    <svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="docs-tree-children ${isExpanded ? '' : 'hidden'}">
                            ${this.renderTreeNodesForProject(node.children, depth + 1, projectId)}
                        </div>
                    </div>
                `;
            } else {
                const isActive = this.currentDocId === node.data.id;
                return `
                    <div class="docs-tree-item docs-tree-document ${isActive ? 'active' : ''}"
                         style="padding-left: ${12 + depth * 16}px"
                         data-doc-id="${node.data.id}"
                         onclick="DocsModule.selectProject('${projectId}'); DocsModule.openDocument('${node.data.id}')">
                        <svg class="icon icon-sm docs-tree-icon">
                            <use href="/static/icons.svg#icon-file-text"/>
                        </svg>
                        <span class="docs-tree-name">${this.escapeHtml(node.data.title)}</span>
                        <div class="docs-tree-item-actions">
                            <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.deleteDocument('${node.data.id}')" title="Delete">
                                <svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg>
                            </button>
                        </div>
                    </div>
                `;
            }
        }).join('');
    },

    /**
     * Render project selector screen
     */
    renderProjectSelector() {
        const projects = (typeof AppState !== 'undefined' && AppState.projects) || [];

        if (projects.length === 0) {
            return `
                <div class="docs-no-projects">
                    <div class="placeholder-icon">
                        <svg class="icon icon-2xl"><use href="/static/icons.svg#icon-folder"/></svg>
                    </div>
                    <h3>No Projects</h3>
                    <p>Create a project in the Projects tab first</p>
                </div>
            `;
        }

        const projectCards = projects.map(p => `
            <div class="docs-project-card" onclick="DocsModule.selectProject('${p.id}')">
                <div class="docs-project-card-cover" ${p.coverImage ? `style="background-image: url('${p.coverImage}')"` : ''}></div>
                <div class="docs-project-card-info">
                    <span class="docs-project-card-name">${this.escapeHtml(p.name)}</span>
                </div>
            </div>
        `).join('');

        return `
            <div class="docs-project-selector-view">
                <h2>Select a Project</h2>
                <p>Choose a project to view its documents</p>
                <div class="docs-project-grid">
                    ${projectCards}
                </div>
            </div>
        `;
    },

    /**
     * Show project dropdown for switching
     */
    showProjectDropdown(event) {
        event.stopPropagation();
        const projects = (typeof AppState !== 'undefined' && AppState.projects) || [];

        const items = projects.map(p => ({
            label: p.name,
            icon: p.id === this.projectId ? 'icon-check' : 'icon-folder',
            action: () => this.selectProject(p.id)
        }));

        if (typeof showContextMenu === 'function') {
            showContextMenu(event.currentTarget, items, { align: 'left' });
        }
    },

    /**
     * Render folder tree with nested structure
     */
    renderTree() {
        // Build tree structure
        const tree = this.buildTree();
        return this.renderTreeNodes(tree, 0);
    },

    /**
     * Build tree from flat folder/document lists
     */
    buildTree() {
        const nodes = [];

        // Add root-level folders
        const rootFolders = this.folders.filter(f => !f.parentId);
        rootFolders.sort((a, b) => a.sortOrder - b.sortOrder);

        for (const folder of rootFolders) {
            nodes.push(this.buildFolderNode(folder));
        }

        // Add root-level documents
        const rootDocs = this.documents.filter(d => !d.folderId);
        rootDocs.sort((a, b) => a.sortOrder - b.sortOrder);

        for (const doc of rootDocs) {
            nodes.push({ type: 'document', data: doc });
        }

        return nodes;
    },

    /**
     * Recursively build folder node with children
     */
    buildFolderNode(folder) {
        const children = [];

        // Add subfolders
        const subfolders = this.folders.filter(f => f.parentId === folder.id);
        subfolders.sort((a, b) => a.sortOrder - b.sortOrder);
        for (const sub of subfolders) {
            children.push(this.buildFolderNode(sub));
        }

        // Add documents in this folder
        const docs = this.documents.filter(d => d.folderId === folder.id);
        docs.sort((a, b) => a.sortOrder - b.sortOrder);
        for (const doc of docs) {
            children.push({ type: 'document', data: doc });
        }

        return { type: 'folder', data: folder, children };
    },

    /**
     * Render tree nodes recursively
     */
    renderTreeNodes(nodes, depth) {
        if (!nodes.length) {
            return depth === 0 ? '<div class="docs-empty-tree">No documents yet</div>' : '';
        }

        return nodes.map(node => {
            if (node.type === 'folder') {
                const isExpanded = this.expandedFolders.has(node.data.id);
                const hasChildren = node.children.length > 0;
                return `
                    <div class="docs-tree-folder" data-folder-id="${node.data.id}">
                        <div class="docs-tree-item docs-tree-folder-header"
                             style="padding-left: ${12 + depth * 16}px"
                             onclick="DocsModule.toggleFolder('${node.data.id}')">
                            <svg class="icon icon-sm docs-tree-chevron ${isExpanded ? 'expanded' : ''}">
                                <use href="/static/icons.svg#icon-caret-right"/>
                            </svg>
                            <svg class="icon icon-sm docs-tree-icon">
                                <use href="/static/icons.svg#icon-folder${isExpanded ? '-open' : ''}"/>
                            </svg>
                            <span class="docs-tree-name">${this.escapeHtml(node.data.name)}</span>
                            <div class="docs-tree-item-actions">
                                <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.createDocument('${node.data.id}')" title="Add document">
                                    <svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg>
                                </button>
                                <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.deleteFolder('${node.data.id}')" title="Delete folder">
                                    <svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="docs-tree-children ${isExpanded ? '' : 'hidden'}">
                            ${this.renderTreeNodes(node.children, depth + 1)}
                        </div>
                    </div>
                `;
            } else {
                const isActive = this.currentDocId === node.data.id;
                return `
                    <div class="docs-tree-item docs-tree-document ${isActive ? 'active' : ''}"
                         style="padding-left: ${12 + depth * 16}px"
                         data-doc-id="${node.data.id}"
                         onclick="DocsModule.openDocument('${node.data.id}')">
                        <svg class="icon icon-sm docs-tree-icon">
                            <use href="/static/icons.svg#icon-file-text"/>
                        </svg>
                        <span class="docs-tree-name">${this.escapeHtml(node.data.title)}</span>
                        <div class="docs-tree-item-actions">
                            <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.deleteDocument('${node.data.id}')" title="Delete">
                                <svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg>
                            </button>
                        </div>
                    </div>
                `;
            }
        }).join('');
    },

    // Slash command menu state
    slashMenuOpen: false,
    slashMenuIndex: 0,
    slashMenuQuery: '',
    slashMenuRange: null,

    // Slash command definitions
    slashCommands: [
        { id: 'h1', label: 'Heading 1', desc: 'Large section heading', icon: 'text-h', action: () => DocsModule.formatBlock('h1') },
        { id: 'h2', label: 'Heading 2', desc: 'Medium section heading', icon: 'text-h', action: () => DocsModule.formatBlock('h2') },
        { id: 'h3', label: 'Heading 3', desc: 'Small section heading', icon: 'text-h', action: () => DocsModule.formatBlock('h3') },
        { id: 'bullet', label: 'Bullet List', desc: 'Create a bulleted list', icon: 'list', action: () => DocsModule.formatList() },
        { id: 'numbered', label: 'Numbered List', desc: 'Create a numbered list', icon: 'list-numbers', action: () => DocsModule.formatOrderedList() },
        { id: 'todo', label: 'To-do List', desc: 'Track tasks with a to-do list', icon: 'checkbox', action: () => DocsModule.insertTodoItem() },
        { id: 'quote', label: 'Quote', desc: 'Capture a quote', icon: 'quote', action: () => DocsModule.formatQuote() },
        { id: 'code', label: 'Code Block', desc: 'Display code with syntax', icon: 'code', action: () => DocsModule.insertCodeBlock() },
        { id: 'divider', label: 'Divider', desc: 'Visual divider line', icon: 'minus', action: () => DocsModule.insertDivider() },
        { id: 'callout', label: 'Callout', desc: 'Highlight important info', icon: 'info', action: () => DocsModule.insertCallout() },
    ],

    /**
     * Render the document editor with collaboration UI
     */
    renderEditor() {
        const collaboratorAvatars = this.collaborators
            .filter(c => c.id !== this.userId)
            .map(c => `
                <div class="docs-collaborator" style="--collab-color: ${c.color}" title="${this.escapeHtml(c.name)}">
                    ${c.name.charAt(0).toUpperCase()}
                </div>
            `).join('');

        return `
            <div class="docs-editor">
                <div class="docs-editor-header">
                    <input type="text"
                           class="docs-title-input"
                           value="${this.escapeHtml(this.currentDoc.title)}"
                           placeholder="Untitled"
                           onchange="DocsModule.updateTitle(this.value)"
                           oninput="DocsModule.onTitleInput(this.value)">
                    <div class="docs-collaborators" id="docsCollaborators">
                        ${collaboratorAvatars}
                    </div>
                </div>
                <div class="docs-toolbar-wrapper">
                    <div class="docs-editor-toolbar" id="docsToolbar">
                        <div class="docs-toolbar-group">
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatBold()" title="Bold (Ctrl+B)">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M170.48 115.7A44 44 0 0 0 140 40H64a8 8 0 0 0-8 8v160a8 8 0 0 0 8 8h88a48 48 0 0 0 18.48-92.3M72 56h68a28 28 0 0 1 0 56H72Zm80 144H72v-72h80a32 32 0 0 1 0 64"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatItalic()" title="Italic (Ctrl+I)">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M200 56a8 8 0 0 1-8 8h-34.23l-45.54 128H144a8 8 0 0 1 0 16H64a8 8 0 0 1 0-16h34.23l45.54-128H112a8 8 0 0 1 0-16h80a8 8 0 0 1 8 8"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatUnderline()" title="Underline (Ctrl+U)">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M200 224a8 8 0 0 1-8 8H64a8 8 0 0 1 0-16h128a8 8 0 0 1 8 8m-72-32a64.07 64.07 0 0 0 64-64V56a8 8 0 0 0-16 0v72a48 48 0 0 1-96 0V56a8 8 0 0 0-16 0v72a64.07 64.07 0 0 0 64 64"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatStrike()" title="Strikethrough">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M224 128a8 8 0 0 1-8 8h-40.07c9.19 7.11 16.07 17.2 16.07 32a40 40 0 0 1-40 40a56.06 56.06 0 0 1-32.56-10.31a8 8 0 1 1 9.12-13.14A40.06 40.06 0 0 0 152 192a24 24 0 0 0 0-48H40a8 8 0 0 1 0-16h176a8 8 0 0 1 8 8M76.33 104a8 8 0 0 0 7.61-10.49A24 24 0 0 1 108 64h38a24 24 0 0 1 23.29 18.1a8 8 0 0 0 15.52-4A40 40 0 0 0 146 48h-38a40 40 0 0 0-39.17 48.16a8 8 0 0 0 7.5 7.84"/></svg>
                            </button>
                        </div>
                        <div class="docs-toolbar-divider"></div>
                        <div class="docs-toolbar-group">
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatBlock('h1')" title="Heading 1">
                                H1
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatBlock('h2')" title="Heading 2">
                                H2
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatBlock('h3')" title="Heading 3">
                                H3
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatBlock('p')" title="Paragraph">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M208 56v32a8 8 0 0 1-16 0V64h-56v128h24a8 8 0 0 1 0 16H96a8 8 0 0 1 0-16h24V64H64v24a8 8 0 0 1-16 0V56a8 8 0 0 1 8-8h144a8 8 0 0 1 8 8"/></svg>
                            </button>
                        </div>
                        <div class="docs-toolbar-divider"></div>
                        <div class="docs-toolbar-group">
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatList()" title="Bullet list">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M224 128a8 8 0 0 1-8 8H40a8 8 0 0 1 0-16h176a8 8 0 0 1 8 8M40 72h176a8 8 0 0 0 0-16H40a8 8 0 0 0 0 16m176 112H40a8 8 0 0 0 0 16h176a8 8 0 0 0 0-16"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatOrderedList()" title="Numbered list">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M224 128a8 8 0 0 1-8 8H104a8 8 0 0 1 0-16h112a8 8 0 0 1 8 8M104 72h112a8 8 0 0 0 0-16H104a8 8 0 0 0 0 16m112 112H104a8 8 0 0 0 0 16h112a8 8 0 0 0 0-16M43.58 55.16L48 52.94V104a8 8 0 0 0 16 0V40a8 8 0 0 0-11.58-7.16l-16 8a8 8 0 0 0 7.16 14.32"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatQuote()" title="Quote">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M116 72v88a48.05 48.05 0 0 1-48 48a8 8 0 0 1 0-16a32 32 0 0 0 32-32v-8H40a16 16 0 0 1-16-16V72a16 16 0 0 1 16-16h60a16 16 0 0 1 16 16m100-16h-60a16 16 0 0 0-16 16v64a16 16 0 0 0 16 16h60v8a32 32 0 0 1-32 32a8 8 0 0 0 0 16a48.05 48.05 0 0 0 48-48V72a16 16 0 0 0-16-16"/></svg>
                            </button>
                        </div>
                        <div class="docs-toolbar-divider"></div>
                        <div class="docs-toolbar-group">
                            <button class="docs-toolbar-btn" onclick="DocsModule.insertCodeBlock()" title="Code block">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M69.12 94.15L28.5 128l40.62 33.85a8 8 0 1 1-10.24 12.29l-48-40a8 8 0 0 1 0-12.29l48-40a8 8 0 0 1 10.24 12.3m176 27.7l-48-40a8 8 0 1 0-10.24 12.3L227.5 128l-40.62 33.85a8 8 0 1 0 10.24 12.29l48-40a8 8 0 0 0 0-12.29m-82.39-89.37a8 8 0 0 0-10.25 4.79l-64 176a8 8 0 0 0 4.79 10.26A8.14 8.14 0 0 0 96 224a8 8 0 0 0 7.52-5.27l64-176a8 8 0 0 0-4.79-10.25"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.insertLink()" title="Link (Ctrl+K)">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M137.54 186.36a8 8 0 0 1 0 11.31l-9.94 10a56 56 0 0 1-79.22-79.27l24.12-24.12a56 56 0 0 1 76.81-2.28a8 8 0 1 1-10.64 12a40 40 0 0 0-54.85 1.63L59.7 139.72a40 40 0 0 0 56.58 56.58l9.94-9.94a8 8 0 0 1 11.32 0m70.08-138a56.08 56.08 0 0 0-79.22 0l-9.94 9.95a8 8 0 0 0 11.32 11.31l9.94-9.94a40 40 0 0 1 56.58 56.58l-24.12 24.14a40 40 0 0 1-54.85 1.6a8 8 0 1 0-10.64 12a56 56 0 0 0 76.81-2.26l24.12-24.12a56.08 56.08 0 0 0 0-79.24Z"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.insertDivider()" title="Divider">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M224 128a8 8 0 0 1-8 8H40a8 8 0 0 1 0-16h176a8 8 0 0 1 8 8"/></svg>
                            </button>
                        </div>
                        <div class="docs-toolbar-divider"></div>
                        <div class="docs-toolbar-group">
                            <button class="docs-toolbar-btn" onclick="DocsModule.formatHighlight()" title="Highlight">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="m253.66 106.34l-56-56a8 8 0 0 0-11.32 0l-96 96A8 8 0 0 0 88 152v40H48a8 8 0 0 0 0 16h40v40a8 8 0 0 0 16 0v-40h40a8 8 0 0 0 5.66-2.34l96-96a8 8 0 0 0 0-11.32M104 179.31V160h19.31l42.35 42.35l-19.32 19.31Zm72-8L134.63 130l18.68-18.68L194.63 152.68Zm32-32l-41.31-41.32l30-30L238.06 109.32Z"/></svg>
                            </button>
                            <button class="docs-toolbar-btn" onclick="DocsModule.clearFormatting()" title="Clear formatting">
                                <svg class="icon" viewBox="0 0 256 256"><path fill="currentColor" d="M205.66 194.34a8 8 0 0 1-11.32 11.32L128 139.31l-66.34 66.35a8 8 0 0 1-11.32-11.32L116.69 128L50.34 61.66a8 8 0 0 1 11.32-11.32L128 116.69l66.34-66.35a8 8 0 0 1 11.32 11.32L139.31 128Z"/></svg>
                            </button>
                        </div>
                    </div>
                </div>
                <div class="docs-editor-scroll">
                    <div class="docs-editor-content"
                         id="docsEditorContent"
                         contenteditable="true"
                         oninput="DocsModule.onContentChange()"
                         onkeydown="DocsModule.onEditorKeyDown(event)"
                         placeholder="Type '/' for commands...">${this.sanitizeHtml(this.currentDoc.content)}</div>
                    <div class="docs-slash-menu hidden" id="docsSlashMenu">
                        <div class="docs-slash-menu-header">Commands</div>
                        <div class="docs-slash-menu-list" id="docsSlashMenuList"></div>
                    </div>
                </div>
                <div class="docs-remote-cursors" id="docsRemoteCursors"></div>
            </div>
        `;
    },

    /**
     * Render empty state when no document selected
     */
    renderEmptyState() {
        return `
            <div class="docs-empty-editor">
                <div class="placeholder-icon">
                    <svg class="icon icon-2xl"><use href="/static/icons.svg#icon-file-text"/></svg>
                </div>
                <h3>Select a document</h3>
                <p>Choose a document from the sidebar or create a new one</p>
                <button class="btn btn-primary" onclick="DocsModule.createDocument()">
                    <svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg>
                    New Document
                </button>
            </div>
        `;
    },

    /**
     * Toggle folder expanded state
     */
    toggleFolder(folderId) {
        const folderEl = document.querySelector(`[data-folder-id="${folderId}"]`);
        if (!folderEl) {
            // Fallback to full refresh if element not found
            if (this.expandedFolders.has(folderId)) {
                this.expandedFolders.delete(folderId);
            } else {
                this.expandedFolders.add(folderId);
            }
            this.refreshTree();
            return;
        }

        const chevron = folderEl.querySelector('.docs-tree-chevron');
        const childrenContainer = folderEl.querySelector(':scope > .docs-tree-children');
        const folderIcon = folderEl.querySelector('.docs-tree-icon use');

        if (this.expandedFolders.has(folderId)) {
            this.expandedFolders.delete(folderId);
            chevron?.classList.remove('expanded');
            childrenContainer?.classList.add('hidden');
            if (folderIcon) folderIcon.setAttribute('href', '/static/icons.svg#icon-folder');
        } else {
            this.expandedFolders.add(folderId);
            chevron?.classList.add('expanded');
            childrenContainer?.classList.remove('hidden');
            if (folderIcon) folderIcon.setAttribute('href', '/static/icons.svg#icon-folder-open');
        }
    },

    /**
     * Refresh just the tree portion (full rebuild - use sparingly)
     */
    refreshTree() {
        const projects = (typeof AppState !== 'undefined' && AppState.projects) || [];
        const tree = document.getElementById('docsTree');
        if (tree) {
            const projectsTree = projects.map(p => {
                const isExpanded = this.expandedProjects.has(p.id);
                const isActive = p.id === this.projectId;
                const projectDocs = this.projectDocuments[p.id] || [];
                const projectFlds = this.projectFolders[p.id] || [];

                return `
                    <div class="docs-tree-project ${isActive ? 'active' : ''}" data-project-id="${p.id}">
                        <div class="docs-tree-item docs-tree-project-header"
                             onclick="DocsModule.toggleProject('${p.id}')">
                            <svg class="icon icon-sm docs-tree-chevron ${isExpanded ? 'expanded' : ''}">
                                <use href="/static/icons.svg#icon-caret-right"/>
                            </svg>
                            <div class="docs-project-thumb-mini" ${p.coverImage ? `style="background-image: url('${p.coverImage}')"` : ''}></div>
                            <span class="docs-tree-name">${this.escapeHtml(p.name)}</span>
                            <div class="docs-tree-item-actions">
                                <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.selectProject('${p.id}'); DocsModule.createFolder()" title="New folder">
                                    <svg class="icon"><use href="/static/icons.svg#icon-folder-plus"/></svg>
                                </button>
                                <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.selectProject('${p.id}'); DocsModule.createDocument()" title="New document">
                                    <svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg>
                                </button>
                            </div>
                        </div>
                        <div class="docs-tree-children ${isExpanded ? '' : 'hidden'}">
                            ${isExpanded ? this.renderProjectTree(p.id, projectFlds, projectDocs) : ''}
                        </div>
                    </div>
                `;
            }).join('');
            tree.innerHTML = projectsTree;
        }
    },

    /**
     * Append a document node to the tree without full re-render
     */
    appendDocumentNode(doc, projectId) {
        const parentId = doc.folderId;
        let container;

        if (parentId) {
            // Find the folder's children container
            const folderEl = document.querySelector(`[data-folder-id="${parentId}"]`);
            container = folderEl?.querySelector(':scope > .docs-tree-children');
            // Make sure folder is expanded
            if (folderEl && !this.expandedFolders.has(parentId)) {
                this.expandedFolders.add(parentId);
                folderEl.querySelector('.docs-tree-chevron')?.classList.add('expanded');
                container?.classList.remove('hidden');
            }
        } else {
            // Root level - find project's children container
            const projectEl = document.querySelector(`[data-project-id="${projectId}"]`);
            container = projectEl?.querySelector(':scope > .docs-tree-children');
        }

        if (!container) {
            // Fallback to full refresh
            this.refreshTree();
            return;
        }

        // Calculate depth based on parent
        const depth = parentId ? this.getFolderDepth(parentId) + 1 : 1;

        const docHtml = `
            <div class="docs-tree-item docs-tree-document"
                 style="padding-left: ${12 + depth * 16}px"
                 data-doc-id="${doc.id}"
                 onclick="DocsModule.selectProject('${projectId}'); DocsModule.openDocument('${doc.id}')">
                <svg class="icon icon-sm docs-tree-icon">
                    <use href="/static/icons.svg#icon-file-text"/>
                </svg>
                <span class="docs-tree-name">${this.escapeHtml(doc.title)}</span>
                <div class="docs-tree-item-actions">
                    <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.deleteDocument('${doc.id}')" title="Delete">
                        <svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg>
                    </button>
                </div>
            </div>
        `;

        // Remove "No documents yet" message if present
        const emptyMsg = container.querySelector('.docs-empty-tree');
        if (emptyMsg) emptyMsg.remove();

        container.insertAdjacentHTML('beforeend', docHtml);
    },

    /**
     * Append a folder node to the tree without full re-render
     */
    appendFolderNode(folder, projectId) {
        const parentId = folder.parentId;
        let container;

        if (parentId) {
            const parentEl = document.querySelector(`[data-folder-id="${parentId}"]`);
            container = parentEl?.querySelector(':scope > .docs-tree-children');
            // Expand parent folder
            if (parentEl && !this.expandedFolders.has(parentId)) {
                this.expandedFolders.add(parentId);
                parentEl.querySelector('.docs-tree-chevron')?.classList.add('expanded');
                container?.classList.remove('hidden');
            }
        } else {
            const projectEl = document.querySelector(`[data-project-id="${projectId}"]`);
            container = projectEl?.querySelector(':scope > .docs-tree-children');
        }

        if (!container) {
            this.refreshTree();
            return;
        }

        const depth = parentId ? this.getFolderDepth(parentId) + 1 : 1;

        const folderHtml = `
            <div class="docs-tree-folder" data-folder-id="${folder.id}">
                <div class="docs-tree-item docs-tree-folder-header"
                     style="padding-left: ${12 + depth * 16}px"
                     onclick="DocsModule.toggleFolder('${folder.id}')">
                    <svg class="icon icon-sm docs-tree-chevron">
                        <use href="/static/icons.svg#icon-caret-right"/>
                    </svg>
                    <svg class="icon icon-sm docs-tree-icon">
                        <use href="/static/icons.svg#icon-folder"/>
                    </svg>
                    <span class="docs-tree-name">${this.escapeHtml(folder.name)}</span>
                    <div class="docs-tree-item-actions">
                        <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.selectProject('${projectId}'); DocsModule.createDocument('${folder.id}')" title="Add document">
                            <svg class="icon"><use href="/static/icons.svg#icon-plus"/></svg>
                        </button>
                        <button class="btn-icon btn-xs" onclick="event.stopPropagation(); DocsModule.deleteFolder('${folder.id}')" title="Delete folder">
                            <svg class="icon"><use href="/static/icons.svg#icon-trash"/></svg>
                        </button>
                    </div>
                </div>
                <div class="docs-tree-children hidden"></div>
            </div>
        `;

        const emptyMsg = container.querySelector('.docs-empty-tree');
        if (emptyMsg) emptyMsg.remove();

        // Insert folders before documents
        const firstDoc = container.querySelector('.docs-tree-document');
        if (firstDoc) {
            firstDoc.insertAdjacentHTML('beforebegin', folderHtml);
        } else {
            container.insertAdjacentHTML('beforeend', folderHtml);
        }
    },

    /**
     * Remove a tree node without full re-render
     */
    removeTreeNode(nodeId, type) {
        const selector = type === 'folder'
            ? `[data-folder-id="${nodeId}"]`
            : `[data-doc-id="${nodeId}"]`;
        const el = document.querySelector(selector);
        if (el) {
            el.remove();
        }
    },

    /**
     * Update a document's title in the tree without full re-render
     */
    updateDocumentTitle(docId, newTitle) {
        const el = document.querySelector(`[data-doc-id="${docId}"]`);
        if (el) {
            const nameEl = el.querySelector('.docs-tree-name');
            if (nameEl) {
                nameEl.textContent = newTitle;
            }
        }
    },

    /**
     * Get folder depth for calculating padding
     */
    getFolderDepth(folderId) {
        let depth = 0;
        let folder = this.folders.find(f => f.id === folderId);
        while (folder && folder.parentId) {
            depth++;
            folder = this.folders.find(f => f.id === folder.parentId);
        }
        return depth;
    },

    /**
     * Mark a document as active in the tree
     */
    setActiveDocument(docId) {
        // Remove active class from all documents
        document.querySelectorAll('.docs-tree-document.active').forEach(el => {
            el.classList.remove('active');
        });
        // Add active class to selected document
        const el = document.querySelector(`[data-doc-id="${docId}"]`);
        if (el) {
            el.classList.add('active');
        }
    },

    /**
     * Connect to WebSocket for document collaboration
     */
    async connectWebSocket(docId) {
        // Disconnect from previous document
        this.disconnectWebSocket();

        let socket;
        try {
            socket = await openSocket(`/ws/docs/${encodeURIComponent(docId)}/${encodeURIComponent(this.userId)}`);
        } catch (e) {
            this.tryReconnect(docId);
            return;
        }
        // Another document may have been opened in the meantime
        if (this.currentDocId !== docId || this.ws) {
            socket.close();
            return;
        }
        this.ws = socket;

        this.ws.onopen = () => {
            console.log('Docs WebSocket connected');
            this.reconnectAttempts = 0;
            this.startHeartbeat();
        };

        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleWebSocketMessage(data);
        };

        this.ws.onclose = () => {
            console.log('Docs WebSocket disconnected');
            if (this.ws !== socket) return; // closed on purpose or replaced
            this.ws = null;
            this.stopHeartbeat();
            this.tryReconnect(docId);
        };

        this.ws.onerror = (error) => {
            console.error('Docs WebSocket error:', error);
        };
    },

    /**
     * Disconnect WebSocket
     */
    disconnectWebSocket() {
        this.stopHeartbeat();
        const socket = this.ws;
        this.ws = null;
        if (socket) socket.close();
        this.collaborators = [];
    },

    /**
     * Start heartbeat to keep connection alive
     */
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'pong' }));
            }
        }, 30000);
    },

    /**
     * Stop heartbeat
     */
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    },

    /**
     * Try to reconnect after disconnect
     */
    tryReconnect(docId) {
        if (this.reconnectAttempts < this.maxReconnectAttempts && this.currentDocId === docId) {
            this.reconnectAttempts++;
            console.log(`Reconnecting... attempt ${this.reconnectAttempts}`);
            setTimeout(() => {
                if (this.currentDocId === docId) {
                    this.connectWebSocket(docId);
                }
            }, 1000 * this.reconnectAttempts);
        }
    },

    /**
     * Handle incoming WebSocket messages
     */
    handleWebSocketMessage(data) {
        switch (data.type) {
            case 'init':
                this.collaborators = data.users || [];
                this.updateCollaboratorsUI();
                // Sync content if server has newer version
                if (data.content && !this.currentDoc.content) {
                    this.currentDoc.content = data.content;
                    const editor = document.getElementById('docsEditorContent');
                    if (editor) {
                        this.isRemoteUpdate = true;
                        editor.innerHTML = this.sanitizeHtml(data.content);
                        this.restoreTodoState(editor);
                        this.isRemoteUpdate = false;
                    }
                }
                break;

            case 'user_joined':
                if (!this.collaborators.find(c => c.id === data.user_id)) {
                    this.collaborators.push({ id: data.user_id, ...data.user });
                }
                this.updateCollaboratorsUI();
                break;

            case 'user_left':
                this.collaborators = this.collaborators.filter(c => c.id !== data.user_id);
                this.updateCollaboratorsUI();
                this.removeRemoteCursor(data.user_id);
                break;

            case 'content_update':
                this.applyRemoteContentUpdate(data.content, data.user_id);
                break;

            case 'title_update':
                if (this.currentDoc) {
                    this.currentDoc.title = data.title;
                    const titleInput = document.querySelector('.docs-title-input');
                    if (titleInput && document.activeElement !== titleInput) {
                        titleInput.value = data.title;
                    }
                    // Update in documents list
                    const doc = this.documents.find(d => d.id === this.currentDocId);
                    if (doc) doc.title = data.title;
                    // Use selective update instead of full refresh
                    this.updateDocumentTitle(this.currentDocId, data.title);
                }
                break;

            case 'cursor':
                this.showRemoteCursor(data.user_id, data.position, data.color);
                break;

            case 'selection':
                this.showRemoteSelection(data.user_id, data.range, data.color);
                break;
        }
    },

    /**
     * Apply remote content update
     */
    /**
     * Document HTML comes from other users, so strip scripts/event handlers before rendering.
     */
    sanitizeHtml(html) {
        if (!html) return '';
        if (typeof DOMPurify === 'undefined') {
            // Fail closed: show as text rather than render unsanitized HTML
            const div = document.createElement('div');
            div.textContent = html;
            return div.innerHTML;
        }
        return DOMPurify.sanitize(html);
    },

    /**
     * Checkbox "checked" isn't part of saved HTML; derive it from the todo's class.
     */
    restoreTodoState(root) {
        if (!root) return;
        root.querySelectorAll('.docs-todo > input[type="checkbox"]').forEach(cb => {
            cb.checked = cb.parentElement.classList.contains('completed');
        });
    },

    applyRemoteContentUpdate(content, userId) {
        const editor = document.getElementById('docsEditorContent');
        if (!editor) return;

        // Save cursor position
        const selection = window.getSelection();
        let cursorOffset = 0;
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            cursorOffset = this.getCaretOffset(editor);
        }

        // Apply update
        this.isRemoteUpdate = true;
        editor.innerHTML = this.sanitizeHtml(content);
        this.restoreTodoState(editor);
        this.currentDoc.content = content;
        this.isRemoteUpdate = false;

        // Restore cursor position
        this.setCaretOffset(editor, cursorOffset);
    },

    /**
     * Get caret offset in contenteditable
     */
    getCaretOffset(element) {
        let offset = 0;
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const preCaretRange = range.cloneRange();
            preCaretRange.selectNodeContents(element);
            preCaretRange.setEnd(range.startContainer, range.startOffset);
            offset = preCaretRange.toString().length;
        }
        return offset;
    },

    /**
     * Set caret offset in contenteditable
     */
    setCaretOffset(element, offset) {
        const selection = window.getSelection();
        const range = document.createRange();

        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        let currentOffset = 0;
        let node = walker.nextNode();

        while (node) {
            const nodeLength = node.textContent.length;
            if (currentOffset + nodeLength >= offset) {
                range.setStart(node, offset - currentOffset);
                range.collapse(true);
                selection.removeAllRanges();
                selection.addRange(range);
                return;
            }
            currentOffset += nodeLength;
            node = walker.nextNode();
        }

        // If offset not found, place at end
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
    },

    /**
     * Update collaborators UI
     */
    updateCollaboratorsUI() {
        const container = document.getElementById('docsCollaborators');
        if (!container) return;

        const avatars = this.collaborators
            .filter(c => c.id !== this.userId)
            .map(c => `
                <div class="docs-collaborator" style="--collab-color: ${c.color}" title="${this.escapeHtml(c.name)}">
                    ${c.name.charAt(0).toUpperCase()}
                </div>
            `).join('');

        container.innerHTML = avatars;
    },

    /**
     * Show remote cursor
     */
    showRemoteCursor(userId, position, color) {
        // Remote cursors could be implemented with more complex positioning
        // For now, we just track who's editing
    },

    /**
     * Remove remote cursor
     */
    removeRemoteCursor(userId) {
        const cursor = document.getElementById(`docs-cursor-${userId}`);
        if (cursor) cursor.remove();
    },

    /**
     * Show remote selection
     */
    showRemoteSelection(userId, range, color) {
        // Remote selection highlighting could be implemented
    },

    /**
     * Send WebSocket message
     */
    sendWsMessage(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        }
    },

    /**
     * Open a document for editing
     */
    async openDocument(docId) {
        try {
            const res = await API.request(`/documents/${docId}`);
            if (res.error) throw new Error(res.error);
            this.currentDocId = docId;
            this.currentDoc = res.data;
            this.render();

            // Connect to WebSocket for collaboration
            this.connectWebSocket(docId);
        } catch (err) {
            console.error('Failed to open document:', err);
            showToast('Failed to open document', 'error');
        }
    },

    /**
     * Create a new document
     */
    async createDocument(folderId = null) {
        if (!this.projectId) {
            showToast('Please select a project first', 'error');
            return;
        }

        try {
            const res = await API.request(`/projects/${this.projectId}/documents`, {
                method: 'POST',
                body: JSON.stringify({ title: 'Untitled', folderId: folderId })
            });

            console.log('Create document response:', res);

            if (res.error) throw new Error(res.error);
            const doc = res.data;

            if (!doc || !doc.id) {
                throw new Error('Invalid document response');
            }

            // Add to documents list
            this.documents.push(doc);
            console.log('Documents after push:', this.documents);

            // Also update project cache
            if (!this.projectDocuments[this.projectId]) {
                this.projectDocuments[this.projectId] = [];
            }
            this.projectDocuments[this.projectId].push(doc);

            this.currentDocId = doc.id;
            this.currentDoc = doc;

            // Expand parent folder if creating in folder
            if (folderId) {
                this.expandedFolders.add(folderId);
            }

            // Use selective update instead of full render
            this.appendDocumentNode(doc, this.projectId);
            this.setActiveDocument(doc.id);

            // Only re-render the editor area
            const editorArea = document.querySelector('.docs-editor-area');
            if (editorArea) {
                editorArea.innerHTML = this.renderEditor();
                this.restoreTodoState(document.getElementById('docsEditorContent'));
            }

            // Connect to WebSocket
            this.connectWebSocket(doc.id);

            // Focus title input
            setTimeout(() => {
                const titleInput = document.querySelector('.docs-title-input');
                if (titleInput) {
                    titleInput.select();
                }
            }, 100);

            showToast('Document created', 'success');
        } catch (err) {
            console.error('Failed to create document:', err);
            showToast('Failed to create document', 'error');
        }
    },

    /**
     * Create a new folder
     */
    async createFolder(parentId = null) {
        const name = prompt('Folder name:');
        if (!name) return;

        try {
            const res = await API.request(`/projects/${this.projectId}/folders`, {
                method: 'POST',
                body: JSON.stringify({ name, parentId })
            });
            if (res.error) throw new Error(res.error);
            this.folders.push(res.data);

            // Also update project cache
            if (!this.projectFolders[this.projectId]) {
                this.projectFolders[this.projectId] = [];
            }
            this.projectFolders[this.projectId].push(res.data);

            // Expand parent if creating subfolder
            if (parentId) {
                this.expandedFolders.add(parentId);
            }

            // Use selective update instead of full refresh
            this.appendFolderNode(res.data, this.projectId);
            showToast('Folder created', 'success');
        } catch (err) {
            console.error('Failed to create folder:', err);
            showToast('Failed to create folder', 'error');
        }
    },

    /**
     * Delete a document
     */
    async deleteDocument(docId) {
        if (!confirm('Delete this document?')) return;

        try {
            const res = await API.request(`/documents/${docId}`, { method: 'DELETE' });
            if (res.error) throw new Error(res.error);
            this.documents = this.documents.filter(d => d.id !== docId);

            // Also update project cache
            if (this.projectDocuments[this.projectId]) {
                this.projectDocuments[this.projectId] = this.projectDocuments[this.projectId].filter(d => d.id !== docId);
            }

            // Use selective removal
            this.removeTreeNode(docId, 'document');

            if (this.currentDocId === docId) {
                this.disconnectWebSocket();
                this.currentDocId = null;
                this.currentDoc = null;
                // Only re-render the editor area
                const editorArea = document.querySelector('.docs-editor-area');
                if (editorArea) {
                    editorArea.innerHTML = this.renderEmptyState();
                }
            }

            showToast('Document deleted', 'success');
        } catch (err) {
            console.error('Failed to delete document:', err);
            showToast('Failed to delete document', 'error');
        }
    },

    /**
     * Delete a folder
     */
    async deleteFolder(folderId) {
        if (!confirm('Delete this folder? Documents will be moved to parent.')) return;

        try {
            const res = await API.request(`/folders/${folderId}`, { method: 'DELETE' });
            if (res.error) throw new Error(res.error);

            // Move docs to parent
            const folder = this.folders.find(f => f.id === folderId);
            const parentId = folder?.parentId || null;
            this.documents.forEach(d => {
                if (d.folderId === folderId) {
                    d.folderId = parentId;
                }
            });

            this.folders = this.folders.filter(f => f.id !== folderId);
            this.expandedFolders.delete(folderId);

            // Also update project cache
            if (this.projectFolders[this.projectId]) {
                this.projectFolders[this.projectId] = this.projectFolders[this.projectId].filter(f => f.id !== folderId);
            }

            // Use selective removal - note: docs inside will need to be re-rendered
            // For simplicity, we do a full refresh when deleting folders since docs move
            this.refreshTree();
            showToast('Folder deleted', 'success');
        } catch (err) {
            console.error('Failed to delete folder:', err);
            showToast('Failed to delete folder', 'error');
        }
    },

    /**
     * Handle title input (broadcast to collaborators + debounced save)
     */
    onTitleInput(title) {
        // Broadcast to collaborators immediately
        this.sendWsMessage({
            type: 'title_update',
            title
        });

        // Debounce title save (similar to content autosave)
        if (this.titleSaveTimeout) {
            clearTimeout(this.titleSaveTimeout);
        }
        this.titleSaveTimeout = setTimeout(() => {
            this.updateTitle(title);
        }, 1500);
    },

    /**
     * Save current title from input field
     */
    saveTitle() {
        const titleInput = document.querySelector('.docs-title-input');
        if (titleInput && this.currentDocId) {
            const title = titleInput.value;
            if (title !== this.currentDoc?.title) {
                this.updateTitle(title);
            }
        }
    },

    /**
     * Update document title (save to server)
     */
    async updateTitle(title) {
        if (!this.currentDocId) return;

        try {
            await API.request(`/documents/${this.currentDocId}`, {
                method: 'PATCH',
                body: JSON.stringify({ title })
            });
            this.currentDoc.title = title;

            // Update in documents list
            const doc = this.documents.find(d => d.id === this.currentDocId);
            if (doc) doc.title = title;

            // Use selective update instead of full refresh
            this.updateDocumentTitle(this.currentDocId, title);
        } catch (err) {
            console.error('Failed to update title:', err);
        }
    },

    /**
     * Handle content changes with debounced sync
     */
    onContentChange() {
        if (this.isRemoteUpdate) return;

        const editor = document.getElementById('docsEditorContent');
        if (!editor) return;

        const content = editor.innerHTML;

        // Broadcast to collaborators immediately
        this.sendWsMessage({
            type: 'content_update',
            content
        });

        // Debounce local save
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
        }

        this.saveTimeout = setTimeout(() => {
            this.saveContent();
        }, 2000);
    },

    /**
     * Save document content to server
     */
    async saveContent() {
        if (!this.currentDocId) return;

        const editor = document.getElementById('docsEditorContent');
        if (!editor) return;

        const content = editor.innerHTML;
        this.currentDoc.content = content;

        // Persist to server via API (with auth headers)
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (typeof getAuthHeaders === 'function') {
                Object.assign(headers, getAuthHeaders());
            }
            await fetch(`/api/documents/${this.currentDocId}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify({ content })
            });
        } catch (err) {
            console.error('Failed to save document:', err);
        }
    },

    // ============ Formatting Commands ============

    formatBold() {
        document.execCommand('bold', false, null);
        this.focusEditor();
        this.onContentChange();
    },

    formatItalic() {
        document.execCommand('italic', false, null);
        this.focusEditor();
        this.onContentChange();
    },

    formatUnderline() {
        document.execCommand('underline', false, null);
        this.focusEditor();
        this.onContentChange();
    },

    formatStrike() {
        document.execCommand('strikeThrough', false, null);
        this.focusEditor();
        this.onContentChange();
    },

    formatBlock(tag) {
        document.execCommand('formatBlock', false, tag);
        this.focusEditor();
        this.onContentChange();
    },

    formatList() {
        document.execCommand('insertUnorderedList', false, null);
        this.focusEditor();
        this.onContentChange();
    },

    formatOrderedList() {
        document.execCommand('insertOrderedList', false, null);
        this.focusEditor();
        this.onContentChange();
    },

    formatQuote() {
        document.execCommand('formatBlock', false, 'blockquote');
        this.focusEditor();
        this.onContentChange();
    },

    formatHighlight() {
        document.execCommand('backColor', false, '#fef08a');
        this.focusEditor();
        this.onContentChange();
    },

    clearFormatting() {
        document.execCommand('removeFormat', false, null);
        this.focusEditor();
        this.onContentChange();
    },

    insertLink() {
        const url = prompt('Enter URL:');
        if (url) {
            document.execCommand('createLink', false, url);
            this.onContentChange();
        }
        this.focusEditor();
    },

    insertDivider() {
        document.execCommand('insertHTML', false, '<hr class="docs-divider">');
        this.focusEditor();
        this.onContentChange();
    },

    insertCodeBlock() {
        document.execCommand('insertHTML', false, '<pre class="docs-code-block"><code>// code here</code></pre><p><br></p>');
        this.focusEditor();
        this.onContentChange();
    },

    insertCallout() {
        document.execCommand('insertHTML', false, '<div class="docs-callout"><p>Callout text</p></div><p><br></p>');
        this.focusEditor();
        this.onContentChange();
    },

    insertTodoItem() {
        document.execCommand('insertHTML', false, '<div class="docs-todo"><input type="checkbox"><span>Todo item</span></div>');
        this.focusEditor();
        this.onContentChange();
    },

    onTodoCheck(checkbox) {
        checkbox.parentElement.classList.toggle('completed', checkbox.checked);
        this.onContentChange();
    },

    focusEditor() {
        const editor = document.getElementById('docsEditorContent');
        if (editor) editor.focus();
    },

    // ============ Slash Command Menu ============

    onEditorKeyDown(e) {
        // Handle slash menu navigation
        if (this.slashMenuOpen) {
            const filteredCommands = this.getFilteredCommands();

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this.slashMenuIndex = (this.slashMenuIndex + 1) % filteredCommands.length;
                this.updateSlashMenuSelection();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                this.slashMenuIndex = (this.slashMenuIndex - 1 + filteredCommands.length) % filteredCommands.length;
                this.updateSlashMenuSelection();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                this.executeSlashCommand(filteredCommands[this.slashMenuIndex]);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                this.closeSlashMenu();
            }
        }
    },

    /**
     * Handle content changes and detect slash commands
     */
    onContentInputForSlash() {
        const editor = document.getElementById('docsEditorContent');
        if (!editor) return;

        const selection = window.getSelection();
        if (!selection.rangeCount) return;

        const range = selection.getRangeAt(0);
        const textNode = range.startContainer;

        if (textNode.nodeType !== Node.TEXT_NODE) return;

        const text = textNode.textContent;
        const cursorPos = range.startOffset;

        // Find the start of the current word (looking for /)
        let slashPos = -1;
        for (let i = cursorPos - 1; i >= 0; i--) {
            if (text[i] === '/') {
                // Check if it's at start or after whitespace
                if (i === 0 || /\s/.test(text[i - 1])) {
                    slashPos = i;
                }
                break;
            } else if (/\s/.test(text[i])) {
                break;
            }
        }

        if (slashPos !== -1) {
            const query = text.substring(slashPos + 1, cursorPos).toLowerCase();
            this.slashMenuQuery = query;
            this.slashMenuRange = {
                node: textNode,
                start: slashPos,
                end: cursorPos
            };
            this.openSlashMenu();
        } else {
            this.closeSlashMenu();
        }
    },

    getFilteredCommands() {
        if (!this.slashMenuQuery) return this.slashCommands;
        return this.slashCommands.filter(cmd =>
            cmd.id.includes(this.slashMenuQuery) ||
            cmd.label.toLowerCase().includes(this.slashMenuQuery)
        );
    },

    openSlashMenu() {
        const menu = document.getElementById('docsSlashMenu');
        const list = document.getElementById('docsSlashMenuList');
        if (!menu || !list) return;

        const filteredCommands = this.getFilteredCommands();
        if (filteredCommands.length === 0) {
            this.closeSlashMenu();
            return;
        }

        this.slashMenuOpen = true;
        this.slashMenuIndex = 0;

        list.innerHTML = filteredCommands.map((cmd, i) => `
            <div class="docs-slash-item ${i === 0 ? 'selected' : ''}"
                 data-index="${i}"
                 onclick="DocsModule.executeSlashCommand(DocsModule.getFilteredCommands()[${i}])"
                 onmouseenter="DocsModule.slashMenuIndex = ${i}; DocsModule.updateSlashMenuSelection()">
                <div class="docs-slash-item-icon">
                    <svg class="icon"><use href="/static/icons.svg#icon-${cmd.icon}"/></svg>
                </div>
                <div class="docs-slash-item-content">
                    <div class="docs-slash-item-label">${cmd.label}</div>
                    <div class="docs-slash-item-desc">${cmd.desc}</div>
                </div>
            </div>
        `).join('');

        // Position menu near cursor
        const selection = window.getSelection();
        if (selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            const editorRect = document.getElementById('docsEditorContent').getBoundingClientRect();

            menu.style.top = (rect.bottom - editorRect.top + 8) + 'px';
            menu.style.left = (rect.left - editorRect.left) + 'px';
        }

        menu.classList.remove('hidden');
    },

    closeSlashMenu() {
        const menu = document.getElementById('docsSlashMenu');
        if (menu) menu.classList.add('hidden');
        this.slashMenuOpen = false;
        this.slashMenuQuery = '';
        this.slashMenuRange = null;
    },

    updateSlashMenuSelection() {
        const items = document.querySelectorAll('.docs-slash-item');
        items.forEach((item, i) => {
            item.classList.toggle('selected', i === this.slashMenuIndex);
        });
    },

    executeSlashCommand(cmd) {
        if (!cmd) return;

        // Remove the slash and query text
        if (this.slashMenuRange) {
            const { node, start, end } = this.slashMenuRange;
            const text = node.textContent;
            node.textContent = text.substring(0, start) + text.substring(end);

            // Place cursor at the position where slash was
            const selection = window.getSelection();
            const range = document.createRange();
            range.setStart(node, start);
            range.collapse(true);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        this.closeSlashMenu();
        cmd.action();
    },

    /**
     * Attach keyboard shortcuts
     */
    attachEventListeners() {
        // Keyboard shortcuts for editor
        document.addEventListener('keydown', (e) => {
            const editor = document.getElementById('docsEditorContent');
            if (!editor || document.activeElement !== editor) return;

            if (e.ctrlKey || e.metaKey) {
                if (e.key === 'b') {
                    e.preventDefault();
                    this.formatBold();
                } else if (e.key === 'i') {
                    e.preventDefault();
                    this.formatItalic();
                } else if (e.key === 'u') {
                    e.preventDefault();
                    this.formatUnderline();
                } else if (e.key === 'k') {
                    e.preventDefault();
                    this.insertLink();
                } else if (e.key === 's') {
                    e.preventDefault();
                    this.saveContent();
                }
            }
        });

        // Todo checkboxes (delegated - inline handlers are stripped by sanitizing)
        document.addEventListener('change', (e) => {
            if (e.target.matches && e.target.matches('#docsEditorContent .docs-todo > input[type="checkbox"]')) {
                this.onTodoCheck(e.target);
            }
        });

        // Watch for slash commands
        document.addEventListener('input', (e) => {
            if (e.target.id === 'docsEditorContent') {
                this.onContentInputForSlash();
            }
        });

        // Close slash menu on click outside
        document.addEventListener('click', (e) => {
            if (this.slashMenuOpen && !e.target.closest('.docs-slash-menu')) {
                this.closeSlashMenu();
            }
        });
    },

    /**
     * Cleanup when leaving docs view
     */
    cleanup() {
        // Force save current document before cleanup
        if (this.currentDocId) {
            this.saveTitle();   // Save title first
            this.saveContent(); // Then save content
        }
        // Clear any pending save timeouts
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout);
            this.saveTimeout = null;
        }
        if (this.titleSaveTimeout) {
            clearTimeout(this.titleSaveTimeout);
            this.titleSaveTimeout = null;
        }
        this.disconnectWebSocket();
        this.currentDocId = null;
        this.currentDoc = null;
    },

    /**
     * Escape HTML for safe rendering
     */
    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text || '';
        return div.innerHTML;
    }
};

// Make globally available
window.DocsModule = DocsModule;
