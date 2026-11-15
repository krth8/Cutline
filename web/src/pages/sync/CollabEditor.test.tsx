import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import '../editor/testing/helpers'; // jsdom geometry stubs for ProseMirror
import { setPlatform } from '../../platform';
import { CollabEditor } from './CollabEditor';
import { installServer, xmlText } from './testing/fakeServer';

afterEach(() => setPlatform(null));

function page(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pg1',
    title: 'T',
    icon: null,
    kind: 'page',
    space: 'p:proj',
    parentId: null,
    sortOrder: 0,
    canEdit: true,
    needsImport: false,
    archived: false,
    ...overrides,
  };
}

function seed(server: ReturnType<typeof installServer>['server'], text: string) {
  const p = new Y.XmlElement('paragraph');
  p.insert(0, [new Y.XmlText(text)]);
  server.doc.getXmlFragment('default').insert(0, [p]);
}

describe('<CollabEditor>', () => {
  it('shows the document, becomes Saved, and is editable', async () => {
    const h = installServer();
    seed(h.server, 'Hello page');
    h.platform.routes['/api/pages/pg1'] = page();
    render(<CollabEditor pageId="pg1" />);
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toContain('Hello page'), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved'));
    expect(screen.getByRole('textbox').getAttribute('contenteditable')).toBe('true');
  });

  it('is read only when the page says the reader cannot edit', async () => {
    const h = installServer({ readonly: true });
    seed(h.server, 'Look only');
    h.platform.routes['/api/pages/pg1'] = page({ canEdit: false });
    render(<CollabEditor pageId="pg1" />);
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toContain('Look only'), { timeout: 5000 });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Read only'));
    expect(screen.getByRole('textbox').getAttribute('contenteditable')).toBe('false');
  });

  it('says so when the page is not available', async () => {
    const h = installServer({ closeOnOpen: 4403 });
    h.platform.routes['/api/pages/pg1'] = () => new Response(JSON.stringify({ detail: 'Access denied' }), { status: 403 });
    render(<CollabEditor pageId="pg1" />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Not available'), { timeout: 5000 });
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('imports legacy HTML once the page reports it needs it', async () => {
    const h = installServer();
    h.platform.routes['/api/pages/pg1'] = page({ needsImport: true, legacyHtml: '<p>From the old Docs</p>' });
    h.platform.routes['POST /api/pages/pg1/claim-import'] = { granted: true };
    render(<CollabEditor pageId="pg1" />);
    await waitFor(() => expect(screen.getByRole('textbox').textContent).toContain('From the old Docs'), { timeout: 5000 });
    await waitFor(() => expect(xmlText(h.server.doc)).toContain('From the old Docs'));
  });

  it('closes the socket when it unmounts', async () => {
    const h = installServer();
    h.platform.routes['/api/pages/pg1'] = page();
    const view = render(<CollabEditor pageId="pg1" />);
    await waitFor(() => expect(h.server.sockets).toHaveLength(1), { timeout: 5000 });
    view.unmount();
    expect(h.server.sockets).toHaveLength(0);
    expect(h.server.last.closedByClient).toBe(1000);
  });
});
