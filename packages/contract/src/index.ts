import { z } from "zod";

/**
 * The shared wire contract — the single source of truth for the protocol
 * between the realtime core and both client planes. Both apps import this;
 * never hand-define a message shape in an app. See docs/ARCHITECTURE.md.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Six-digit circle join code, e.g. "402913". */
export const sixDigitCode = z
  .string()
  .regex(/^\d{6}$/, "must be a 6-digit code");

// ---------------------------------------------------------------------------
// Core entities
// ---------------------------------------------------------------------------

export const circleSchema = z.object({
  id: z.string().uuid(),
  code: sixDigitCode,
  name: z.string().min(1).max(80).nullable(),
  createdAt: z.string().datetime(),
});
export type Circle = z.infer<typeof circleSchema>;

/**
 * A connected player's live viewport (CSS px) — the size/shape of its canvas.
 * Reported by the player and carried on presence so the GM Stage can render each
 * tile at the device's real aspect ratio (and relative size). Transient: it's a
 * connection attribute, never persisted, and absent for a disconnected player.
 */
export const viewportSchema = z.object({
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
});
export type Viewport = z.infer<typeof viewportSchema>;

export const playerSchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  /** Player-chosen name, pinned per campaign (see DECISIONS D9). */
  name: z.string().min(1).max(40),
  connected: z.boolean(),
  joinedAt: z.string().datetime(),
  /** Live viewport (CSS px) of a connected player; omitted when not reported. */
  viewport: viewportSchema.optional(),
});
export type Player = z.infer<typeof playerSchema>;

// ---------------------------------------------------------------------------
// Circle lifecycle (GM)
// ---------------------------------------------------------------------------

export const createCircleRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
});
export type CreateCircleRequest = z.infer<typeof createCircleRequestSchema>;

export const createCircleResultSchema = z.object({ circle: circleSchema });
export type CreateCircleResult = z.infer<typeof createCircleResultSchema>;

export const openCircleRequestSchema = z.object({ code: sixDigitCode });
export type OpenCircleRequest = z.infer<typeof openCircleRequestSchema>;

export const openCircleResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    circle: circleSchema,
    players: z.array(playerSchema),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type OpenCircleResult = z.infer<typeof openCircleResultSchema>;

// ---------------------------------------------------------------------------
// Join flow (player)
// ---------------------------------------------------------------------------

export const joinRequestSchema = z.object({
  code: sixDigitCode,
  name: z.string().min(1).max(40),
  /** Stable per-device id so a returning player is recognized (pinned identity). */
  deviceId: z.string().min(1).max(200),
});
export type JoinRequest = z.infer<typeof joinRequestSchema>;

export const joinResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), circle: circleSchema, player: playerSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type JoinResult = z.infer<typeof joinResultSchema>;

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

export const presenceUpdateSchema = z.object({
  circleId: z.string().uuid(),
  players: z.array(playerSchema),
});
export type PresenceUpdate = z.infer<typeof presenceUpdateSchema>;

// ---------------------------------------------------------------------------
// Player management (GM) — rename or remove a player from the circle.
// ---------------------------------------------------------------------------

export const renamePlayerRequestSchema = z.object({
  playerId: z.string().uuid(),
  name: z.string().min(1).max(40),
});
export type RenamePlayerRequest = z.infer<typeof renamePlayerRequestSchema>;

export const renamePlayerResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), player: playerSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type RenamePlayerResult = z.infer<typeof renamePlayerResultSchema>;

export const removePlayerRequestSchema = z.object({
  playerId: z.string().uuid(),
});
export type RemovePlayerRequest = z.infer<typeof removePlayerRequestSchema>;

export const removePlayerResultSchema = z.object({ ok: z.boolean() });
export type RemovePlayerResult = z.infer<typeof removePlayerResultSchema>;

// ===========================================================================
// The effect engine — actor → router → target (see docs/ARCHITECTURE.md).
//
// Shape of the system:
//   • A *spec* is what the GM asks for (an EffectSpec + a Target [+ a delay]).
//   • The server *router* stamps each spec into a *delivered effect* (adds an
//     id + createdAt, resolves TTS to inline audio) and routes it to the
//     resolved player set.
//   • A *cue* is a choreographed bundle: one target, several specs, each with
//     its own startDelayMs, so a moment lands across the device set in time.
// Every effect ships a cheap (DOM/CSS + bundled media) renderer first (D7).
// ===========================================================================

