/**
 * Phrase-ordering helpers for the whisperscape runner.
 *
 * `makeGrabBag` is a "grab bag" (shuffle-bag) drawer: instead of picking
 * independently at random each time — which lets the same item repeat
 * back-to-back — we shuffle the full set, hand out each item exactly once, then
 * reshuffle. Over any window the size of the library every item appears once, so
 * nothing replays on a loop.
 *
 * `makePhraseSequencer` builds on it to drive the runner: it yields phrases
 * either in grab-bag random order or in the GM's sequential order, tracks the
 * position within the current pass (for the live "now playing / N left"
 * readout), and signals when a non-looping run has played its final phrase.
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

/** What a sequencer step yields: the phrase to speak now + where it sits. */
export interface PhraseStep {
  /** The phrase to play this fire. */
  phrase: string;
  /** 0-based position within the current pass. */
  index: number;
  /** Library size. */
  total: number;
  /** Phrases left in this pass after the current one. */
  remaining: number;
  /** True when this is the last phrase of a non-looping run (stop after it). */
  done: boolean;
}

/**
 * Drive a whisperscape's phrase order. `order: "sequential"` walks the library
 * in the given order; `order: "random"` draws from a grab bag (a full no-repeat
 * pass before reshuffling). Each pass is `phrases.length` steps; `index` is the
 * position within the pass and `remaining` counts those left after the current
 * one. When `loop` is false, the step that plays the pass's last phrase reports
 * `done: true` and the caller stops after it plays out. Returns null only for an
 * empty library. The phrases array is read by reference (a stable snapshot).
 */
export function makePhraseSequencer(
  phrases: readonly string[],
  order: "random" | "sequential",
  loop: boolean,
): () => PhraseStep | null {
  const total = phrases.length;
  const draw = order === "random" ? makeGrabBag(phrases) : null;
  let count = 0; // total phrases handed out across all passes
  return () => {
    if (total === 0) return null;
    const index = count % total; // position within the current pass
    const phrase = draw ? (draw() as string) : phrases[index]!;
    count++;
    const remaining = total - 1 - index;
    return { phrase, index, total, remaining, done: !loop && remaining === 0 };
  };
}
