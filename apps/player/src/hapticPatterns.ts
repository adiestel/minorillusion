/**
 * Concrete vibration patterns for each named HapticPattern.
 *
 * The contract speaks in named patterns (a small, wire-safe enum); the player
 * owns the concrete `number[]` realisation (a single number, or an
 * [on, off, on, …] array in ms). This is the one place those numbers live, so a
 * pattern can be re-felt without touching the dispatcher or the contract.
 *
 * Passed straight to `haptics.vibrate(...)` (capabilities/haptics.ts).
 */

import type { HapticPattern } from "@minorillusion/contract";

export const HAPTIC_PATTERNS: Record<HapticPattern, number[]> = {
  /** A short tap. */
  buzz: [40],
  /** Two quick taps. */
  double: [30, 60, 30],
  /** A long rolling rumble (distant thunder). */
  rumble: [200, 80, 200, 80, 260],
  /** lub-dub — a single heartbeat, then the inter-beat rest. */
  heartbeat: [70, 140, 70, 600],
  /** A rising three-tap flourish (join / confirm). */
  success: [30, 40, 80],
};
