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

/**
 * The dissonant-whispers bed: these clips are chained one at a time from a
 * random start, crossfading with overlap so there's no audible seam, looping
 * forever. (A special "whispers" cue — see playWhisperBed.)
 */
const WHISPER_URLS = [
  "/audio/dissonant_whispers_1.mp3",
  "/audio/dissonant_whispers_2.mp3",
  "/audio/dissonant_whispers_3.mp3",
  "/audio/dissonant_whispers_4.mp3",
];
/** Crossfade overlap between consecutive whisper clips (ms). */
const WHISPER_CROSSFADE_MS = 1800;

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

/** Knobs for the whispers bed. */
export interface WhisperBedOptions {
  /** 0..1 bed level (default 0.5). */
  gain?: number;
  /** Fade-in ms when the bed starts (default = the crossfade length). */
  fadeInMs?: number;
  /** Fade-out ms on stop (default = the crossfade length). */
  fadeOutMs?: number;
}

/** Knobs for a spoken (voice) effect with optional spooky treatment. */
export interface VoiceOptions {
  /** 0..1 voice level (default 1). */
  gain?: number;
  /** Add a feedback echo. */
  echo?: boolean;
  /** Slowly sweep the voice L↔R. */
  pan?: boolean;
  /** Called when the voice finishes (or fails to play). */
  onEnded?: () => void;
}

interface AudioCapability {
  /** Prime audio from a user gesture so later programmatic playback is allowed. */
  unlock(): void;
  /** Play a cue / data source. Returns a handle whose stop() halts it. */
  play(source: PlaySource, opts?: PlayOptions): AudioHandle;
  /** Stop + clean up every currently-tracked sound (loops fade out). */
  stopAll(): void;
  /** Play the dissonant-whispers bed (chained + crossfaded clips, looping).
   *  Returns a handle whose stop() fades it out. */
  playWhisperBed(opts?: WhisperBedOptions): AudioHandle;
  /** Play a spoken (data:) effect with optional echo + L↔R panning. */
  playVoice(dataUrl: string, opts?: VoiceOptions): AudioHandle;
  /** True when audio is blocked by a suspended context (a gesture is needed). */
  locked(): boolean;
  /** Subscribe to lock-state changes; fires immediately with the current state.
   *  Returns an unsubscribe. */
  onLockChange(cb: (locked: boolean) => void): () => void;
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
  /** Running whisper beds (each owns a scheduler), so stopAll() can sweep them. */
  private readonly beds = new Set<{ stop: () => void }>();
  /** Decoded whisper clips, loaded once. */
  private whisperBuffers: Promise<AudioBuffer[]> | null = null;

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
    // The whispers cue is a special chained/crossfaded bed, not a single file.
    if (source.via === "cue" && source.cue === "whispers") {
      return this.playWhisperBed({
        gain: opts.gain,
        fadeInMs: opts.fadeInMs,
        fadeOutMs: opts.fadeOutMs,
      });
    }

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
    for (const bed of [...this.beds]) bed.stop();
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

  /** Decode the whisper clips once (kept for the app's life). */
  private loadWhispers(): Promise<AudioBuffer[]> {
    if (this.whisperBuffers === null) {
      this.whisperBuffers = Promise.all(WHISPER_URLS.map((u) => this.decode(u, true)));
    }
    return this.whisperBuffers;
  }