// ---------------------------------------------------------------------------
// Targets — who an effect reaches.
// ---------------------------------------------------------------------------

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("broadcast") }),
  z.object({ kind: z.literal("players"), playerIds: z.array(z.string().uuid()) }),
]);
export type Target = z.infer<typeof targetSchema>;

// ---------------------------------------------------------------------------
// Effect vocabulary — the named, bounded sets the engine speaks in. Keeping
// these as small enums (not free-form strings) keeps the wire safe and the
// player's renderers a closed set. Every audioCue has a bundled asset.
// ---------------------------------------------------------------------------

/**
 * Bundled sound-effect cues → apps/player/public/audio/<cue>.mp3 (M2 set).
 * `whispers` is special: a looping bed chained + crossfaded from the
 * dissonant_whispers_*.mp3 clips (the player handles it, see audio.ts).
 */
export const audioCue = z.enum(["thunder", "chime", "heartbeat", "rain", "whispers"]);
export type AudioCue = z.infer<typeof audioCue>;

/** Named haptic patterns; the player maps each to a concrete vibration array. */
export const hapticPattern = z.enum([
  "buzz",
  "double",
  "rumble",
  "heartbeat",
  "success",
]);
export type HapticPattern = z.infer<typeof hapticPattern>;

/**
 * Persistent background scenes — an ambiance effect stays until changed, and
 * only one is active per target (starting a new one replaces the old). storm and
 * rain are mutually-exclusive weather (both own the rain bed; they never layer).
 */
export const ambianceScene = z.enum(["clear", "storm", "ember", "rain"]);
export type AmbianceScene = z.infer<typeof ambianceScene>;

/**
 * Approximate playout length of each one-shot cue, so the GM's active-effects
 * panel can show a countdown until a transient effect auto-closes. `rain` loops,
 * so it has no fixed duration (0 = sustained).
 */
export const AUDIO_CUE_DURATION_MS: Record<AudioCue, number> = {
  thunder: 5000,
  chime: 4000,
  heartbeat: 4000,
  rain: 0,
  whispers: 0, // a sustained, looping bed
};

/** How a message behaves on the player's screen (see docs/DESIGN.md). */
export const messageMode = z.enum(["acknowledge", "auto_dismiss", "silent"]);
export type MessageMode = z.infer<typeof messageMode>;

/** ms a client waits after receipt before playing an effect (choreography). */
const startDelayMs = z.number().int().nonnegative().max(60_000).optional();

// ---------------------------------------------------------------------------
// Effect specs — what the GM asks for (pre-routing; no id/createdAt yet).
// ---------------------------------------------------------------------------

export const messageSpecSchema = z.object({
  kind: z.literal("message"),
  body: z.string().min(1).max(1000),
  mode: messageMode,
  /** auto_dismiss only: how long the parchment lingers before it refolds. */
  autoDismissMs: z.number().int().positive().max(120_000).optional(),
});
export type MessageSpec = z.infer<typeof messageSpecSchema>;

/** Audio source as the GM specifies it: a bundled cue, or text to synthesize. */
export const audioSourceSpecSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("cue"), cue: audioCue }),
  z.object({
    via: z.literal("tts"),
    text: z.string().min(1).max(600),
    /** Optional ElevenLabs voice id; the server picks a default otherwise. */
    voice: z.string().max(80).optional(),
  }),
]);
export type AudioSourceSpec = z.infer<typeof audioSourceSpecSchema>;

/**
 * Spooky voice treatment for a spoken (TTS) effect. `whispers` wraps it in the
 * dissonant-whispers bed (fades in 2s before, out 2s after the speech); `echo`
 * adds a feedback echo; `pan` slowly sweeps it L↔R. `whisperGain` sets the bed
 * level independently of the voice (`gain`). The player applies these.
 */
const voiceFxFields = {
  whispers: z.boolean().optional(),
  echo: z.boolean().optional(),
  distortion: z.boolean().optional(),
  pan: z.boolean().optional(),
  whisperGain: z.number().min(0).max(1).optional(),
};

