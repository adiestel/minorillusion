import { randomUUID } from "node:crypto";
import {
  AUDIO_CUE_DURATION_MS,
  type AudioCue,
  type AudioSource,
  type CueStep,
  type DeliveredEffect,
  type EffectSpec,
  type Target,
} from "@minorillusion/contract";
import { bufferToDataUrl, getTtsProvider, type TtsProvider } from "./tts.js";

/**
 * The effect router — the pure core of the actor → router → target spine
 * (see docs/ARCHITECTURE.md). These functions take a GM's spec plus a snapshot
 * of who is present and decide *what* the effect is and *who* receives it. They
 * touch no sockets and no DB (TTS is injectable), so the routing logic is
 * unit-testable in isolation (see src/effects.test.ts); the socket layer wires
 * the plumbing.
 */

/** Knobs for minting one effect: a choreography offset and the TTS provider. */
export interface BuildOpts {
  startDelayMs?: number;
  /** flash only: how long the strike lights the screen (the renderer fades it). */
  durationMs?: number;
  /** Injected for tests / swap; defaults to the env-selected provider. */
  tts?: TtsProvider;
}

/**
 * Mint a concrete delivered-effect instance from a GM's spec. The id is a fresh
 * UUID and createdAt is stamped now (ISO-8601). startDelayMs is attached only
 * when supplied, and each per-kind optional (autoDismissMs, gain, loop, label,
 * intensity) is carried through only when present — so the emitted shape matches
 * the contract's optional fields exactly (never an explicit `undefined`).
 *
 * A "tts" audio source is resolved here: the text is synthesized to MP3 bytes
 * and inlined as a data: URL, so the wire only ever carries a resolved source
 * (a bundled cue or inline data) — the player never speaks to a TTS vendor.
 */
export async function buildEffect(
  spec: EffectSpec,
  opts?: BuildOpts,
): Promise<DeliveredEffect> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();

  switch (spec.kind) {
    case "message": {
      const effect: DeliveredEffect = {
        id,
        kind: "message",
        body: spec.body,
        mode: spec.mode,
        createdAt,
      };
      if (spec.autoDismissMs !== undefined) effect.autoDismissMs = spec.autoDismissMs;
      if (opts?.startDelayMs !== undefined) effect.startDelayMs = opts.startDelayMs;
      return effect;
    }

    case "audio": {
      // Resolve the source: a bundled cue passes through; tts synthesizes to an
      // inline data: URL via the injected (or env-selected) provider.
      let source: AudioSource;
      if (spec.source.via === "cue") {
        source = { via: "cue", cue: spec.source.cue };
      } else {
        const tts = opts?.tts ?? getTtsProvider();
        const buf = await tts.synthesize(spec.source.text, spec.source.voice);
        source = { via: "data", data: bufferToDataUrl(buf) };
      }
      const effect: DeliveredEffect = {
        id,
        kind: "audio",
        source,
        createdAt,
      };
      if (spec.gain !== undefined) effect.gain = spec.gain;
      if (spec.loop !== undefined) effect.loop = spec.loop;
      if (spec.label !== undefined) effect.label = spec.label;
      // Spooky-voice treatment carried through verbatim (player applies it).
      if (spec.whispers !== undefined) effect.whispers = spec.whispers;
      if (spec.echo !== undefined) effect.echo = spec.echo;
      if (spec.pan !== undefined) effect.pan = spec.pan;
      if (spec.whisperGain !== undefined) effect.whisperGain = spec.whisperGain;
      if (opts?.startDelayMs !== undefined) effect.startDelayMs = opts.startDelayMs;
      return effect;
    }

    case "haptic": {
      const effect: DeliveredEffect = {
        id,
        kind: "haptic",
        pattern: spec.pattern,
        createdAt,
      };
      if (opts?.startDelayMs !== undefined) effect.startDelayMs = opts.startDelayMs;
      return effect;
    }

    case "ambiance": {
      const effect: DeliveredEffect = {
        id,
        kind: "ambiance",
        scene: spec.scene,
        createdAt,
      };
      if (spec.intensity !== undefined) effect.intensity = spec.intensity;
      if (spec.fadeMs !== undefined) effect.fadeMs = spec.fadeMs;
      if (opts?.startDelayMs !== undefined) effect.startDelayMs = opts.startDelayMs;
      return effect;
    }

    case "heartbeat": {
      // Defaults live here so the wire shape is always fully specified (bpm/beats
      // are required on HeartbeatEffect even though optional on the spec).
      const effect: DeliveredEffect = {
        id,
        kind: "heartbeat",
        bpm: spec.bpm ?? 60,
        beats: spec.beats ?? 8,
        createdAt,
      };
      if (opts?.startDelayMs !== undefined) effect.startDelayMs = opts.startDelayMs;
      return effect;
    }

    case "flash": {
      // A brief screen flash (a storm strike). intensity rides the spec; the
      // strike length (durationMs) is a router knob, carried only when supplied.
      const effect: DeliveredEffect = {
        id,
        kind: "flash",
        createdAt,
      };
      if (spec.intensity !== undefined) effect.intensity = spec.intensity;
      if (opts?.durationMs !== undefined) effect.durationMs = opts.durationMs;
      if (opts?.startDelayMs !== undefined) effect.startDelayMs = opts.startDelayMs;
      return effect;
    }
  }
}

