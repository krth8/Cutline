import { useEffect, useMemo, useState } from 'react';
import { Editor } from '../Editor';
import { LinkedNetwork, type LinkedPeer } from './linkedProvider';
import '../editor.css';

const USERS = [
  { id: 'u1', name: 'Ada', color: '#e8590c' },
  { id: 'u2', name: 'Grace', color: '#1c7ed6' },
];

/**
 * Two editors side by side on linked documents, with different users. Toggles for
 * read-only mode, going offline and an artificial network delay.
 */
export function EditorDemo() {
  const [editable, setEditable] = useState(true);
  const [offline, setOffline] = useState(false);
  const [delay, setDelay] = useState(0);
  const net = useMemo(() => new LinkedNetwork(0), []);
  const [peers, setPeers] = useState<LinkedPeer[]>([]);

  useEffect(() => {
    const created = USERS.map(() => net.join());
    setPeers(created);
    return () => net.dispose();
  }, [net]);

  useEffect(() => net.setDelay(delay), [net, delay]);
  useEffect(() => {
    peers.forEach((p) => p.setOnline(!offline));
  }, [peers, offline]);

  return (
    <div className="cl-editor-demo" data-testid="editor-demo">
      <div className="cl-editor-demo__bar">
        <label>
          <input type="checkbox" checked={editable} onChange={(e) => setEditable(e.target.checked)} /> Editable
        </label>
        <label>
          <input type="checkbox" checked={offline} onChange={(e) => setOffline(e.target.checked)} /> Offline
        </label>
        <label>
          Delay{' '}
          <select value={delay} onChange={(e) => setDelay(Number(e.target.value))}>
            <option value={0}>none</option>
            <option value={300}>300 ms</option>
            <option value={1500}>1.5 s</option>
          </select>
        </label>
      </div>
      <div className="cl-editor-demo__panes">
        {peers.map((peer, i) => {
          const user = USERS[i]!;
          return (
            <section key={user.id} className="cl-editor-demo__pane" data-testid={`pane-${user.id}`}>
              <h4 className="cl-editor-demo__who">
                <span className="cl-editor-demo__dot" style={{ background: user.color }} />
                {user.name}
              </h4>
              <Editor doc={peer.doc} awareness={peer.awareness} user={user} editable={editable} />
            </section>
          );
        })}
      </div>
    </div>
  );
}
