/**
 * Capability-adapter seam (DECISIONS.md D8).
 *
 * Each device capability is an interface with (at minimum) a web implementation
 * that works in the browser and a no-op where the capability is absent.
 * Capacitor-native implementations arrive in M2 — when they land they will be
 * gated on `Capacitor.isNativePlatform()` and swapped in here, so callers never
 * need to change.
 *
 * Rule: never call a Capacitor plugin from outside this module, and never call
 * one without the native-platform guard.
 */

// ---------------------------------------------------------------------------
// HapticsCapability
// ---------------------------------------------------------------------------

export interface HapticsCapability {
  /**
   * Fire a vibration pattern.
   * @param pattern  A duration in ms, or an array of [vibrate, pause, …] ms.
   */
  vibrate(pattern: number | number[]): void;
}

/** Web implementation — uses navigator.vibrate when present, else a no-op. */
const webHaptics: HapticsCapability = {
  vibrate(pattern) {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(pattern);
    }
    // No-op on platforms where the Vibration API is unavailable (iOS Safari, etc.)
    // A Capacitor-native implementation using @capacitor/haptics arrives in M2.
  },
};

export const haptics: HapticsCapability = webHaptics;
