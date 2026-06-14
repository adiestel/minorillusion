import { describe, expect, it } from "vitest";
import { bufferToDataUrl, estimateClipMs } from "./tts.js";

/**
 * estimateClipMs maps a 128 kbps CBR mp3's byte size to its play duration so the
 * whisperscape can wait for a clip to finish before timing the next one. These
 * pin the byte→ms math (16000 bytes/sec), the [0.6s, 30s] clamp, and the
 * char-rate fallback used when no clip data is available.
 */
describe("estimateClipMs", () => {
  /** A data: URL whose base64 payload decodes to ~`bytes` bytes. */
  function dataUrlOfBytes(bytes: number): string {
    // base64 length ≈ bytes × 4/3; bufferToDataUrl adds the right prefix.
    return bufferToDataUrl(Buffer.alloc(bytes));
  }

  it("derives duration from byte size at 128 kbps (16000 bytes/sec)", () => {
    // 16000 bytes ≈ 1.0s, 120000 bytes ≈ 7.5s.
    expect(estimateClipMs("x", dataUrlOfBytes(16_000))).toBeCloseTo(1000, -1);
    expect(estimateClipMs("x", dataUrlOfBytes(120_000))).toBeCloseTo(7500, -1);
  });

  it("clamps a very long clip to 30s and a tiny clip up to 0.6s", () => {
    expect(estimateClipMs("x", dataUrlOfBytes(2_000_000))).toBe(30_000); // ~125s → 30s
    expect(estimateClipMs("x", dataUrlOfBytes(100))).toBe(600); // ~6ms → 0.6s floor
  });

  it("uses the accurate byte duration even when the text is long", () => {
    // A short clip with long text still uses the (accurate) byte duration, not
    // the inflated char-rate guess.
    const ms = estimateClipMs("a".repeat(500), dataUrlOfBytes(32_000));
    expect(ms).toBeCloseTo(2000, -1);
  });

  it("falls back to a char-rate guess with no data URL", () => {
    expect(estimateClipMs("hello")).toBe(1500 + 5 * 60); // 1800
  });

  it("caps the char-rate fallback at 20s", () => {
    expect(estimateClipMs("a".repeat(1000))).toBe(20_000);
  });

  it("falls back when the string isn't a data URL (no comma)", () => {
    expect(estimateClipMs("hi", "not-a-data-url")).toBe(1500 + 2 * 60); // 1620
  });
});