export const audioSpecSchema = z.object({
  kind: z.literal("audio"),
  source: audioSourceSpecSchema,
  /** 0..1 playback gain (default 1) — the voice level for a spoken effect. */
  gain: z.number().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  label: z.string().max(80).optional(),
  ...voiceFxFields,
});
export type AudioSpec = z.infer<typeof audioSpecSchema>;

export const hapticSpecSchema = z.object({
  kind: z.literal("haptic"),
  pattern: hapticPattern,
});
export type HapticSpec = z.infer<typeof hapticSpecSchema>;

export const ambianceSpecSchema = z.object({
  kind: z.literal("ambiance"),
  scene: ambianceScene,
  intensity: z.number().min(0).max(1).optional(),
  /** Fade-in/out ms for the scene's audio bed (GM-controllable; default ~5000). */
  fadeMs: z.number().int().min(0).max(30_000).optional(),
});
export type AmbianceSpec = z.infer<typeof ambianceSpecSchema>;

export const heartbeatSpecSchema = z.object({
  kind: z.literal("heartbeat"),
  /** beats per minute (default ~60). */
  bpm: z.number().int().min(30).max(200).optional(),
  /** how many beats to play (default ~8). */
  beats: z.number().int().min(1).max(64).optional(),
});
export type HeartbeatSpec = z.infer<typeof heartbeatSpecSchema>;

/** A brief full-screen light flash (e.g. a storm strike). Transient. */
export const flashSpecSchema = z.object({
  kind: z.literal("flash"),
  intensity: z.number().min(0).max(1).optional(),
});
export type FlashSpec = z.infer<typeof flashSpecSchema>;

export const effectSpecSchema = z.discriminatedUnion("kind", [
  messageSpecSchema,
  audioSpecSchema,
  hapticSpecSchema,
  ambianceSpecSchema,
  heartbeatSpecSchema,
  flashSpecSchema,
]);
export type EffectSpec = z.infer<typeof effectSpecSchema>;

// ---------------------------------------------------------------------------
// Delivered effects — what a player receives (server-stamped id + createdAt;
// every variant may carry a startDelayMs for choreography). The "message"
// variant is byte-for-byte the M1 shape (plus the optional delay) so the M1
// parchment renderer is unchanged.
// ---------------------------------------------------------------------------

export const messageEffectSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("message"),
  body: z.string(),
  mode: messageMode,
  autoDismissMs: z.number().int().positive().optional(),
  startDelayMs,
  createdAt: z.string().datetime(),
});
export type MessageEffect = z.infer<typeof messageEffectSchema>;

/** Resolved audio source on the wire: a bundled cue or an inline data: URL. */
export const audioSourceSchema = z.discriminatedUnion("via", [
  z.object({ via: z.literal("cue"), cue: audioCue }),
  z.object({ via: z.literal("data"), data: z.string() }),
]);
export type AudioSource = z.infer<typeof audioSourceSchema>;

export const audioEffectSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("audio"),
  source: audioSourceSchema,
  gain: z.number().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  label: z.string().max(80).optional(),
  ...voiceFxFields,
  startDelayMs,
  createdAt: z.string().datetime(),
});
export type AudioEffect = z.infer<typeof audioEffectSchema>;

export const hapticEffectSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("haptic"),
  pattern: hapticPattern,
  startDelayMs,
  createdAt: z.string().datetime(),
});
export type HapticEffect = z.infer<typeof hapticEffectSchema>;

export const ambianceEffectSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("ambiance"),
  scene: ambianceScene,
  intensity: z.number().min(0).max(1).optional(),
  fadeMs: z.number().int().min(0).max(30_000).optional(),
  startDelayMs,
  createdAt: z.string().datetime(),
});
export type AmbianceEffect = z.infer<typeof ambianceEffectSchema>;

export const heartbeatEffectSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("heartbeat"),
  bpm: z.number().int().min(30).max(200),
  beats: z.number().int().min(1).max(64),
  startDelayMs,
  createdAt: z.string().datetime(),
});
export type HeartbeatEffect = z.infer<typeof heartbeatEffectSchema>;

export const flashEffectSchema = z.object({
  id: z.string().uuid(),
  kind: z.literal("flash"),
  intensity: z.number().min(0).max(1).optional(),
  durationMs: z.number().int().positive().max(5000).optional(),
  startDelayMs,
  createdAt: z.string().datetime(),
});
export type FlashEffect = z.infer<typeof flashEffectSchema>;

