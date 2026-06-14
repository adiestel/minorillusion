/**
 * AudioCapability — the sound seam (DECISIONS.md D8).
 *
 * A single web implementation, exported as the `audio` singleton. It is the
 * cheap path: bundled .mp3 cues + inline data: URLs played through
 * HTMLAudioElement, no WebAudio synthesis. Works identically native (Capacitor
 * serves the web layer) and as a PWA; every method no-ops safely where the
 * platform lacks AudioContext / Audio (SSR, locked-down embeds).
 *
 * iOS gotcha: programmatic playback is blocked until audio has been started
 * once from inside a user gesture. `unlock()` performs that priming and must be
 * called from a tap handler (the consent button, or a one-shot pointerdown on
 * reconnect) — see Consent.tsx / main.tsx.
 *
 * Loops (e.g. the storm rain bed) are owned by their renderer (AmbianceLayer),
 * which holds the returned handle and calls stop() on unmount; stopAll() is the
 * blunt "ambiance went clear" sweep.
 */

import type { AudioCue } from "@minorillusion/contract";

/** Resolve a cue id to its bundled asset. apps/player/public/audio/<cue>.mp3 */
function cueUrl(cue: AudioCue): string {
  return `/audio/${cue}.mp3`;
}

/** Source as delivered on the wire: a bundled cue, or an inline data: URL. */
type PlaySource =
  | { via: "cue"; cue: AudioCue }
  | { via: "data"; data: string };

interface PlayOptions {
  /** 0..1 playback gain (default 1). */
  gain?: number;
  loop?: boolean;
}

/** Handle returned from play(); stop() halts that one sound. */
export interface AudioHandle {
  stop: () => void;
}

interface AudioCapability {
  /** Prime audio from a user gesture so later programmatic playback is allowed. */
  unlock(): void;
  /** Play a cue / data source. Returns a handle whose stop() halts it. */
  play(source: PlaySource, opts?: PlayOptions): AudioHandle;
  /** Stop + clean up every currently-tracked sound. */
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

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const NOOP_HANDLE: AudioHandle = { stop: () => {} };

class WebAudio implements AudioCapability {
  private ctx: AudioContext | null = null;
  /** Every live element we've created, so stopAll() can sweep them. */
  private readonly active = new Set<HTMLAudioElement>();

  unlock(): void {
    // (1) AudioContext: create lazily, resume, and play one silent sample so
    // iOS marks the context as user-activated.
    try {
      if (this.ctx === null && AudioContextCtor !== undefined) {
        this.ctx = new AudioContextCtor();
      }
      if (this.ctx !== null) {
        void this.ctx.resume();
        const buffer = this.ctx.createBuffer(1, 1, 22050);
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(this.ctx.destination);
        src.start(0);
      }
    } catch {
      /* best-effort priming */
    }

    // (2) HTMLAudioElement: construct, play (muted), then immediately pause, so
    // the element-playback path is also unlocked for later cue playback on iOS.
    try {
      if (hasAudioElement) {
        const el = new Audio();
        el.muted = true;
        const p = el.play();
        if (p !== undefined) {
          void p.then(() => el.pause()).catch(() => {});
        } else {
          el.pause();
        }
      }
    } catch {
      /* best-effort priming */
    }
  }

  play(source: PlaySource, opts: PlayOptions = {}): AudioHandle {
    if (!hasAudioElement) return NOOP_HANDLE;

    let el: HTMLAudioElement;
    try {
      const url = source.via === "cue" ? cueUrl(source.cue) : source.data;
      el = new Audio(url);
      el.loop = opts.loop ?? false;
      el.volume = opts.gain ?? 1;
    } catch {
      return NOOP_HANDLE;
    }

    this.active.add(el);

    // Non-looping sounds untrack themselves when they finish.
    const onEnded = () => {
      this.active.delete(el);
      el.removeEventListener("ended", onEnded);
    };
    el.addEventListener("ended", onEnded);

    const playPromise = el.play();
    if (playPromise !== undefined) {
      void playPromise.catch(() => {
        // Autoplay blocked / decode error — drop it so it isn't a leaked entry.
        this.active.delete(el);
        el.removeEventListener("ended", onEnded);
      });
    }

    const stop = () => {
      el.removeEventListener("ended", onEnded);
      this.active.delete(el);
      try {
        el.pause();
        el.currentTime = 0;
        // Drop the source so the browser releases the buffer promptly.
        el.removeAttribute("src");
        el.load();
      } catch {
        /* element already torn down */
      }
    };

    return { stop };
  }

  stopAll(): void {
    for (const el of this.active) {
      try {
        el.pause();
        el.currentTime = 0;
        el.removeAttribute("src");
        el.load();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
  }
}

export const audio: AudioCapability = new WebAudio();