/**
 * Mint every step of a choreographed cue into delivered effects, preserving each
 * step's own startDelayMs so the moment lands across the device set in time. The
 * same TTS provider is threaded through every step.
 */
export async function buildCue(
  steps: CueStep[],
  opts?: { tts?: TtsProvider },
): Promise<DeliveredEffect[]> {
  return Promise.all(
    steps.map((step) =>
      buildEffect(step.spec, { startDelayMs: step.startDelayMs, tts: opts?.tts }),
    ),
  );
}

/**
 * Resolve a target spec against the players currently present into the concrete
 * set of recipient playerIds:
 *  - broadcast → every present player.
 *  - players   → the requested ids intersected with who is present (requested
 *    ids that are absent are silently dropped; order/uniqueness follows the
 *    present roster).
 */
export function resolveTargets(
  target: Target,
  presentPlayerIds: string[],
): string[] {
  if (target.kind === "broadcast") {
    return [...presentPlayerIds];
  }
  const requested = new Set(target.playerIds);
  return presentPlayerIds.filter((id) => requested.has(id));
}

/**
 * How a GM-initiated effect should appear in the circle's active-effects
 * registry (the GM's live panel). A pure decision — no sockets, no state — so
 * the socket layer can register/expire effects consistently and tests can
 * exercise the policy directly.
 *
 *  - register   → does this effect show in the panel at all?
 *  - sustained  → true = runs until the GM stops it; false = transient, closes
 *                 itself after durationMs.
 *  - durationMs → transient effects only: how long until it auto-closes.
 *  - label      → the human caption shown for the row.
 *
 * Note `ambiance` `clear` reports `register:false`: the socket layer treats a
 * clear as a STOP of the target's current ambiance, never a row of its own.
 */
export interface EffectClassification {
  register: boolean;
  sustained: boolean;
  durationMs?: number;
  label: string;
}

/** Capitalize a bundled cue into its panel label (thunder reads "Thunderclap"). */
function cueLabel(cue: AudioCue): string {
  if (cue === "thunder") return "Thunderclap";
  if (cue === "chime") return "Chime";
  return cue.charAt(0).toUpperCase() + cue.slice(1);
}

export function classifyEffect(spec: EffectSpec): EffectClassification {
  switch (spec.kind) {
    case "audio": {
      // A loop runs until stopped; a one-shot closes after its source length.
      if (spec.loop === true) {
        const label =
          spec.label ?? (spec.source.via === "cue" ? cueLabel(spec.source.cue) : "Speak");
        return { register: true, sustained: true, label };
      }
      if (spec.source.via === "cue") {
        return {
          register: true,
          sustained: false,
          durationMs: AUDIO_CUE_DURATION_MS[spec.source.cue],
          label: cueLabel(spec.source.cue),
        };
      }
      // tts: rough playout estimate (read speed), capped, so the panel can count
      // down. The whispers treatment adds the 2s lead-in + 2s tail-out.
      const speech = Math.min(20_000, 1500 + spec.source.text.length * 60);
      return {
        register: true,
        sustained: false,
        durationMs: speech + (spec.whispers ? 4000 : 0),
        label: spec.whispers ? "Whispered speech" : "Speak",
      };
    }

    case "ambiance": {
      // clear is a stop, not a row (the socket layer ends the running ambiance).
      if (spec.scene === "clear") {
        return { register: false, sustained: false, label: "Calm" };
      }
      // storm and rain are mutually-exclusive weather beds; one ambiance per
      // target means starting either replaces the other (no layered rain).
      if (spec.scene === "storm") {
        return { register: true, sustained: true, label: "Storm" };
      }
      if (spec.scene === "rain") {
        return { register: true, sustained: true, label: "Rain" };
      }
      // ember
      return { register: true, sustained: true, label: "Stir embers" };
    }

    case "heartbeat": {
      // beats / bpm → ms; mirrors buildEffect's 60 bpm / 8 beats defaults.
      const beats = spec.beats ?? 8;
      const bpm = spec.bpm ?? 60;
      return {
        register: true,
        sustained: false,
        durationMs: Math.round((beats / bpm) * 60_000),
        label: "Heartbeat",
      };
    }

    case "message":
      return { register: false, sustained: false, label: "Message" };

    case "haptic":
      // Haptics are near-instant, but we still surface a short (2s) panel row so
      // the GM gets a "that fired, to these players" confirmation — the buzz/
      // rumble itself can't be seen or heard from the console.
      return {
        register: true,
        sustained: false,
        durationMs: 2000,
        label: spec.pattern.charAt(0).toUpperCase() + spec.pattern.slice(1),
      };

    // A bare flash isn't shown: the storm fires them every few seconds and they'd
    // thrash the panel; the storm/Thunderclap rows already represent them.
    case "flash":
      return { register: false, sustained: false, label: "Flash" };
  }
}
