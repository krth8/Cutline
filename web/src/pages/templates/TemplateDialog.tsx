import { useEffect, useMemo, useState } from 'react';
import type { SpaceKey } from '../../api/pageTree';
import { deleteTemplate, listTemplates, useTemplate, type TemplateInfo, type TemplateScope } from '../../api/templates';
import { getPlatform } from '../../platform';
import { Button, cx, Dialog, Input } from '../../ui';
import { getPageStore } from '../tree/pageStore';
import { openPage } from '../tree/space';
import './templates.css';

const BADGE: Record<TemplateScope, string> = { builtin: 'Built-in', personal: 'Personal', workspace: 'Workspace' };

export interface TemplateDialogProps {
  open: boolean;
  onClose: () => void;
  /** Where new pages are created. */
  space: SpaceKey;
  parentId?: string | null;
  /** Manage templates: no picking, only deleting. */
  manage?: boolean;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * "New from template": the templates as cards (name, description, badge) with a search field. Picking one
 * creates the pages in `space` and opens the first. Templates the user may delete have a Delete button.
 */
export function TemplateDialog({ open, onClose, space, parentId = null, manage = false }: TemplateDialogProps) {
  const [templates, setTemplates] = useState<TemplateInfo[] | 'loading' | 'error'>('loading');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setTemplates('loading');
    setQuery('');
    setBusy(null);
    listTemplates().then(
      (list) => !stale && setTemplates(list),
      () => !stale && setTemplates('error'),
    );
    return () => {
      stale = true;
    };
  }, [open]);

  const shown = useMemo(() => {
    if (!Array.isArray(templates)) return [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return templates.filter((t) => words.every((w) => `${t.name} ${t.description} ${BADGE[t.scope]}`.toLowerCase().includes(w)));
  }, [templates, query]);

  async function pick(template: TemplateInfo) {
    if (manage || busy) return;
    setBusy(template.id);
    try {
      const created = await useTemplate(template.id, { space, ...(parentId ? { parentId } : {}) });
      getPageStore(space).scheduleRefresh();
      onClose();
      openPage(space, created.id);
    } catch (e) {
      getPlatform().toast('error', `Could not create the page: ${errorText(e)}`);
      setBusy(null);
    }
  }

  async function remove(template: TemplateInfo) {
    const ok = await getPlatform().confirm(`Delete the template "${template.name}"? Pages made from it stay.`, {
      danger: true,
      confirmLabel: 'Delete template',
    });
    if (!ok) return;
    try {
      await deleteTemplate(template.id);
      setTemplates((list) => (Array.isArray(list) ? list.filter((t) => t.id !== template.id) : list));
    } catch (e) {
      getPlatform().toast('error', `Could not delete the template: ${errorText(e)}`);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={manage ? 'Templates' : 'New from template'}
      className="cl-tpl-dialog"
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="cl-tpl">
        <Input
          type="search"
          className="cl-tpl__search"
          aria-label="Search templates"
          placeholder="Search templates"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {templates === 'loading' ? <p className="cl-tpl__note">Loading templates...</p> : null}
        {templates === 'error' ? (
          <p className="cl-tpl__note" role="alert">
            Could not load the templates.
          </p>
        ) : null}
        {Array.isArray(templates) && shown.length === 0 ? <p className="cl-tpl__note">No template matches.</p> : null}
        <ul className="cl-tpl__cards" aria-label="Templates">
          {shown.map((t) => (
            <li key={t.id} className={cx('cl-tpl__card', busy === t.id && 'is-busy')} data-template-id={t.id}>
              <button
                type="button"
                className="cl-tpl__pick"
                disabled={manage || busy !== null}
                onClick={() => void pick(t)}
                aria-label={manage ? t.name : `Use ${t.name}`}
              >
                <span className="cl-tpl__head">
                  <span className="cl-tpl__icon" aria-hidden="true">
                    {t.icon ?? '\u{1F4C4}'}
                  </span>
                  <span className="cl-tpl__name">{t.name}</span>
                  <span className={cx('cl-tpl__badge', `is-${t.scope}`)}>{BADGE[t.scope]}</span>
                </span>
                <span className="cl-tpl__desc">{t.description || 'No description.'}</span>
                {t.pageCount > 1 ? <span className="cl-tpl__meta">{t.pageCount} pages</span> : null}
              </button>
              {t.canDelete ? (
                <Button size="sm" variant="danger" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}>
                  Delete
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
