import { useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import { getPlatform } from '../../../platform';
import { ColorDot, cx } from '../../../ui';
import { getCell } from '../../cells';
import { ProjectSelect, useAddProject } from '../../addProject';
import type { Column, LayoutProps, Row, View } from '../../types';
import { BOARD_TYPES, buildLanes, quickAddValues, type BoardLane } from '../board/model';
import { coverColumnsOf, coverOf } from '../cover';
import { CARD_MIN_WIDTH, galleryFieldsOf, readGalleryConfig, type GalleryConfig } from './model';
import './gallery.css';

/**
 * Gallery layout: the rows as cards in a grid that fills the width. A card shows a picture on top (an image
 * column, else the frame of the linked clip), the title and the chosen fields. Grouping the view (select-like
 * columns) splits the grid into sections. Settings live in `view.config.gallery`.
 */
export function GalleryLayout({ schema, view, result, loading, actions }: LayoutProps) {
  const gallery = readGalleryConfig(view.config);
  const fields = galleryFieldsOf(schema, view.config);
  const groupColumn = schema.columns.find((c) => c.key === view.config.query.groupBy && BOARD_TYPES.has(c.type));
  const sections = useMemo<Array<BoardLane | null>>(
    () => (groupColumn ? buildLanes(groupColumn, result).filter((l) => l.rows.length > 0 || l.count > 0) : [null]),
    [groupColumn, result],
  );
  const save = (patch: Partial<GalleryConfig>) =>
    actions.updateConfig({ gallery: { ...gallery, ...patch } as NonNullable<View['config']['gallery']> });
  const style = { '--cl-gallery-min': `${CARD_MIN_WIDTH[gallery.size]}px` } as CSSProperties;

  return (
    <div className={cx('cl-gallery', `cl-gallery--${gallery.size}`, gallery.fit === 'contain' && 'cl-gallery--contain')} style={style} data-testid="gallery-layout" aria-busy={loading || undefined}>
      <div className="cl-gallery__bar">
        <GallerySettings schema={schema} gallery={gallery} fields={fields} onChange={save} />
      </div>
      {sections.map((lane) => {
        const rows = lane ? lane.rows : result.rows;
        return (
          <section key={lane?.id ?? 'all'} className="cl-gallery__section" data-testid="gallery-section">
            {lane && (
              <header className="cl-gallery__head">
                {lane.color && <ColorDot color={lane.color} />}
                <span className="cl-gallery__head-name">{lane.label}</span>
                <span className="cl-gallery__head-count">{lane.count}</span>
              </header>
            )}
            <div className="cl-gallery__grid">
              {rows.map((row) => (
                <Card
                  key={row.id}
                  row={row}
                  titleColumn={schema.titleColumn}
                  fields={fields}
                  cover={coverOf(row, schema.columns, gallery.cover)}
                  onOpen={() => actions.openRow(row.id)}
                />
              ))}
              {schema.capabilities.create && (
                <NewCard
                  view={view}
                  titleColumn={schema.titleColumn}
                  values={(title) => (groupColumn && lane ? quickAddValues(groupColumn, schema.titleColumn, title, lane.key) : { [schema.titleColumn]: title })}
                  actions={actions}
                />
              )}
            </div>
            {rows.length === 0 && !loading && !schema.capabilities.create && <p className="cl-gallery__empty">No rows</p>}
          </section>
        );
      })}
    </div>
  );
}

function Card({ row, titleColumn, fields, cover, onOpen }: { row: Row; titleColumn: string; fields: Column[]; cover: string | null; onOpen: () => void }) {
  const [failed, setFailed] = useState<string | null>(null);
  const title = String(row.values[titleColumn] ?? '').trim();
  const shown = fields.flatMap((c) => {
    const def = getCell(c.type);
    const value = row.values[c.key];
    if (def.isEmpty(value)) return [];
    return [
      <div key={c.key} className={cx('cl-gallery__field', `cl-gallery__field--${c.type}`)} title={c.name}>
        <def.Display column={c} value={value} row={row} compact />
      </div>,
    ];
  });
  const picture = cover && failed !== cover ? cover : null;
  return (
    <article
      className={cx('cl-gallery__card', picture && 'has-cover')}
      data-testid="gallery-card"
      data-card-id={row.id}
      tabIndex={0}
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('a, button, input')) onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && e.target === e.currentTarget) onOpen();
      }}
    >
      {picture && (
        <div className="cl-gallery__cover">
          <img src={picture} alt="" loading="lazy" draggable={false} onError={() => setFailed(picture)} data-testid="gallery-cover" />
        </div>
      )}
      <div className="cl-gallery__body">
        <div className="cl-gallery__title">{title || 'Untitled'}</div>
        {shown.length > 0 && <div className="cl-gallery__fields">{shown}</div>}
      </div>
    </article>
  );
}

