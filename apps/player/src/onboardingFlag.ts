/**
 * Tracks whether the first-run onboarding gesture-teach has been shown on this
 * device (M7). Persisted under `mi.onboarded` in localStorage, alongside the
 * other per-device flags (deviceId.ts, session.ts).
 *
 * The onboarding overlay (Onboarding.tsx) teaches the tap → quill/ball + hold-to-
 * talk gestures, and should appear exactly once per device — after the player's
 * first successful join. main.tsx reads hasOnboarded() to decide whether to show
 * it, and calls markOnboarded() when the player dismisses it ("got it").
 *
 * It's a localStorage flag, not part of the joined session, so clearing the
 * session (eject / decline / sign-out) does NOT re-trigger the teach — a player
 * who's seen it once never sees it again on the same device.
 *
 * (Named `onboardingFlag.ts`, distinct from the `Onboarding.tsx` component, so
 * the two files don't collide on a case-insensitive filesystem.)
 */

const STORAGE_KEY = "mi.onboarded";

/** True once the player has seen + dismissed the onboarding teach on this device. */
export function hasOnboarded(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    // If storage is unavailable, treat as "seen" — better to skip a one-time
    // teach than to nag every load (D10 graceful degradation).
    return true;
  }
}

/** Persist that the onboarding teach has been shown (called on dismiss). */
export function markOnboarded(): void {
  try {
    localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* storage unavailable — nothing to persist; the teach just won't repeat-gate */
  }
}
