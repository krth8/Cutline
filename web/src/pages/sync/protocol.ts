/** Frame layout of the page sync protocol (PLAN.md 5.7): [type byte][payload]. */
export const SYNC_STATE = 0;
export const UPDATE = 1;
export const AWARENESS = 2;
export const STATE_VECTOR = 3;

/** The server drops frames above this size without a word. */
export const MAX_FRAME_BYTES = 5 * 1024 * 1024;

/** Close codes the server uses. */
export const CLOSE_SESSION_ENDED = 4401;
export const CLOSE_ACCESS_REMOVED = 4403;
export const CLOSE_BAD_DATA = 1007;

export function frame(type: number, payload: Uint8Array) {
  const out = new Uint8Array(payload.length + 1);
  out[0] = type;
  out.set(payload, 1);
  return out;
}

/** The Y.XmlFragment that holds the content. Same as the editor's FRAGMENT_NAME (a test checks it); repeated here so the main bundle does not import the editor. */
export const FRAGMENT_NAME = 'default';