/** Union of effect instances delivered to players. */
export const deliveredEffectSchema = z.discriminatedUnion("kind", [
  messageEffectSchema,
  audioEffectSchema,
  hapticEffectSchema,
  ambianceEffectSchema,
  heartbeatEffectSchema,
  flashEffectSchema,
]);
export type DeliveredEffect = z.infer<typeof deliveredEffectSchema>;

// ---------------------------------------------------------------------------
// Send requests + results (GM → server).
// ---------------------------------------------------------------------------

/** Fire a single effect at a target. */
export const sendEffectRequestSchema = z.object({
  target: targetSchema,
  spec: effectSpecSchema,
  startDelayMs: z.number().int().nonnegative().max(60_000).optional(),
});
export type SendEffectRequest = z.infer<typeof sendEffectRequestSchema>;

/** One step of a choreographed cue: a spec plus its own offset. */
export const cueStepSchema = z.object({
  spec: effectSpecSchema,
  startDelayMs: z.number().int().nonnegative().max(60_000).optional(),
});
export type CueStep = z.infer<typeof cueStepSchema>;

/** Fire a choreographed bundle at one target. */
export const sendCueRequestSchema = z.object({
  target: targetSchema,
  steps: z.array(cueStepSchema).min(1).max(16),
});
export type SendCueRequest = z.infer<typeof sendCueRequestSchema>;

export const sendEffectResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    effectId: z.string().uuid(),
    deliveredTo: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SendEffectResult = z.infer<typeof sendEffectResultSchema>;

export const sendCueResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    effectIds: z.array(z.string().uuid()),
    deliveredTo: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SendCueResult = z.infer<typeof sendCueResultSchema>;

// ---------------------------------------------------------------------------
// Active effects — the GM's live registry of what is running (and for whom).
// A sustained effect (a loop, an ambiance scene, a storm) runs until the GM
// stops it; a transient effect (a one-shot cue, a heartbeat) auto-closes after
// `durationMs`. The record `id` IS the delivered effect id, so effect:stop /
// effect:end reuse the id the player already holds. (M2 control rework.)
// ---------------------------------------------------------------------------

export const activeEffectSchema = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  /** Human label for the GM panel, e.g. "Rain", "Storm", "Thunderclap". */
  label: z.string(),
  target: targetSchema,
  /** true = runs until stopped; false = transient, closes after durationMs. */
  sustained: z.boolean(),
  startedAt: z.string().datetime(),
  /** Transient effects only: ms from startedAt until it auto-closes. */
  durationMs: z.number().int().nonnegative().optional(),
  /** ambiance only: the running scene, so the GM Stage can paint each tile's
   *  background from the authoritative registry (and seed it on reconnect). */
  scene: ambianceScene.optional(),
});
export type ActiveEffect = z.infer<typeof activeEffectSchema>;

export const activeEffectsSchema = z.object({
  circleId: z.string().uuid(),
  effects: z.array(activeEffectSchema),
});
export type ActiveEffects = z.infer<typeof activeEffectsSchema>;

export const stopEffectResultSchema = z.object({ ok: z.boolean() });
export type StopEffectResult = z.infer<typeof stopEffectResultSchema>;

// ---------------------------------------------------------------------------
// Mixer — the GM's live master effects volume (0..1), applied to every sound on
// the player's output bus. Ephemeral: the GM sets it, present players apply it.
// ---------------------------------------------------------------------------

export const mixerSetSchema = z.object({ gain: z.number().min(0).max(1) });
export type MixerSet = z.infer<typeof mixerSetSchema>;

// ---------------------------------------------------------------------------
// Whisperscape — a sustained whisper ambience: the dissonant bed PLUS a library
// of phrases that randomly fire as real (TTS) speech to a random player, like
// thunderclaps in a storm. The fired phrases carry echo + distortion only (the
// bed is already the ambience, so they don't re-add it). Server-orchestrated
// (mirrors the storm); stop it via effect:stop on the returned id.
// ---------------------------------------------------------------------------

