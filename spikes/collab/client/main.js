import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import * as Y from 'yjs'
import { PageProvider } from './provider.js'

const q = new URLSearchParams(location.search)
const page = q.get('page') || 'p1'
const name = q.get('name') || 'anon'
const color = q.get('color') || '#e11d48'
const proto = location.protocol === 'https:' ? 'wss' : 'ws'

const doc = new Y.Doc()
const provider = new PageProvider(() => `${proto}://${location.host}/ws/pages/${page}`, doc)
const editor = new Editor({
  element: document.querySelector('#editor'),
  extensions: [
    StarterKit.configure({ undoRedo: false }), // Yjs undo replaces ProseMirror history
    Collaboration.configure({ document: doc }), // fragment name defaults to "default"
    CollaborationCaret.configure({ provider, user: { name, color } }),
  ],
})
const st = document.querySelector('#status')
provider.on('status', (s) => { st.textContent = s; st.dataset.status = s })
provider.on('synced', () => { st.dataset.synced = '1' })
window.spike = { editor, doc, provider, Y }
