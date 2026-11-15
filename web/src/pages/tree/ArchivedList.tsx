import { useEffect } from 'react';
import type { SpaceKey } from '../../api/pageTree';
import { Button, Dialog } from '../../ui';
import { type TreeNode } from './treeModel';
import { canEditSpace, usePageStore } from './space';
import './tree.css';

function ArchivedRow({
  node,
  depth,
  canEdit,
  onRestore,
  onDelete,
}: {
  node: TreeNode;
  depth: number;
  canEdit: boolean;
  onRestore: (id: string) => void;
  onDelete: (node: TreeNode) => void;
}) {
  const title = node.page.title || 'Untitled';
  return (
    <>
      <li className="cl-archived__row" style={{ paddingLeft: 8 + depth * 16 }} data-page-id={node.page.id}>
        <span className="cl-tree__icon" aria-hidden="true">
          {node.page.icon ?? '\u{1F4C4}'}
        </span>
        <span className="cl-archived__title">{title}</span>
        {canEdit && depth === 0 ? (
          <span className="cl-archived__actions">
            <Button size="sm" onClick={() => onRestore(node.page.id)} aria-label={`Restore ${title}`}>
              Restore
            </Button>
            <Button size="sm" variant="danger" onClick={() => onDelete(node)} aria-label={`Delete ${title} forever`}>
              Delete forever
            </Button>
          </span>
        ) : null}
      </li>
      {node.children.map((c) => (
        <ArchivedRow key={c.page.id} node={c} depth={depth + 1} canEdit={canEdit} onRestore={onRestore} onDelete={onDelete} />
      ))}
    </>
  );
}

/**
 * The archived pages of a space. Restoring or deleting acts on a top-level archived page
 * together with its sub-pages (they were archived as one).
 */
export function ArchivedDialog({ space, open, onClose }: { space: SpaceKey; open: boolean; onClose: () => void }) {
  const { store, snap } = usePageStore(space);
  useEffect(() => (open ? store.wantArchived() : undefined), [open, store]);
  const canEdit = canEditSpace(space);
  const roots = snap.archivedModel.roots;

  return (
    <Dialog open={open} onClose={onClose} title="Archived pages" footer={<Button onClick={onClose}>Close</Button>}>
      {snap.archived === null ? (
        <p className="cl-archived__empty">Loading...</p>
      ) : roots.length === 0 ? (
        <p className="cl-archived__empty">No archived pages.</p>
      ) : (
        <ul className="cl-archived" aria-label="Archived pages">
          {roots.map((node) => (
            <ArchivedRow
              key={node.page.id}
              node={node}
              depth={0}
              canEdit={canEdit}
              onRestore={(id) => void store.restore(id)}
              onDelete={(n) => void store.deleteForever(n.page.id, n.page.title)}
            />
          ))}
        </ul>
      )}
    </Dialog>
  );
}
