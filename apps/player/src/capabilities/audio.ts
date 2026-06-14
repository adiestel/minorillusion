/**
 * AudioCapability — the sound seam (DECISIONS.md D8).
 *
 * The cheap path: bundled .mp3 cues + inline data: URLs. Playback goes through
 * the **Web Audio API** — once the AudioContext is resumed inside a user gesture
 * (`unlock()`), decoded buffers play on demand with NO further autoplay gating,
 * loop **gaplessly** (sample-accurate), and **fade** via a per-source GainNode.
 * (An HTMLAudioElement version played only with DevTools open — autoplay-gated —
 * and looped with an audible gap; routing through the running context fixes both.)
 * Falls back to an HTMLAudioElement where AudioContext is unavailable.
 *
 * Looping beds (rain / storm) **fade in and out** (default 5s) so starting and
 * stopping is gentle and overlapping loops crossfade/blend; one-shots are instant.
 *
 * iOS gotcha: the context must be resumed from inside a user gesture. `unlock()`
 * does that and MUST be called from a tap handler (the consent button, or a
 * one-shot pointerdown on reconnect) — see Consent.tsx / main.tsx.
 */

import type { AudioCue } from "@minorillusion/contract";

/** Cues with N numbered variations on disk (<cue>1.mp3 … <cue>N.mp3). */
const CUE_VARIANTS: Partial<Record<AudioCue, number>> = { thunder: 5 };
/** Last variant played per cue, so we don't repeat the same one back-to-back. */
const lastVariant: Partial<Record<AudioCue, number>> = {};

/** Default fade for looping beds (ms); one-shots don't fade. */
const DEFAULT_LOOP_FADE_MS = 5000;

/** Resolve a cue id to its bundled asset, picking a random variation if it has them. */
function cueUrl(cue: AudioCue): string {
  const n = CUE_VARIANTS[cue];
  if (n === undefined || n <= 1) return `/audio/${cue}.mp3`;
  let v = 1 + Math.floor(Math.random() * n);
  if (v === lastVariant[cue]) v = (v % n) + 1; // avoid an immediate repeat
  lastVariant[cue] = v;
  return `/audio/${cue}${v}.mp3`;
}

/** Source as delivered on the wire: a bundled cue, or an inline data: URL. */
type PlaySource =
  | { via: "cue"; cue: AudioCue }
  | { via: "data"; data: string };

interface PlayOptions {
  /** 0..1 playback gain (default 1). */
  gain?: number;
  loop?: boolean;
  /** Fade-in ms (defaults to 5s for loops, 0 for one-shots). */
  fadeInMs?: number;
  /** Fade-out ms on stop (defaults to 5s for loops, 0 for one-shots). */
  fadeOutMs?: number;
}

/** Handle returned from play(); stop() halts that one sound (fading if a loop). */
export interface AudioHandle {
  stop: () => void;
}

interface AudioCapability {
  /** Prime audio from a user gesture so later programmatic playback is allowed. */
  unlock(): void;
  /** Play a cue / data source. Returns a handle whose stop() halts it. */
  play(source: PlaySource, opts?: PlayOptions): AudioHandle;
  /** Stop + clean up every currently-tracked sound (loops fade out). */
  stopAll(): void;
}

// ---------------------------------------------------------------------------
// Feature detection — capture the constructors once, tolerate their absence.
// ---------------------------------------------------------------------------

type AudioCtor = typeof AudioContext;

const AudioContextCtor: AudioCtor | undefined =
  typeof window !== "undefined"
    ? (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: AudioCtor })
          .webkitAudioContext)
    : undefined;

const hasAudioElement = typeof Audio !== "undefined";

const NOOP_HANDLE: AudioHandle = { stop: () => {} };

/** One live source + its gain (for fades) + how long to fade out on stop. */
interface ActiveSource {
  node: AudioBufferSourceNode;
  gain: GainNode;
  fadeOutMs: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class WebAudio implements AudioCapability {
  private ctx: AudioContext | null = null;
  /** Decoded cue buffers, kept for the app's life (a small bounded set). */
  private readonly cueBuffers = new Map<string, Promise<AudioBuffer>>();
  /** Live sources, so stopAll() can sweep them. */
  private readonly active = new Set<ActiveSource>();
  /** Live HTMLAudioElements when on the (no-WebAudio) fallback path. */
  private readonly activeEls = new Set<HTMLAudioElement>();

  private ensureCtx(): AudioContext | null {
    if (this.ctx === null && AudioContextCtor !== undefined) {
      try {
        this.ctx = new AudioContextCtor();
      } catch {
        this.ctx = null;
      }
    }
    return this.ctx;
  }

  unlock(): void {
    const ctx = this.ensureCtx();
    if (ctx !== null) {
      try {
        // Resume inside the gesture — this is what lets later buffers play.
        void ctx.resume();
        // A 1-sample silent blip so iOS marks the context user-activated.
        const buffer = ctx.createBuffer(1, 1, 22050);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        /* best-effort priming */
      }
      return;
    }
    // Fallback path (no AudioContext): prime an HTMLAudioElement.
    try {
      if (hasAudioElement) {
        const el = new Audio();
        el.muted = true;
        const p = el.play();
        if (p !== undefined) void p.then(() => el.pause()).catch(() => {});
      }
    } catch {
      /* best-effort priming */
    }
  }

  /** Fetch + decode an audio URL into a buffer. Cues are cached; data: URLs aren't. */
  private decode(url: string, cache: boolean): Promise<AudioBuffer> {
    const ctx = this.ctx;
    if (ctx === null) return Promise.reject(new Error("no AudioContext"));
    if (cache) {
      const hit = this.cueBuffers.get(url);
      if (hit !== undefined) return hit;
    }
    const pending = fetch(url)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx.decodeAudioData(ab));
    if (cache) this.cueBuffers.set(url, pending);
    return pending;
  }

