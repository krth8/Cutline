/**
 * The mention block: an inline chip for a person, task, page or clip, written with @. Importing this file
 * registers the node. It is imported by the editor chunk (through blocks/index.ts).
 */
import './mention.css';
import { registerBlock } from '../../registry';
import { MENTION } from './model';
import { Mention } from './mentionNode';

export { Mention, MentionStore } from './mentionNode';
export { MENTION, MENTION_KINDS, type MentionAttrs, type MentionKind } from './model';

registerBlock({ name: MENTION, node: Mention });
