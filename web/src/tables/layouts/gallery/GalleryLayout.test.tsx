import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { setPlatform } from '../../../platform';
import { createFakePlatform } from '../../../testing/fakePlatform';
import { formatNumber } from '../../cells/util';
import { getCell } from '../../cells';
import type { Column, LayoutProps, Row, TableSchema } from '../../types';
import { coverOf } from '../cover';
import { getLayout } from '../registry';
import { formatValue } from '../../../pages/editor/blocks/summary/model';
import './index';
import { GalleryLayout } from './GalleryLayout';
import { galleryFieldsOf, readGalleryConfig } from './model';

const IMG = 'tasks.p1/img_0123456789abcdef.png';
const thumb: Column = { key: 'cf_img', name: 'Thumbnail', type: 'image', builtin: false, config: { uploadRef: 'tasks:p1' } };
const clip: Column = { key: 'clip', name: 'Clip', type: 'clip', builtin: true };
const status: Column = {
  key: 'status', name: 'Status', type: 'status', builtin: true,
  options: [{ value: 'todo', label: 'To do' }, { value: 'done', label: 'Done' }],
};
const notes: Column = { key: 'cf_notes', name: 'Description', type: 'longtext', builtin: false };
const schema: TableSchema = {
  ref: 'tasks:p1', name: 'Tasks', titleColumn: 'name',
  capabilities: { create: true, delete: true, hierarchy: false, editSchema: false },
  columns: [{ key: 'name', name: 'Name', type: 'text', builtin: true }, status, notes, clip, thumb],
};
const row = (id: string, values: Record<string, unknown>): Row => ({ id, tableRef: 'tasks:p1', values: { name: id, ...values }, canEdit: true });

function setup(rows: Row[], config: Partial<LayoutProps['view']['config']> = {}) {
  const actions = {
    updateRow: vi.fn(async () => {}),
    createRow: vi.fn(async (values: Record<string, unknown>) => row('new', values)),
    deleteRows: vi.fn(async () => {}),
    reorder: vi.fn(async () => {}),
    openRow: vi.fn(),
    updateConfig: vi.fn(),
    loadChildren: vi.fn(async () => []),
  };
  const props: LayoutProps = {
    schema,
    view: { id: 'v1', tableRef: 'tasks:p1', name: 'Gallery', layout: 'gallery', config: { query: {}, ...config } },
    result: { rows, total: rows.length },
    loading: false,
    actions,
  };
  render(<GalleryLayout {...props} />);
  return { actions };
}

beforeEach(() => setPlatform(createFakePlatform()));

describe('covers', () => {
  it('uses an uploaded image first and the frame of the clip otherwise', () => {
    const withBoth = row('a', { cf_img: IMG, clip: { baseName: 'shot', thumbnail: 'shot.jpg' } });
    const clipOnly = row('b', { clip: { baseName: 'shot', thumbnail: 'shot 2.jpg' } });
    expect(coverOf(withBoth, schema.columns)).toBe(`/api/table-images/${IMG}`);
    expect(coverOf(clipOnly, schema.columns)).toBe('/thumbnail/shot%202.jpg');
    expect(coverOf(row('c', {}), schema.columns)).toBeNull();
    expect(coverOf(withBoth, schema.columns, 'clip')).toBe('/thumbnail/shot.jpg');
    expect(coverOf(withBoth, schema.columns, 'none')).toBeNull();
  });

  it('ignores a cell value that is not an uploaded image', () => {
    expect(coverOf(row('a', { cf_img: '../secret' }), schema.columns)).toBeNull();
    expect(getCell('image').parseText!('https://x.y/a.png', thumb)).toBeNull();
  });
});

describe('gallery', () => {
  it('is registered and reads its config with defaults', () => {
    expect(getLayout('gallery')?.label).toBe('Gallery');
    expect(readGalleryConfig({ query: {} })).toEqual({ cardColumns: [], cover: 'auto', size: 'medium', fit: 'cover' });
  });

  it('shows the visible columns as fields by default, without the picture columns', () => {
    expect(galleryFieldsOf(schema, { query: {} }).map((c) => c.key)).toEqual(['status', 'cf_notes']);
  });

  it('draws one card per row with its picture, and opens the row on a click', () => {
    const { actions } = setup([row('Phoria', { cf_img: IMG, status: 'done' }), row('Jotun', {})]);
    const cards = screen.getAllByTestId('gallery-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]!).getByTestId('gallery-cover').getAttribute('src')).toBe(`/api/table-images/${IMG}`);
    expect(within(cards[0]!).getByText('Done')).toBeTruthy();
    expect(within(cards[1]!).queryByTestId('gallery-cover')).toBeNull();
    fireEvent.click(cards[1]!);
    expect(actions.openRow).toHaveBeenCalledWith('Jotun');
  });

  it('splits into sections when grouped, and a new card gets the section value', () => {
    const { actions } = setup(
      [row('a', { status: 'todo' }), row('b', { status: 'done' })],
      { query: { groupBy: 'status' } },
    );
    const sections = screen.getAllByTestId('gallery-section');
    expect(sections.map((s) => s.querySelector('.cl-gallery__head-name')?.textContent)).toEqual(['To do', 'Done']);
    fireEvent.click(within(sections[1]!).getByTestId('gallery-add'));
    const input = within(sections[1]!).getByLabelText('Title of the new card');
    fireEvent.change(input, { target: { value: 'New one' } });
    fireEvent.submit(input.closest('form')!);
    expect(actions.createRow).toHaveBeenCalledWith({ name: 'New one', status: 'done' }, undefined);
  });

  it('saves the card size', () => {
    const { actions } = setup([row('a', {})]);
    fireEvent.click(screen.getByTestId('gallery-size-large'));
    expect(actions.updateConfig).toHaveBeenCalledWith({ gallery: { cardColumns: [], cover: 'auto', size: 'large', fit: 'cover' } });
  });
});

describe('money', () => {
  it('writes a number column with a currency as money', () => {
    const money: Column = { key: 'cf_m', name: 'Budget', type: 'number', builtin: false, config: { currency: 'NOK' } };
    const expected = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'NOK' }).format(577000);
    expect(formatNumber(577000, money)).toBe(expected);
    expect(formatValue('sum', 577000, 'NOK')).toBe(expected);
    expect(formatValue('count', 3, null)).toBe('3');
  });
});
