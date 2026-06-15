/**
 * GL budget — caps the number of concurrent heavy GL islands (DESIGN.md D7:
 * "GL islands are transient … cap ~1–2 heavy ones at a time").
 *
 * A phone lies face-up on the table for hours; each live WebGL context is a hot
 * GPU loop that cooks and drains it, so we never run more than a couple at once.
 * An island acquires a slot when it mounts and releases it on unmount; if no slot
 * is free, the island renders its cheap fallback instead (graceful degradation).
 *
 * Pure + synchronous (no React) so it's trivially unit-tested; the React glue
 * lives in `useGLEnabled`.
 */

export interface GLBudget {
  /** Reserve a slot for `id`. Returns true if granted (idempotent per id). */
  acquire(id: string): boolean;
  /** Release `id`'s slot (no-op if it wasn't holding one). */
  release(id: string): void;
  /** Free slots remaining. */
  available(): number;
  /** Ids currently holding a slot. */
  inUse(): string[];
  /** The cap this budget was created with. */
  readonly max: number;
}

/** Create a budget that admits at most `max` concurrent heavy islands. */
export function createGLBudget(max = 2): GLBudget {
  const held = new Set<string>();
  return {
    get max() {
      return max;
    },
    acquire(id: string): boolean {
      if (held.has(id)) return true; // already holding — idempotent
      if (held.size >= max) return false; // over budget → caller uses the fallback
      held.add(id);
      return true;
    },
    release(id: string): void {
      held.delete(id);
    },
    available(): number {
      return Math.max(0, max - held.size);
    },
    inUse(): string[] {
      return [...held];
    },
  };
}

/**
 * The app-wide budget: at most 2 heavy GL islands live at once (e.g. the crystal
 * ball + a set of dice). Islands share this single instance via `useGLEnabled`.
 */
export const glBudget: GLBudget = createGLBudget(2);