  playWhisperBed(opts: WhisperBedOptions = {}): AudioHandle {
    const ctx = this.ensureCtx();
    if (ctx === null) return NOOP_HANDLE; // no Web Audio → skip the bed entirely
    if (ctx.state === "suspended") void ctx.resume();

    const xfade = WHISPER_CROSSFADE_MS / 1000; // seconds
    const bedGain = opts.gain ?? 0.5;
    const fadeInMs = opts.fadeInMs ?? WHISPER_CROSSFADE_MS;
    const fadeOutMs = opts.fadeOutMs ?? WHISPER_CROSSFADE_MS;

    // One master gain for the whole bed: its level + the fade in/out on stop.
    const master = ctx.createGain();
    const t0 = ctx.currentTime;
    master.gain.setValueAtTime(fadeInMs > 0 ? 0.0001 : bedGain, t0);
    if (fadeInMs > 0) master.gain.linearRampToValueAtTime(bedGain, t0 + fadeInMs / 1000);
    master.connect(ctx.destination);

    const live = { stopped: false, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const nodes = new Set<AudioBufferSourceNode>();
    let lastIndex = -1;

    // Schedule one clip starting at `startTime`, crossfading in/out, and queue
    // the next to begin one crossfade before this one ends (an overlap that
    // hides the seam). Self-reschedules via a look-ahead timer until stopped.
    const playClip = (buffers: AudioBuffer[], startTime: number): void => {
      if (live.stopped) return;
      let i = Math.floor(Math.random() * buffers.length);
      if (i === lastIndex && buffers.length > 1) i = (i + 1) % buffers.length;
      lastIndex = i;
      const buf = buffers[i];
      if (!buf) return;
      const dur = buf.duration;

      const node = ctx.createBufferSource();
      node.buffer = buf;
      const g = ctx.createGain();
      // Crossfade in, hold, crossfade out at the tail.
      g.gain.setValueAtTime(0.0001, startTime);
      g.gain.linearRampToValueAtTime(1, startTime + xfade);
      const fadeOutAt = Math.max(startTime + xfade, startTime + dur - xfade);
      g.gain.setValueAtTime(1, fadeOutAt);
      g.gain.linearRampToValueAtTime(0.0001, startTime + dur);
      node.connect(g).connect(master);
      node.start(startTime);
      node.stop(startTime + dur + 0.05);
      nodes.add(node);
      node.onended = () => {
        nodes.delete(node);
        try {
          node.disconnect();
          g.disconnect();
        } catch {
          /* already gone */
        }
      };

      // Next clip overlaps this one's tail by `xfade`.
      const nextStart = startTime + dur - xfade;
      const delayMs = Math.max(0, (nextStart - ctx.currentTime - 0.3) * 1000);
      live.timer = setTimeout(() => playClip(buffers, nextStart), delayMs);
    };

    this.loadWhispers()
      .then((buffers) => {
        if (live.stopped || buffers.length === 0) return;
        playClip(buffers, ctx.currentTime + 0.06);
      })
      .catch(() => {
        /* decode failed — stay silent */
      });

    const entry = {
      stop: () => {
        if (live.stopped) return;
        live.stopped = true;
        if (live.timer) clearTimeout(live.timer);
        const now = ctx.currentTime;
        try {
          master.gain.cancelScheduledValues(now);
          master.gain.setValueAtTime(master.gain.value, now);
          master.gain.linearRampToValueAtTime(0.0001, now + fadeOutMs / 1000);
        } catch {
          /* ignore */
        }
        // After the fade, tear everything down.
        setTimeout(() => {
          for (const n of nodes) {
            try {
              n.onended = null;
              n.stop();
              n.disconnect();
            } catch {
              /* already stopped */
            }
          }
          nodes.clear();
          try {
            master.disconnect();
          } catch {
            /* ignore */
          }
        }, fadeOutMs + 120);
        this.beds.delete(entry);
      },
    };
    this.beds.add(entry);
    return { stop: entry.stop };
  }

  playVoice(dataUrl: string, opts: VoiceOptions = {}): AudioHandle {
    const ctx = this.ensureCtx();
    // No Web Audio → plain element playback (no fx); still fire onEnded.
    if (ctx === null) {
      const h = this.playElement(dataUrl, { gain: opts.gain });
      if (opts.onEnded) window.setTimeout(opts.onEnded, 50);
      return h;
    }
    if (ctx.state === "suspended") void ctx.resume();

    const state = { stopped: false, cleanup: () => {} };

    this.decode(dataUrl, false)
      .then((buf) => {
        if (state.stopped) return;
        const node = ctx.createBufferSource();
        node.buffer = buf;
        const voice = ctx.createGain();
        voice.gain.value = opts.gain ?? 1;
        node.connect(voice);

        // Echo: a feedback delay mixed with the dry signal.
        let tail: AudioNode = voice;
        const extra: AudioNode[] = [voice];
        if (opts.echo) {
          const merge = ctx.createGain();
          voice.connect(merge); // dry
          const delay = ctx.createDelay(1.0);
          delay.delayTime.value = 0.28;
          const fb = ctx.createGain();
          fb.gain.value = 0.34;
          const wet = ctx.createGain();
          wet.gain.value = 0.55;
          voice.connect(delay);
          delay.connect(fb);
          fb.connect(delay); // feedback loop
          delay.connect(wet);
          wet.connect(merge);
          tail = merge;
          extra.push(merge, delay, fb, wet);
        }

        // Pan: an LFO slowly sweeps a StereoPanner between L and R.
        let lfo: OscillatorNode | null = null;
        if (opts.pan && typeof ctx.createStereoPanner === "function") {
          const panner = ctx.createStereoPanner();
          lfo = ctx.createOscillator();
          lfo.frequency.value = 0.18; // slow drift
          const depth = ctx.createGain();
          depth.gain.value = 0.7;
          lfo.connect(depth).connect(panner.pan);
          lfo.start();
          tail.connect(panner);
          panner.connect(ctx.destination);
          extra.push(panner, depth);
        } else {
          tail.connect(ctx.destination);
        }

        state.cleanup = () => {
          try {
            lfo?.stop();
            node.stop();
          } catch {
            /* already stopped */
          }
          try {
            node.disconnect();
            for (const n of extra) n.disconnect();
            lfo?.disconnect();
          } catch {
            /* ignore */
          }
        };

        node.onended = () => {
          state.cleanup();
          if (!state.stopped) opts.onEnded?.();
        };
        node.start();
      })
      .catch(() => {
        // Decode/fetch failed — still let the caller proceed (e.g. end the bed).
        if (!state.stopped) opts.onEnded?.();
      });

    return {
      stop: () => {
        if (state.stopped) return;
        state.stopped = true;
        state.cleanup();
      },
    };
  }

  /**
   * Is audio currently blocked? True only when a real AudioContext exists and is
   * suspended (autoplay policy / the browser idled it / returned from background)
   * — i.e. a user gesture is needed before sound will play. With no Web Audio
   * (the HTMLAudioElement fallback) we can't reliably detect this, so report
   * false rather than nag with a modal that can't be satisfied.
   */
  locked(): boolean {
    const ctx = this.ensureCtx();
    return ctx !== null && ctx.state === "suspended";
  }

  onLockChange(cb: (locked: boolean) => void): () => void {
    const ctx = this.ensureCtx();
    if (ctx === null) {
      cb(false);
      return () => {};
    }
    const handler = () => cb(ctx.state === "suspended");
    ctx.addEventListener("statechange", handler);
    handler(); // fire immediately with the current state
    return () => ctx.removeEventListener("statechange", handler);
  }
}

export const audio: AudioCapability = new WebAudio();
