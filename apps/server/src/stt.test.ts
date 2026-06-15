import { describe, expect, it } from "vitest";
import { dataUrlToParts, getSttProvider, NullStt, type SttProvider } from "./stt.js";

/**
 * dataUrlToParts is the inverse of bufferToDataUrl: it splits a base64 data: URL
 * back into raw bytes + the labelled mime type so the STT adapter can upload the
 * clip. These pin the round-trip and the malformed-input throw (which the caller
 * surfaces as a failed ack). No network — provider selection is exercised via
 * env, transcription itself is the fake below.
 */
describe("dataUrlToParts", () => {
  it("round-trips a base64 data URL to its bytes and mime type", () => {
    const bytes = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    const dataUrl = "data:audio/webm;base64," + bytes.toString("base64");
    const { buffer, mimeType } = dataUrlToParts(dataUrl);
    expect(mimeType).toBe("audio/webm");
    expect(buffer.equals(bytes)).toBe(true);
  });

  it("defaults the mime type when the header omits it", () => {
    const dataUrl = "data:;base64," + Buffer.from("hi").toString("base64");
    expect(dataUrlToParts(dataUrl).mimeType).toBe("application/octet-stream");
  });

  it("throws on a string that isn't a data URL", () => {
    expect(() => dataUrlToParts("not-a-data-url")).toThrow("Invalid data URL");
  });

  it("throws on a data URL with no base64 payload", () => {
    expect(() => dataUrlToParts("data:audio/webm;base64,")).toThrow("Invalid data URL");
  });
});

/**
 * Without a configured key the adapter selects the Null provider, which throws
 * (rather than silently returning "") on use. We save/restore the env var so we
 * don't disturb other tests.
 */
describe("getSttProvider", () => {
  it("returns a NullStt when ELEVENLABS_API_KEY is unset, and it rejects on use", async () => {
    const saved = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const provider = getSttProvider();
      expect(provider).toBeInstanceOf(NullStt);
      await expect(provider.transcribe(Buffer.alloc(0))).rejects.toThrow(
        "STT unavailable: set ELEVENLABS_API_KEY",
      );
    } finally {
      if (saved === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = saved;
    }
  });
});

/** A fake provider showing SttProvider is implementable without any network. */
describe("SttProvider", () => {
  it("is implementable by a fake that returns a fixed transcript", async () => {
    const fake: SttProvider = {
      async transcribe() {
        return "a fixed transcript";
      },
    };
    await expect(fake.transcribe(Buffer.from("anything"))).resolves.toBe("a fixed transcript");
  });
});
