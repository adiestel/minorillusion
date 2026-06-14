/**
 * HapticsCapability — the vibration seam (DECISIONS.md D8).
 *
 * One interface, two implementations:
 *   • web    — navigator.vibrate (Android browsers; no-ops on iOS Safari).
 *   • native — @capacitor/haptics, selected only on a native platform.
 *
 * The interface is `vibrate(pattern: number | number[])` so callers (and the
 * named-pattern table in hapticPatterns.ts) never branch on platform.
 *
 * Rule: never call a Capacitor plugin from outside this module, and never call
 * one without the native-platform guard.
 */

import { Capacitor } from "@capacitor/core";

export interface HapticsCapability {
  /**
   * Fire a vibration pattern.
   * @param pattern  A duration in ms, or an array of [vibrate, pause, …] ms.
   */
  vibrate(pattern: number | number[]): void;
}

// ---------------------------------------------------------------------------
// Web implementation — navigator.vibrate where present, else a clean no-op.
// ---------------------------------------------------------------------------

const webHaptics: HapticsCapability = {
  vibrate(pattern) {
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.vibrate === "function"
    ) {
      navigator.vibrate(pattern);
    }
    // No-op on platforms without the Vibration API (iOS Safari, desktop, …).
  },
};

// ---------------------------------------------------------------------------
// Native implementation — @capacitor/haptics.
//
// The plugin only exposes a single-pulse `vibrate({ duration })`, so an
// [on, off, on, …] pattern is reconstructed by scheduling each "on" segment
// with setTimeout at its cumulative offset. Every plugin call is fire-and-forget
// and swallows rejection (the capability is best-effort; a missing motor or a
// permission refusal must never throw into the render loop).
// ---------------------------------------------------------------------------

function nativeVibrateOnce(duration: number): void {
  if (duration <= 0) return;
  // Lazy import keeps the plugin out of the web bundle's eager path; it is only
  // reached behind the isNativePlatform() guard below.
  void import("@capacitor/haptics")
    .then(({ Haptics }) => Haptics.vibrate({ duration }))
    .catch(() => {
      /* best-effort: ignore unsupported/denied */
    });
}

const nativeHaptics: HapticsCapability = {
  vibrate(pattern) {
    if (typeof pattern === "number") {
      nativeVibrateOnce(pattern);
      return;
    }
    // Array is [on, off, on, off, …]; play the even-indexed "on" segments,
    // each scheduled at the sum of all preceding segments.
    let offset = 0;
    for (let i = 0; i < pattern.length; i++) {
      const segment = pattern[i] ?? 0;
      if (i % 2 === 0 && segment > 0) {
        if (offset === 0) {
          nativeVibrateOnce(segment);
        } else {
          window.setTimeout(() => nativeVibrateOnce(segment), offset);
        }
      }
      offset += segment;
    }
  },
};

// Select native only on a real native platform; web everywhere else (incl. PWA).
export const haptics: HapticsCapability = Capacitor.isNativePlatform()
  ? nativeHaptics
  : webHaptics;
