import { randomUUID } from "node:crypto";
import type {
  AudioSource,
  CueStep,
  DeliveredEffect,
  EffectSpec,
  Target,
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
