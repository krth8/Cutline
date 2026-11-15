export { Editor, type EditorProps } from './Editor';
export { FRAGMENT_NAME, type EditorUser } from './buildExtensions';
export {
  registerBlock,
  registerSlashItem,
  getRegisteredBlocks,
  getRegisteredSlashItems,
  type BlockDefinition,
  type SlashItem,
} from './registry';
export { Callout, CALLOUT_TONES, type CalloutTone } from './extensions/callout';
export { filterSlashItems } from './filter';
// For the collaboration client: the schema behind the editor, to turn legacy HTML into content.
export { buildExtensions, type BuildOptions } from './buildExtensions';
export { SlashStore } from './extensions/slash';