/** "+ New": a title input in the shape of a card; the new row lands in the section it was typed in. */
function NewCard({ view, values, actions }: { view: View; titleColumn: string; values: (title: string) => Record<string, unknown>; actions: LayoutProps['actions'] }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const add = useAddProject(view.id, view.tableRef);

  function close() {
    setOpen(false);
    setTitle('');
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const text = title.trim();
    if (!text) return close();
    let opts: { projectId: string } | undefined;
    if (view.tableRef === 'tasks:*') {
      if (!add.projectId) {
        getPlatform().toast('error', 'You have no project to add a task to');
        return;
      }
      opts = { projectId: add.projectId };
    }
    actions.createRow(values(text), opts).catch(() => undefined);
    setTitle('');
  }

  if (!open) {
    return (
      <button type="button" className="cl-gallery__new" onClick={() => setOpen(true)} data-testid="gallery-add">
        + New
      </button>
    );
  }
  return (
    <form className="cl-gallery__new cl-gallery__new--form" onSubmit={submit} data-testid="gallery-add-form">
      <input
        className="cl-gallery__new-input"
        autoFocus
        aria-label="Title of the new card"
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
        }}
        onBlur={(e) => !title.trim() && !e.currentTarget.form?.contains(e.relatedTarget as Node | null) && close()}
      />
      <ProjectSelect add={add} className="cl-gallery__new-input" />
    </form>
  );
}

/** Picture source, card size, crop and the fields on the cards, in one disclosure at the top right. */
function GallerySettings({ schema, gallery, fields, onChange }: { schema: LayoutProps['schema']; gallery: GalleryConfig; fields: Column[]; onChange: (patch: Partial<GalleryConfig>) => void }) {
  const chosen = new Set(fields.map((c) => c.key));
  const choices = schema.columns.filter((c) => c.key !== schema.titleColumn);
  const pictures = coverColumnsOf(schema.columns);
  return (
    <details className="cl-gallery__settings" data-testid="gallery-settings">
      <summary>Card settings</summary>
      <div className="cl-gallery__settings-panel">
        <label className="cl-gallery__setting">
          Picture
          <select className="cl-table__select" value={gallery.cover} onChange={(e) => onChange({ cover: e.target.value })} data-testid="gallery-cover-choice">
            <option value="auto">Image, else the clip&apos;s frame</option>
            {pictures.map((c) => (
              <option key={c.key} value={c.key}>
                {c.name}
              </option>
            ))}
            <option value="none">No picture</option>
          </select>
        </label>
        <div className="cl-gallery__setting">
          Card size
          <div className="cl-gallery__seg" role="group" aria-label="Card size">
            {(['small', 'medium', 'large'] as const).map((s) => (
              <button key={s} type="button" aria-pressed={gallery.size === s} onClick={() => onChange({ size: s })} data-testid={`gallery-size-${s}`}>
                {s === 'small' ? 'S' : s === 'medium' ? 'M' : 'L'}
              </button>
            ))}
          </div>
        </div>
        <label className="cl-gallery__check">
          <input type="checkbox" checked={gallery.fit === 'contain'} onChange={(e) => onChange({ fit: e.target.checked ? 'contain' : 'cover' })} data-testid="gallery-fit" />
          Show the whole picture
        </label>
        <div className="cl-gallery__setting">Fields</div>
        <div className="cl-gallery__fields-list">
          {choices.map((c) => (
            <label key={c.key} className="cl-gallery__check">
              <input
                type="checkbox"
                checked={chosen.has(c.key)}
                onChange={() => {
                  const next = chosen.has(c.key) ? fields.filter((f) => f.key !== c.key).map((f) => f.key) : [...fields.map((f) => f.key), c.key];
                  onChange({ cardColumns: next.length ? next : ['__none__'] });
                }}
              />
              {c.name}
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}
