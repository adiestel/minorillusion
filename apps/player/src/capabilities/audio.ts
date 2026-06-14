/**
 * AudioCapability — the sound seam (DECISIONS.md D8).
 *
 * The cheap path: bundled .mp3 cues + inline data: URLs. Playback goes through
 * the **Web Audio API** — once the AudioContext is resumed inside a user gesture
 * (`unlock()`), decoded buffers play on demand with NO further autoplay gating.
 * (An earlier HTMLAudioElement version played fine only with DevTools open, which
 * relaxes Chrome's autoplay policy — fresh `new Audio().play()` calls fired from
 * a socket event, outside the brief post-tap activation window, were silently
 * blocked. Routing through the running context fixes that.) Works identically
 * native (Capacitor serves the web layer) and as a PWA; falls back to an
 * HTMLAudioElement where AudioContext is unavailable, and no-ops where neither is.
 *
 * iOS gotcha: the context must be resumed from inside a user gesture. `unlock()`
 * does that and MUST be called from a tap handler (the consent button, or a
 * one-shot pointerdown on reconnect) — see Consent.tsx / main.tsx.
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

const NOOP_HANDLE: AudioHandle = { stop: () => {} };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

class WebAudio implements AudioCapability {
  private ctx: AudioContext | null = null;
  /** Decoded cue buffers, kept for the app's life (a tiny bounded set). */
  private readonly cueBuffers = new Map<string, Promise<AudioBuffer>>();
  /** Live source nodes, so stopAll() can sweep them. */
  private readonly active = new Set<AudioBufferSourceNode>();
  /** Live HTMLAudioElements when running on the (no-WebAudio) fallback path. */
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

    // Fallback: no Web Audio → HTMLAudioElement (autoplay-policy caveats apply).
    if (ctx === null) return this.playElement(url, opts);

    // The context was resumed on the unlock gesture; re-resume if the browser
    // suspended it while idle (harmless when already running).
    if (ctx.state === "suspended") void ctx.resume();

    // play() is synchronous but decode is async — track stop intent across it.
    const handleState: { stopped: boolean; node: AudioBufferSourceNode | null } = {
      stopped: false,
      node: null,
    };

    this.decode(url, source.via === "cue")
      .then((buf) => {
        if (handleState.stopped) return;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        node.loop = opts.loop ?? false;
        const gain = ctx.createGain();
        gain.gain.value = opts.gain ?? 1;
        node.connect(gain).connect(ctx.destination);
        node.onended = () => {
          this.active.delete(node);
          try {
            node.disconnect();
            gain.disconnect();
          } catch {
            /* already torn down */
          }
        };
        this.active.add(node);
        handleState.node = node;
        node.start(0);
      })
      .catch(() => {
        /* fetch / decode failed — stay silent rather than throw */
      });

    return {
      stop: () => {
        handleState.stopped = true;
        const node = handleState.node;
        if (node !== null) {
          this.active.delete(node);
          try {
            node.onended = null;
            node.stop();
            node.disconnect();
          } catch {
            /* already stopped */
          }
        }
      },
    };
  }

  /** HTMLAudioElement fallback (only when AudioContext is unavailable). */
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
    for (const node of this.active) {
      try {
        node.onended = null;
        node.stop();
        node.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.active.clear();
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
