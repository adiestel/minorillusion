/**
 * JoinTransport — the join-ritual seam (DECISIONS.md D8 / DESIGN.md "Join ritual").
 *
 * The *transport* under the "tap your phone to the hearth" gesture is chosen for
 * reliability, not NFC dogma:
 *   • **6-digit code + QR** — universal, always available. The QR (shown on the GM
 *     hearth) encodes the join URL with `?code=NNNNNN`; the player app reads that
 *     query param to prefill the code. This needs NO native capability and is the
 *     guaranteed path — so the web impl here is intentionally a no-op.
 *   • **BLE proximity** + **Android NFC (HCE)** — back the literal "tap" on native
 *     devices. These are a Capacitor-native concern (a future impl gated on
 *     `Capacitor.isNativePlatform()`, like haptics.ts) and **must never be hard-
 *     depended on** (iOS can't be the tapped NFC target; DESIGN). They degrade to
 *     the QR/code path.
 *
 * So this seam exposes only the NATIVE handoff (a BLE/NFC tap that yields a circle
 * code). `isSupported()` is false on the web; callers always keep the code/QR path.
 * When the native plugins are wired, a NativeJoinTransport replaces WebJoinTransport
 * here without touching any caller (the rule: never call a Capacitor plugin from
 * outside this module, and never without the native-platform guard).
 */

export interface JoinTransport {
  /** True only when a native tap transport (BLE/NFC) is available on this device.
   *  Web is always false — the QR/6-digit-code path covers everyone. */
  isSupported(): boolean;
  /**
   * Subscribe to a native tap-to-join handoff. The callback fires with the circle
   * code carried by a BLE/NFC tap. Returns an unsubscribe. On the web (and any
   * device without the native transport) this is a no-op — joining goes through the
   * QR/code screen instead.
   */
  onJoinCode(cb: (code: string) => void): () => void;
}

/** Web/PWA implementation: no BLE/NFC; the QR + 6-digit code path is used instead. */
class WebJoinTransport implements JoinTransport {
  isSupported(): boolean {
    return false;
  }
  onJoinCode(): () => void {
    return () => {};
  }
}

export const join: JoinTransport = new WebJoinTransport();
