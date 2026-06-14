/**
 * Text-to-speech behind an adapter interface (DECISIONS D11): the effect router
 * depends only on TtsProvider, so the concrete vendor (ElevenLabs today) is a
 * localized swap. The api key is read from the environment and NEVER logged or
 * folded into an error message.
 */

export interface TtsProvider {
  synthesize(text: string, voice?: string): Promise<Buffer>;
}

/** A stable ElevenLabs default voice ("Adam") used when the GM names no voice. */
const DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB";

/**
 * ElevenLabs TTS. POSTs to the text-to-speech endpoint and returns raw MP3
 * bytes. The key is sent only as the `xi-api-key` header; on a non-OK response
 * we throw with the status code alone (never the key or response body).
 */
export class ElevenLabsTts implements TtsProvider {
  async synthesize(text: string, voice?: string): Promise<Buffer> {
    const key = process.env.ELEVENLABS_API_KEY;
    const voiceId = voice ?? DEFAULT_VOICE_ID;
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key ?? "",
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body: JSON.stringify({ text, model_id: "eleven_multilingual_v2" }),
      },
    );
    if (!res.ok) {
      // Status only — never leak the api key or provider error body.
      throw new Error("TTS failed: " + res.status);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Fallback when no key is configured: synthesize is unavailable, not silent. */
export class NullTts implements TtsProvider {
  async synthesize(): Promise<Buffer> {
    throw new Error("TTS unavailable: set ELEVENLABS_API_KEY");
  }
}

/**
 * Pick the active provider from the environment: ElevenLabs when a non-empty
 * ELEVENLABS_API_KEY is present, otherwise the Null provider (which throws on
 * use). Resolved at call time so it follows the loaded .env.
 */
export function getTtsProvider(): TtsProvider {
  const key = process.env.ELEVENLABS_API_KEY;
  if (key !== undefined && key !== "") return new ElevenLabsTts();
  return new NullTts();
}

/** Wrap raw MP3 bytes as an inline data: URL the player can play directly. */
export function bufferToDataUrl(buf: Buffer): string {
  return "data:audio/mpeg;base64," + buf.toString("base64");
}
