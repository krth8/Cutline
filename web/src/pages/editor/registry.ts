import type { AnyExtension, Editor, Range } from '@tiptap/core';

/** One entry of the slash menu. `run` receives the range of the typed `/query`; it must delete it. */
export interface SlashItem {
  /** Stable id (defaults to the title). Registering the same id again replaces the entry. */
  id?: string;
  title: string;
  description: string;
  /** A short text or emoji shown in the menu (no icon font is loaded). */
  icon?: string;
  keywords: string[];
  /** Section heading in the menu, e.g. "Basic", "Lists", "Media", "Advanced". */
  group: string;
  run(editor: Editor, range: Range): void;
}

export interface BlockDefinition {
  /** Node name as stored in the document (it is the XmlElement name in the Y.Doc). */
  name: string;
  /** The Tiptap Node (or any extension) that defines the block, usually with a React node view. */
  node: AnyExtension;
  /** One or more slash entries that insert the block. */
  slash?: SlashItem | SlashItem[];
  /** Keyboard shortcuts, in Tiptap notation ("Mod-Alt-9"). Return true when handled. */
  shortcuts?: Record<string, (editor: Editor) => boolean>;
}

const blocks = new Map<string, BlockDefinition>();
const slashItems = new Map<string, SlashItem>();
/** Slash items that came with a block, so unregistering the block removes them. */
const blockSlashIds = new Map<string, string[]>();

const slashId = (item: SlashItem) => item.id ?? item.title;

/**
 * Add a block type. Call it at module load, before an editor is created: the
 * editor builds its extension list from the registry when it is created.
 * Returns a function that removes the block again (used by tests).
 */
export function registerBlock(def: BlockDefinition): () => void {
  blocks.set(def.name, def);
  const items = def.slash === undefined ? [] : Array.isArray(def.slash) ? def.slash : [def.slash];
  const ids = items.map((item) => {
    slashItems.set(slashId(item), item);
    return slashId(item);
  });
  blockSlashIds.set(def.name, ids);
  return () => {
    if (blocks.get(def.name) !== def) return;
    blocks.delete(def.name);
    for (const id of blockSlashIds.get(def.name) ?? []) slashItems.delete(id);
    blockSlashIds.delete(def.name);
  };
}

/** Add a slash entry that does not come with a node (e.g. a command that inserts existing blocks). */
export function registerSlashItem(item: SlashItem): () => void {
  slashItems.set(slashId(item), item);
  return () => {
    if (slashItems.get(slashId(item)) === item) slashItems.delete(slashId(item));
  };
}

export function getRegisteredBlocks(): BlockDefinition[] {
  return [...blocks.values()];
}

export function getRegisteredSlashItems(): SlashItem[] {
  return [...slashItems.values()];
}
