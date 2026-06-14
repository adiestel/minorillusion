/**
 * Capability-adapter seam (DECISIONS.md D8).
 *
 * Each device capability is an interface with a web implementation that works in
 * the browser (or no-ops where the capability is absent) and, where it matters,
 * a Capacitor-native implementation gated on `Capacitor.isNativePlatform()`.
 * Callers import only the singletons here and never branch on platform.
 *
 * Rule: never call a Capacitor plugin from outside this module, and never call
 * one without the native-platform guard.
 *
 *   • haptics — vibration (web navigator.vibrate / native @capacitor/haptics).
 *   • audio   — bundled cue + data: URL playback, with iOS unlock priming.
 */

export type { HapticsCapability } from "./haptics";
export { haptics } from "./haptics";

export type { AudioHandle } from "./audio";
export { audio } from "./audio";
