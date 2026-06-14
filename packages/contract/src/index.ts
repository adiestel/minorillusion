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

export const playerSchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  /** Player-chosen name, pinned per campaign (see DECISIONS D9). */
  name: z.string().min(1).max(40),
  connected: z.boolean(),
  joinedAt: z.string().datetime(),
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

/** Bundled sound-effect cues → apps/player/public/audio/<cue>.mp3 (M2 set). */
export const audioCue = z.enum(["thunder", "chime", "heartbeat", "rain"]);
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

/** Persistent background scenes — an ambiance effect stays until changed. */
export const ambianceScene = z.enum(["clear", "storm", "ember"]);
export type AmbianceScene = z.infer<typeof ambianceScene>;

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

export const audioSpecSchema = z.object({
  kind: z.literal("audio"),
  source: audioSourceSpecSchema,
  /** 0..1 playback gain (default 1). */
  gain: z.number().min(0).max(1).optional(),
  loop: z.boolean().optional(),
  label: z.string().max(80).optional(),
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

export const effectSpecSchema = z.discriminatedUnion("kind", [
  messageSpecSchema,
  audioSpecSchema,
  hapticSpecSchema,
  ambianceSpecSchema,
  heartbeatSpecSchema,
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

/** Union of effect instances delivered to players. */
export const deliveredEffectSchema = z.discriminatedUnion("kind", [
  messageEffectSchema,
  audioEffectSchema,
  hapticEffectSchema,
  ambianceEffectSchema,
  heartbeatEffectSchema,
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
// Socket.IO event maps (typed on both ends)
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  "presence:update": (update: PresenceUpdate) => void;
  "server:error": (message: string) => void;
  /** Server pushes a concrete effect to a player. */
  "effect:deliver": (effect: DeliveredEffect) => void;
  /** Server notifies the GM that a player acknowledged an effect. */
  "effect:acked": (info: { effectId: string; playerId: string }) => void;
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
}

export const DEFAULT_SERVER_PORT = 3001;
