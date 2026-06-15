/**
 * Speech-to-text behind an adapter interface (DECISIONS D11): the socket layer
 * depends only on SttProvider, so the concrete vendor (ElevenLabs Scribe today,
 * the same ELEVENLABS_API_KEY as TTS) is a localized swap. This is the inverse
 * of tts.ts — audio bytes in, text out. The api key is read from the environment
 * and NEVER logged or folded into an error message.
 */

export interface SttProvider {
  /** Transcribe an audio clip to text. mimeType labels the upload (e.g. "audio/webm"). */
  transcribe(audio: Buffer, mimeType?: string): Promise<string>;
}

/**
 * ElevenLabs Scribe. POSTs the audio as multipart/form-data to the
 * speech-to-text endpoint and returns the recognized text. The key is sent only
 * as the `xi-api-key` header; on a non-OK response we throw with the status code
 * alone (never the key or response body).
 */
export class ElevenLabsStt implements SttProvider {
  async transcribe(audio: Buffer, mimeType?: string): Promise<string> {
    const key = process.env.ELEVENLABS_API_KEY;
    const form = new FormData();
    // Wrap the bytes as a Blob so FormData uploads them as a file part.
    form.append("file", new Blob([audio], { type: mimeType ?? "audio/webm" }));
    form.append("model_id", "scribe_v1");
    const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: {
        "xi-api-key": key ?? "",
        // Content-Type (with the multipart boundary) is set by fetch from the FormData.
      },
      body: form,
    });
    if (!res.ok) {
      // Status only — never leak the api key or provider error body.
      throw new Error("STT failed: " + res.status);
    }
    const data = (await res.json()) as { text?: unknown };
    if (typeof data.text !== "string") {
      throw new Error("STT returned no text");
    }
    return data.text.trim();
  }
}

/** Fallback when no key is configured: transcribe is unavailable, not silent. */
export class NullStt implements SttProvider {
  async transcribe(): Promise<string> {
    throw new Error("STT unavailable: set ELEVENLABS_API_KEY");
  }
}

/**
 * The active provider: ElevenLabs Scribe when a non-empty ELEVENLABS_API_KEY is
 * present, otherwise the Null provider (which throws on use). No cache is needed
 * — clips are unique — but the instance is memoized so repeated calls reuse it.
 */
let cachedProvider: ElevenLabsStt | null = null;
export function getSttProvider(): SttProvider {
  const key = process.env.ELEVENLABS_API_KEY;
  if (key === undefined || key === "") return new NullStt();
  if (cachedProvider === null) cachedProvider = new ElevenLabsStt();
  return cachedProvider;
}

/**
 * Parse a data: URL ("data:audio/webm;base64,AAAA...") into raw bytes + mime
 * type — the inverse of tts.ts's bufferToDataUrl. The mime defaults to
 * application/octet-stream when absent. Throws on a malformed string (not
 * `data:`-prefixed, or no base64 payload) so the caller can surface it as a
 * failed ack.
 */
export function dataUrlToParts(dataUrl: string): { buffer: Buffer; mimeType: string } {
  if (!dataUrl.startsWith("data:")) throw new Error("Invalid data URL");
  const comma = dataUrl.indexOf(",");
  if (comma === -1) throw new Error("Invalid data URL");
  // header is "data:<mime>;base64" (mime optional); payload is everything after the comma.
  const header = dataUrl.slice("data:".length, comma);
  const payload = dataUrl.slice(comma + 1);
  if (!header.includes(";base64") || payload === "") throw new Error("Invalid data URL");
  const mimeType = header.slice(0, header.indexOf(";base64")) || "application/octet-stream";
  return { buffer: Buffer.from(payload, "base64"), mimeType };
}