export const whisperscapeRequestSchema = z.object({
  target: targetSchema,
  /** The phrase library; one is chosen at random per fire. */
  phrases: z.array(z.string().min(1).max(300)).min(1).max(50),
  /** 0..1 level of the dissonant bed (default 0.5). */
  bedGain: z.number().min(0).max(1).optional(),
  /** 0..1 level of the spoken phrases (default 0.9). */
  voiceGain: z.number().min(0).max(1).optional(),
  /** Random gap between phrases (ms); defaults ~8s–20s. */
  minGapMs: z.number().int().min(2000).max(180_000).optional(),
  maxGapMs: z.number().int().min(2000).max(180_000).optional(),
  /** Optional ElevenLabs voice id for the phrases. */
  voice: z.string().max(80).optional(),
});
export type WhisperscapeRequest = z.infer<typeof whisperscapeRequestSchema>;

// ---------------------------------------------------------------------------
// Effect mirror — a read-only copy of each delivered effect, fanned to the GM
// so the GM's live Stage can render what every player is seeing (incl. the
// server-driven storm strikes that never enter the registry). `playerIds` is
// who actually received it. Purely informational: the GM never plays the audio
// or vibrates — it paints a silent visual mirror.
// ---------------------------------------------------------------------------

export const effectMirrorSchema = z.object({
  playerIds: z.array(z.string().uuid()),
  effect: deliveredEffectSchema,
});
export type EffectMirror = z.infer<typeof effectMirrorSchema>;

// ---------------------------------------------------------------------------
// Socket.IO event maps (typed on both ends)
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  "presence:update": (update: PresenceUpdate) => void;
  "server:error": (message: string) => void;
  /** Server pushes a concrete effect to a player. */
  "effect:deliver": (effect: DeliveredEffect) => void;
  /** Server tells a player to stop/clear a specific active effect (loop/ambiance). */
  "effect:end": (info: { effectId: string }) => void;
  /** Server notifies the GM that a player acknowledged an effect. */
  "effect:acked": (info: { effectId: string; playerId: string }) => void;
  /** Server pushes the circle's live active-effects registry to the GM(s). */
  "effects:active": (active: ActiveEffects) => void;
  /** Server mirrors a delivered effect to the GM(s) for the live Stage view. */
  "effect:mirror": (info: EffectMirror) => void;
  /** Server tells a player it was removed from the circle by the GM. */
  "circle:ejected": (info: { reason?: string }) => void;
  /** Server applies the GM's master effects volume to a player. */
  "mixer:apply": (info: MixerSet) => void;
}

export interface ClientToServerEvents {
  /** Player joins a circle by code. */
  "circle:join": (req: JoinRequest, ack: (result: JoinResult) => void) => void;
  /** GM creates a new circle. */
  "circle:create": (
    req: CreateCircleRequest,
    ack: (result: CreateCircleResult) => void,
  ) => void;
  /** GM opens/subscribes to an existing circle by code. */
  "circle:open": (
    req: OpenCircleRequest,
    ack: (result: OpenCircleResult) => void,
  ) => void;
  /** GM fires a single effect at a target. */
  "effect:send": (
    req: SendEffectRequest,
    ack: (result: SendEffectResult) => void,
  ) => void;
  /** GM fires a choreographed bundle of effects at a target. */
  "effect:cue": (
    req: SendCueRequest,
    ack: (result: SendCueResult) => void,
  ) => void;
  /** Player acknowledges an effect (acknowledge mode). */
  "effect:ack": (info: { effectId: string }) => void;
  /** Player reports its live viewport (CSS px) so the GM Stage shows true shape. */
  "player:viewport": (info: Viewport) => void;
  /** GM renames a player. */
  "player:rename": (
    req: RenamePlayerRequest,
    ack: (result: RenamePlayerResult) => void,
  ) => void;
  /** GM removes a player from the circle (ejects + deletes). */
  "player:remove": (
    req: RemovePlayerRequest,
    ack: (result: RemovePlayerResult) => void,
  ) => void;
  /** GM sets the master effects volume for the circle's players. */
  "mixer:set": (req: MixerSet) => void;
  /** GM starts a whisperscape (dissonant bed + random spoken phrases). */
  "whisperscape:start": (
    req: WhisperscapeRequest,
    ack: (result: SendEffectResult) => void,
  ) => void;
  /** GM stops a sustained effect (or cancels a transient one early). */
  "effect:stop": (
    req: { effectId: string },
    ack: (result: StopEffectResult) => void,
  ) => void;
}

export const DEFAULT_SERVER_PORT = 3001;
