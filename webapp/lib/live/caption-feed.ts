/** Newest-first caption feed ordering: the live edge is the TOP of the feed
 *  and older captions push downward, so a phone held one-handed keeps the
 *  reader's eyes on a fixed position at the top of the screen. */

export const PIN_THRESHOLD_PX = 48;

export function newestFirst<T>(items: readonly T[]): T[] {
  return [...items].reverse();
}

/** The reader is "pinned" to the live edge while scrolled at (or near) the
 *  top; scrolling down to read history unpins so new captions never yank
 *  the scroll position away. */
export function isPinnedToLatest(scrollTop: number, thresholdPx: number = PIN_THRESHOLD_PX): boolean {
  return scrollTop < thresholdPx;
}