  play(source: PlaySource, opts: PlayOptions = {}): AudioHandle {
    const ctx = this.ensureCtx();
    const url = source.via === "cue" ? cueUrl(source.cue) : source.data;

    // Fallback: no Web Audio → HTMLAudioElement (no fades; autoplay caveats apply).
    if (ctx === null) return this.playElement(url, opts);

    // The context was resumed on the unlock gesture; re-resume if the browser
    // suspended it while idle (harmless when already running).
    if (ctx.state === "suspended") void ctx.resume();

    const loop = opts.loop ?? false;
    const targetGain = opts.gain ?? 1;
    const fadeInMs = opts.fadeInMs ?? (loop ? DEFAULT_LOOP_FADE_MS : 0);
    const fadeOutMs = opts.fadeOutMs ?? (loop ? DEFAULT_LOOP_FADE_MS : 0);

    // play() is synchronous but decode is async — track stop intent across it.
    const state: { stopped: boolean; entry: ActiveSource | null } = {
      stopped: false,
      entry: null,
    };

    this.decode(url, source.via === "cue")
      .then((buf) => {
        if (state.stopped) return;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.loop = loop;
        const gain = ctx.createGain();
        const now = ctx.currentTime;
        if (fadeInMs > 0) {
          gain.gain.setValueAtTime(0, now);
          gain.gain.linearRampToValueAtTime(targetGain, now + fadeInMs / 1000);
        } else {
          gain.gain.setValueAtTime(targetGain, now);
        }
        node.connect(gain).connect(ctx.destination);
        const entry: ActiveSource = { node, gain, fadeOutMs };
        node.onended = () => {
          this.active.delete(entry);
          try {
            node.disconnect();
            gain.disconnect();
          } catch {
            /* already torn down */
          }
        };
        this.active.add(entry);
        state.entry = entry;
        node.start(0);
      })
      .catch(() => {
        /* fetch / decode failed — stay silent rather than throw */
      });

    return {
      stop: () => {
        state.stopped = true;
        if (state.entry !== null) this.fadeOutAndStop(state.entry);
      },
    };
  }

  /** Ramp a source's gain to 0 over its fadeOutMs, then stop it (or stop now). */
  private fadeOutAndStop(entry: ActiveSource): void {
    if (!this.active.delete(entry)) return; // already stopping/ended
    const { node, gain, fadeOutMs } = entry;
    const ctx = this.ctx;
    try {
      if (fadeOutMs > 0 && ctx !== null) {
        const now = ctx.currentTime;
        const cur = gain.gain.value;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(cur, now);
        gain.gain.linearRampToValueAtTime(0, now + fadeOutMs / 1000);
        node.onended = () => {
          try {
            node.disconnect();
            gain.disconnect();
          } catch {
            /* ignore */
          }
        };
        node.stop(now + fadeOutMs / 1000);
      } else {
        node.onended = null;
        node.stop();
        node.disconnect();
        gain.disconnect();
      }
    } catch {
      /* already stopped */
    }
  }

  /** HTMLAudioElement fallback (only when AudioContext is unavailable; no fades). */
  private playElement(url: string, opts: PlayOptions): AudioHandle {
    if (!hasAudioElement) return NOOP_HANDLE;
    let el: HTMLAudioElement;
    try {
      el = new Audio(url);
      el.loop = opts.loop ?? false;
      el.volume = opts.gain ?? 1;
    } catch {
      return NOOP_HANDLE;
    }
    this.activeEls.add(el);
    const cleanup = () => {
      this.activeEls.delete(el);
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* ignore */
      }
    };
    el.addEventListener("ended", cleanup, { once: true });
    const p = el.play();
    if (p !== undefined) void p.catch(cleanup);
    return { stop: cleanup };
  }

  stopAll(): void {
    for (const entry of [...this.active]) this.fadeOutAndStop(entry);
    for (const el of this.activeEls) {
      try {
        el.pause();
        el.removeAttribute("src");
        el.load();
      } catch {
        /* ignore */
      }
    }
    this.activeEls.clear();
  }
}

export const audio: AudioCapability = new WebAudio();
