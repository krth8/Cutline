/**
 * Plain logic of the mention node (no React, no Tiptap, no platform): kinds, what the node stores, the
 * shape of the search results and how they are listed in the menu. Used by the node (editor chunk) and by
 * the host (main bundle).
 */

/** The node name in the document (PLAN.md 5.8). */
export const MENTION = 'mention';

export const MENTION_KINDS = ['person', 'task', 'page', 'clip'] as const;
export type MentionKind = (typeof MENTION_KINDS)[number];

export function isMentionKind(value: unknown): value is MentionKind {
  return typeof value === 'string' && (MENTION_KINDS as readonly string[]).includes(value);
}

/** The attributes of the node: what it points at, and the name it had when it was inserted (shown when the target cannot be loaded). */
export interface MentionAttrs {
  kind: MentionKind;
  /** A user id, a task id, a page id, or `<projectId>:<clipBaseName>` for a clip. */
  id: string;
  label: string;
}

/** One entry of `GET /api/mentions/search`. */
export interface MentionItem {
  kind: MentionKind;
  id: string;
  label: string;
  icon?: string | null;
  projectName?: string | null;
  space?: string;
}

export interface MentionSearchResult {
  people: MentionItem[];
  tasks: MentionItem[];
  pages: MentionItem[];
  clips: MentionItem[];
}

export const EMPTY_RESULT: MentionSearchResult = { people: [], tasks: [], pages: [], clips: [] };

/** Section headings, in menu order. */
export const SECTIONS: Array<{ key: keyof MentionSearchResult; title: string }> = [
  { key: 'people', title: 'People' },
  { key: 'tasks', title: 'Tasks' },
  { key: 'pages', title: 'Pages' },
  { key: 'clips', title: 'Clips' },
];

/** The results as one list in menu order (the keyboard moves through it). */
export function flattenResult(result: MentionSearchResult): MentionItem[] {
  return SECTIONS.flatMap((s) => result[s.key]);
}

/** What `POST /api/mentions/resolve` says about one chip. */
export interface ResolvedMention {
  kind: MentionKind;
  id: string;
  ok: boolean;
  title?: string;
  icon?: string;
  /** Where the chip leads: a path, or `?task=<id>` meaning "this route with the task panel open". Absent for people. */
  route?: string | null;
  projectId?: string;
}

/** Fallback text for a chip that has no stored label. */
export function defaultLabel(kind: MentionKind): string {
  return { person: 'Person', task: 'Task', page: 'Page', clip: 'Clip' }[kind];
}

/** The symbol in front of a chip or menu entry. */
export function kindIcon(kind: MentionKind, icon?: string | null): string {
  if (icon) return icon;
  return { person: '@', task: '☑', page: '\u{1F4C4}', clip: '\u{1F39E}' }[kind];
}
