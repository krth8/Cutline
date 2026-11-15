import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { outline } from '../editor/testing/helpers';
import { legacyHtmlToNode, writeHtmlIntoDoc } from './htmlImport';
import { isDocEmpty } from './legacyImport';

function convert(html: string): string {
  return outline(legacyHtmlToNode(html).toJSON());
}

describe('legacy HTML to editor content', () => {
  const table: Array<[string, string, string]> = [
    ['paragraph', '<p>Hello</p>', 'paragraph(Hello)'],
    ['headings', '<h1>A</h1><h2>B</h2><h3>C</h3>', 'h1(A) h2(B) h3(C)'],
    ['bullet list', '<ul><li>one</li><li>two</li></ul>', 'bulletList(listItem(paragraph(one)) listItem(paragraph(two)))'],
    ['ordered list', '<ol><li>one</li></ol>', 'orderedList(listItem(paragraph(one)))'],
    ['blockquote', '<blockquote><p>Quote</p></blockquote>', 'blockquote(paragraph(Quote))'],
    ['code block', '<pre>let a = 1;</pre>', 'codeBlock(let a = 1;)'],
    ['marks', '<p><strong>b</strong> <em>i</em> <u>u</u> <s>s</s></p>', 'paragraph(<bold>b <italic>i <underline>u <strike>s)'],
    ['link', '<p><a href="https://example.com/x">x</a></p>', 'paragraph(<link>x)'],
    ['rule', '<p>a</p><hr><p>b</p>', 'paragraph(a) horizontalRule() paragraph(b)'],
    [
      'to-do, open and done',
      '<div class="docs-todo"><input type="checkbox"><span>open</span></div>' +
        '<div class="docs-todo completed"><input type="checkbox"><span>done</span></div>',
      'taskList(taskItem(paragraph(open)) taskItem(paragraph(done)))',
    ],
    [
      'to-do between paragraphs',
      '<p>before</p><div class="docs-todo"><input type="checkbox"><span>x</span></div><p>after</p>',
      'paragraph(before) taskList(taskItem(paragraph(x))) paragraph(after)',
    ],
    ['data-bid is dropped', '<p data-bid="b1">kept</p>', 'paragraph(kept)'],
  ];

  it.each(table)('%s', (_name, html, expected) => {
    expect(convert(html)).toBe(expected);
  });

  it('keeps the checked state of to-dos', () => {
    const json = legacyHtmlToNode(
      '<div class="docs-todo"><input type="checkbox"><span>a</span></div>' +
        '<div class="docs-todo completed"><input type="checkbox" checked><span>b</span></div>',
    ).toJSON();
    const items = json.content[0].content;
    expect(items.map((i: { attrs: { checked: boolean } }) => i.attrs.checked)).toEqual([false, true]);
  });

  it('puts neighbouring to-dos into one list and splits at other blocks', () => {
    const todo = (t: string) => `<div class="docs-todo"><input type="checkbox"><span>${t}</span></div>`;
    expect(convert(todo('a') + todo('b') + '<p>x</p>' + todo('c'))).toBe(
      'taskList(taskItem(paragraph(a)) taskItem(paragraph(b))) paragraph(x) taskList(taskItem(paragraph(c)))',
    );
  });

  describe('sanitising', () => {
    const dirty: Array<[string, string]> = [
      ['script element', '<p>a</p><script>window.hacked = 1</script>'],
      ['script inside a paragraph', '<p>a<script>alert(1)</script></p>'],
      ['style element', '<style>p{color:red}</style><p>a</p>'],
      ['iframe', '<iframe src="https://evil.example"></iframe><p>a</p>'],
      ['event handler', '<p onclick="alert(1)">a</p>'],
      ['image error handler', '<p>a</p><img src="x" onerror="alert(1)">'],
      ['inline style', '<p style="color:red; position:fixed">a</p>'],
      ['javascript link', '<p><a href="javascript:alert(1)">a</a></p>'],
      ['obfuscated javascript link', '<p><a href="  JaVa\nScRiPt:alert(1)">a</a></p>'],
      ['svg with script', '<svg><script>alert(1)</script></svg><p>a</p>'],
    ];

    it.each(dirty)('%s does not survive', (_name, html) => {
      const node = legacyHtmlToNode(html);
      const dom = JSON.stringify(node.toJSON());
      expect(dom).not.toMatch(/script|alert|onclick|onerror|javascript|evil|color:red|position|hacked/i);
      expect(outline(node.toJSON())).toMatch(/^paragraph\(a\)/);
    });

    it('drops a javascript: href but keeps the text', () => {
      expect(convert('<p><a href="javascript:alert(1)">click</a></p>')).toBe('paragraph(click)');
    });

    it('does not run anything while parsing', () => {
      const w = window as unknown as { hacked?: number };
      delete w.hacked;
      legacyHtmlToNode('<img src="x" onerror="window.hacked = 1"><script>window.hacked = 1</script>');
      expect(w.hacked).toBeUndefined();
    });
  });
});

describe('writing into the document', () => {
  it('fills the fragment with a single update', () => {
    const doc = new Y.Doc();
    let updates = 0;
    doc.on('update', () => updates++);
    expect(isDocEmpty(doc)).toBe(true);
    writeHtmlIntoDoc(doc, '<h1>Title</h1><p>one</p><p>two</p>');
    expect(updates).toBe(1);
    expect(isDocEmpty(doc)).toBe(false);
    expect(doc.getXmlFragment('default').toArray().map((n) => (n as Y.XmlElement).nodeName)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
    ]);
  });

  it('treats a lone empty paragraph as empty', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('default').insert(0, [new Y.XmlElement('paragraph')]);
    expect(isDocEmpty(doc)).toBe(true);
  });
});
