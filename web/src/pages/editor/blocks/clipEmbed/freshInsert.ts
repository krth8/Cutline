/**
 * Remembers that this browser has just inserted an empty clip block with the slash menu, so only that
 * block opens the clip picker by itself (other people's editors show the empty block quietly).
 */
let freshAt = 0;

export function markFreshClipBlock(): void {
  freshAt = Date.now();
}

/** True once, right after markFreshClipBlock(). */
export function takeFreshClipBlock(): boolean {
  const fresh = Date.now() - freshAt < 3000;
  freshAt = 0;
  return fresh;
}
