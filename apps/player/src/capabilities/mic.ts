/**
 * MicCapability — the microphone seam (DECISIONS.md D8; INVIOLABLE D10).
 *
 * The cheap path: the browser's `getUserMedia` + `MediaRecorder`. A capture is
 * ALWAYS player-initiated (press-and-hold the crystal ball, see PlayerInput.tsx)
 * and lives only for the hold: start() opens the stream, stop()/cancel() halt the
 * recorder AND stop every MediaStream track so the OS/browser mic-active
 * indicator turns off the instant the player releases. We never hold the mic open
 * between captures.
 *
 * INVIOLABLE (D10): the microphone is never silently activated. This module only
 * ever runs inside a player gesture; nothing here can capture without start()
 * being called from the held PTT, and the UI shows a visible "● recording"
 * indicator the entire time a track is live. stop()/cancel() releasing the tracks
 * is what makes that indicator (and the OS one) go dark.
 *
 * Graceful degradation (D10): isSupported() feature-detects getUserMedia +
 * MediaRecorder; start() rejects (never throws into the render loop) when
 * unsupported or when permission is denied, so the caller can fall back to text.
 *
 * Capacitor-native seam: for M3 the web `MediaRecorder` works inside the
 * Capacitor WebView, so there is no native branch yet. A dedicated native path
 * (e.g. a `@capacitor`/native microphone plugin, selected behind
 * `Capacitor.isNativePlatform()` like haptics.ts) can replace this web impl later
 * for better codecs / background reliability — without changing this interface or
 * any caller. Do NOT add a Capacitor microphone dependency now.
 *
 * Rule (mirrors audio.ts / haptics.ts): callers import only the `mic` singleton
 * and never touch getUserMedia / MediaRecorder directly.
 */

export interface MicCapability {
  /** Feature-detect: is recording possible at all on this device/browser? */
  isSupported(): boolean;
  /** Begin capturing (requests mic permission on first call). Rejects if unsupported/denied. */
  start(): Promise<void>;
  /** Stop + RELEASE the mic (stop all tracks → indicator off); resolve the recorded clip. */
  stop(): Promise<{ dataUrl: string; mimeType: string; durationMs: number }>;
  /** Abort an in-progress capture WITHOUT producing a clip; release the mic. */
  cancel(): void;
  /** True while actively capturing. */
  isRecording(): boolean;
}

// ---------------------------------------------------------------------------
// Feature detection — capture references once, tolerate their absence.
// ---------------------------------------------------------------------------

/** Candidate MIME types, in preference order; "" lets the browser pick. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "",
] as const;

/** True when getUserMedia + MediaRecorder both exist on this device/browser. */
function detectSupport(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices !== "undefined" &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof MediaRecorder !== "undefined"
  );
}

/** Pick the first candidate MediaRecorder accepts; "" = browser default. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const candidate of MIME_CANDIDATES) {
    if (candidate === "") return "";
    try {
      if (MediaRecorder.isTypeSupported(candidate)) return candidate;
    } catch {
      /* isTypeSupported can throw on odd inputs — try the next candidate */
    }
  }
  return "";
}

/** Assemble recorded chunks into a data: URL via FileReader. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === "string") resolve(result);
      else reject(new Error("unexpected FileReader result"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class WebMic implements MicCapability {
  /** The live capture stream while recording (null otherwise). */
  private stream: MediaStream | null = null;
  /** The active recorder while recording (null otherwise). */
  private recorder: MediaRecorder | null = null;
  /** Collected audio chunks for the current capture. */
  private chunks: Blob[] = [];
  /** performance.now() at capture start, for durationMs. */
  private startedAt = 0;
  /** True between start() and stop()/cancel(). */
  private recording = false;

  isSupported(): boolean {
    return detectSupport();
  }

  isRecording(): boolean {
    return this.recording;
  }

  async start(): Promise<void> {
    if (this.recording) return; // already capturing — idempotent
    if (!detectSupport()) {
      throw new Error("microphone capture is not supported on this device");
    }

    // Requests permission on first call; rejects (caught by the caller) on deny.
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // Permission denied / no device / hardware error — surface as a rejection
      // so the caller degrades to text; never leave a half-open stream.
      throw err instanceof Error ? err : new Error("microphone access failed");
    }

    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      // Construction failed (e.g. the chosen MIME was rejected): retry with the
      // browser default, and if THAT fails, release the stream and reject.
      try {
        recorder = new MediaRecorder(stream);
      } catch (err) {
        stream.getTracks().forEach((t) => t.stop());
        throw err instanceof Error ? err : new Error("MediaRecorder unavailable");
      }
    }

    this.chunks = [];
    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    this.stream = stream;
    this.recorder = recorder;
    this.startedAt = performance.now();
    this.recording = true;
    recorder.start();
  }

  async stop(): Promise<{ dataUrl: string; mimeType: string; durationMs: number }> {
    const recorder = this.recorder;
    const stream = this.stream;
    if (recorder === null || stream === null || !this.recording) {
      // Nothing was capturing — release just in case and report an empty clip.
      this.release();
      throw new Error("not recording");
    }

    const durationMs = Math.max(0, Math.round(performance.now() - this.startedAt));
    // The recorder's actual MIME (may differ from / be more specific than asked).
    const mimeType = recorder.mimeType || pickMimeType() || "audio/webm";

    // Wait for the recorder to flush its final chunk, then assemble the clip. We
    // ALWAYS release the mic (stop every track → indicator off) before resolving,
    // even if assembly fails.
    const finalBlob = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => {
        resolve(new Blob(this.chunks, mimeType ? { type: mimeType } : undefined));
      };
      try {
        recorder.stop(); // fires a final ondataavailable, then onstop
      } catch {
        // Already inactive — resolve with whatever we collected.
        resolve(new Blob(this.chunks, mimeType ? { type: mimeType } : undefined));
      }
    });

    // Release the hardware the moment capture ends (turns the indicator off).
    this.release();

    const dataUrl = await blobToDataUrl(finalBlob);
    return { dataUrl, mimeType, durationMs };
  }

  cancel(): void {
    // Abort WITHOUT producing a clip; always release the mic.
    const recorder = this.recorder;
    if (recorder !== null) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* already stopped */
      }
    }
    this.chunks = [];
    this.release();
  }

  /**
   * Release the captured hardware: stop EVERY MediaStream track (this is what
   * turns the OS/browser mic-active indicator off) and clear all capture state.
   * Safe to call repeatedly. Called from stop() and cancel(), and on any error
   * path, so the mic is never left live.
   */
  private release(): void {
    const stream = this.stream;
    if (stream !== null) {
      try {
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        /* best-effort: a track may already be ended */
      }
    }
    this.stream = null;
    this.recorder = null;
    this.recording = false;
  }
}

export const mic: MicCapability = new WebMic();
