/**
 * A "grab bag" (shuffle-bag) drawer: instead of picking independently at random
 * each time — which lets the same item repeat back-to-back — we shuffle the full
 * set, hand out each item exactly once, then reshuffle. Over any window the size
 * of the library every item appears once, so nothing replays on a loop.
 *
 * Used by the whisperscape phrase runner so the spoken whispers cycle through
 * the whole library rather than landing on the same line twice in a row.
 */

/** Fisher–Yates shuffle into a fresh array (input untouched). */
function shuffle<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i];
    a[i] = a[j]!;
    a[j] = tmp!;
  }
  return a;
}

/**
 * Returns a `draw()` that yields items in shuffled, non-repeating passes. When a
 * pass empties, the bag reshuffles; if the very next draw would repeat the item
 * that just played (the bag seam), it's swapped away so no line plays twice in a
 * row. `draw()` returns undefined only for an empty library. The source array is
 * captured by reference but only read, so a stable snapshot is expected.
 */
export function makeGrabBag<T>(items: readonly T[]): () => T | undefined {
  let bag: T[] = [];
  let last: T | undefined;
  return () => {
    if (items.length === 0) return undefined;
    if (bag.length === 0) {
      bag = shuffle(items);
      // Draws pop from the end; if that next item equals the last one drawn,
      // swap it with the bag's front so we don't repeat across the seam.
      if (items.length > 1 && bag[bag.length - 1] === last) {
        const tmp = bag[bag.length - 1]!;
        bag[bag.length - 1] = bag[0]!;
        bag[0] = tmp;
      }
    }
    last = bag.pop();
    return last;
  };
}
