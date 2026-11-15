import { Awareness } from 'y-protocols/awareness';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { setPlatform } from '../../platform';
import { importLegacyIfNeeded, isDocEmpty } from './legacyImport';
import { PageProvider } from './PageProvider';
import { flush, installServer, typeInto, xmlText } from './testing/fakeServer';

const HTML = '<h1>Old title</h1><p>Old text</p><div class="docs-todo completed"><input type="checkbox"><span>done</span></div>';
const PAGE = { id: 'pg1', needsImport: true, canEdit: true, legacyHtml: HTML };

const providers: PageProvider[] = [];
function client() {
  const doc = new Y.Doc();
  const provider = new PageProvider({ pageId: 'pg1', doc, awareness: new Awareness(doc) });
  providers.push(provider);
  return { doc, provider };
}

async function until(fn: () => boolean) {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(fn()).toBe(true);
}

afterEach(() => {
  providers.splice(0).forEach((p) => p.destroy());
  setPlatform(null);
});

describe('legacy import', () => {
  it('writes the converted HTML when the claim is granted', async () => {
    const h = installServer();
    const { doc, provider } = client();
    const claim = vi.fn().mockResolvedValue(true);
    const result = await importLegacyIfNeeded(PAGE, doc, provider, { claim });
    expect(result).toBe('imported');
    expect(claim).toHaveBeenCalledWith('pg1');
    expect(doc.getXmlFragment('default').toArray().map((n) => (n as Y.XmlElement).nodeName)).toEqual([
      'heading',
      'paragraph',
      'taskList',
    ]);
    // It travels to the server like any edit
    await until(() => h.server.text().includes('Old text'));
  });

  it('does nothing when the claim is not granted, and takes the content that arrives over sync', async () => {
    const h = installServer();
    const { doc, provider } = client();
    const result = await importLegacyIfNeeded(PAGE, doc, provider, { claim: async () => false });
    expect(result).toBe('not-granted');
    expect(isDocEmpty(doc)).toBe(true);
    h.server.editAsOther((other) => typeInto(other, 'imported elsewhere'));
    await until(() => xmlText(doc) === 'imported elsewhere');
  });

  it('does not even ask when the document already has content', async () => {
    installServer();
    const { doc, provider } = client();
    typeInto(doc, 'typed');
    const claim = vi.fn().mockResolvedValue(true);
    expect(await importLegacyIfNeeded(PAGE, doc, provider, { claim })).toBe('skipped');
    expect(claim).not.toHaveBeenCalled();
  });

  it('does not ask when the page does not need an import or the reader cannot edit', async () => {
    installServer();
    const { doc, provider } = client();
    const claim = vi.fn().mockResolvedValue(true);
    expect(await importLegacyIfNeeded({ ...PAGE, needsImport: false }, doc, provider, { claim })).toBe('skipped');
    expect(await importLegacyIfNeeded({ ...PAGE, canEdit: false }, doc, provider, { claim })).toBe('skipped');
    expect(claim).not.toHaveBeenCalled();
  });

  it('does not overwrite text typed while the claim was on its way', async () => {
    installServer();
    const { doc, provider } = client();
    const claim = async () => {
      typeInto(doc, 'typed meanwhile');
      return true;
    };
    expect(await importLegacyIfNeeded(PAGE, doc, provider, { claim })).toBe('skipped');
    expect(xmlText(doc)).toBe('typed meanwhile');
  });

  it('two clients opening the page together import it exactly once and end with the same content', async () => {
    const h = installServer();
    const a = client();
    const b = client();
    let granted = false;
    const claim = async () => {
      await flush();
      if (granted) return false; // the server grants exactly one caller
      granted = true;
      return true;
    };
    const [ra, rb] = await Promise.all([
      importLegacyIfNeeded(PAGE, a.doc, a.provider, { claim }),
      importLegacyIfNeeded(PAGE, b.doc, b.provider, { claim }),
    ]);
    expect([ra, rb].sort()).toEqual(['imported', 'not-granted']);
    await until(() => xmlText(a.doc) === xmlText(b.doc) && xmlText(a.doc).includes('Old text'));
    expect(h.server.doc.getXmlFragment('default').length).toBe(3);
    expect(xmlText(a.doc).match(/Old text/g)).toHaveLength(1);
  });
});
