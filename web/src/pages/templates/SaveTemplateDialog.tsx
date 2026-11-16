import { useEffect, useState } from 'react';
import { saveTemplate } from '../../api/templates';
import { getPlatform } from '../../platform';
import { Button, Dialog, Input } from '../../ui';
import './templates.css';

export interface SaveTemplateDialogProps {
  open: boolean;
  onClose: () => void;
  pageId: string;
  /** The page title, offered as the template name. */
  title: string;
}

/** "Save as template": name, description and who may use it (only admins can share with everyone). */
export function SaveTemplateDialog({ open, onClose, pageId, title }: SaveTemplateDialogProps) {
  const isAdmin = getPlatform().user()?.role === 'admin';
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<'personal' | 'workspace'>('personal');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(title || 'Untitled');
    setDescription('');
    setScope('personal');
    setBusy(false);
  }, [open, title]);

  async function save() {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      await saveTemplate({ pageId, name: name.trim(), description: description.trim(), scope });
      getPlatform().toast('success', 'Template saved');
      onClose();
    } catch (e) {
      getPlatform().toast('error', `Could not save the template: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Save as template"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!name.trim() || busy} onClick={() => void save()}>
            Save template
          </Button>
        </>
      }
    >
      <form
        className="cl-tpl-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className="cl-tpl-form__field">
          <span>Name</span>
          <Input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="Template name" />
        </label>
        <label className="cl-tpl-form__field">
          <span>Description</span>
          <textarea
            className="cl-tpl-form__text"
            value={description}
            maxLength={500}
            rows={3}
            aria-label="Template description"
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <fieldset className="cl-tpl-form__scope">
          <legend>Who can use it</legend>
          <label>
            <input type="radio" name="cl-tpl-scope" checked={scope === 'personal'} onChange={() => setScope('personal')} /> Only me
          </label>
          {isAdmin ? (
            <label>
              <input type="radio" name="cl-tpl-scope" checked={scope === 'workspace'} onChange={() => setScope('workspace')} /> Everyone
              (workspace)
            </label>
          ) : null}
        </fieldset>
        <p className="cl-tpl-form__note">The template is a frozen copy of this page and its sub-pages. Later edits do not change it.</p>
      </form>
    </Dialog>
  );
}
