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
 * level independently of the voice (`gain`). `echoAmount` (0..1) scales the echo
 * intensity (feedback + wet level) — lower keeps the voice intelligible; the
 * player uses a moderate default when echo is on but no amount is given. The
 * player applies these.
 */
const voiceFxFields = {
  whispers: z.boolean().optional(),
  echo: z.boolean().optional(),
  echoAmount: z.number().min(0).max(1).optional(),
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

/**
 * Live progress of a whisperscape's spoken phrases — which line is sounding now,
 * where it sits in the current pass, and how many remain — so the GM's Active
 * panel and Stage can highlight the playing phrase and a "N left" countdown. The
 * server updates this on every fire and re-pushes effects:active.
 */
export const whisperProgressSchema = z.object({
  /** The phrase currently sounding (highlight this one). */
  phrase: z.string(),
  /** 0-based position of the current phrase within the current pass. */
  index: z.number().int().nonnegative(),
  /** Total phrases in the library. */
  total: z.number().int().positive(),
  /** Phrases left in the current pass after the current one. */
  remaining: z.number().int().nonnegative(),
  /** How phrases are chosen this run. */
  order: z.enum(["random", "sequential"]),
  /** Whether it repeats after a full pass (vs. stops once done). */
  loop: z.boolean(),
});
export type WhisperProgress = z.infer<typeof whisperProgressSchema>;

/**
 * A running whisperscape's live mix — whether the bed is on plus the two levels
 * — so the GM's Active panel can show sliders that adjust the bed/voice volume
 * in real time on the effect that's already playing.
 */
export const whisperMixSchema = z.object({
  bed: z.boolean(),
  bedGain: z.number().min(0).max(1),
  voiceGain: z.number().min(0).max(1),
  /** Whether the spoken phrases carry echo, and its 0..1 intensity — adjustable
   *  live (applies to the next phrase). When echo is off, the panel hides it. */
  echo: z.boolean(),
  echoAmount: z.number().min(0).max(1),
});
export type WhisperMix = z.infer<typeof whisperMixSchema>;

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
  /** whisperscape only: live phrase progress (which is playing, how many left)
   *  so the GM panel + Stage can highlight it as it sounds. */
  whisper: whisperProgressSchema.optional(),
  /** whisperscape only: the live mix, so the GM panel can show real-time
   *  bed/voice volume sliders for the running effect. */
  mix: whisperMixSchema.optional(),
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
// of phrases that surface as real (TTS) speech to a player, like thunderclaps in
// a storm. Phrases play either in a no-repeat grab-bag ("random") or in the
// GM's chosen order ("sequential"), and either loop forever or stop once the
// library is exhausted. The fired phrases carry echo + distortion only (the bed
// is already the ambience, so they don't re-add it). Server-orchestrated
// (mirrors the storm); stop it via effect:stop on the returned id.
// ---------------------------------------------------------------------------

/**
 * One whisper phrase: the line to speak, plus an optional voice id that pins it
 * to a specific voice. Omit `voice` to use the whisperscape's default voice (the
 * request's `voice`) — so a single queue can mix voices line by line.
 */
export const whisperPhraseSchema = z.object({
  text: z.string().min(1).max(300),
  voice: z.string().max(80).optional(),
});
export type WhisperPhrase = z.infer<typeof whisperPhraseSchema>;

export const whisperscapeRequestSchema = z.object({
  target: targetSchema,
  /** The phrase library, in the GM's order (used as-is when sequential). Each
   *  phrase may pin its own voice; without one it uses the default `voice`. */
  phrases: z.array(whisperPhraseSchema).min(1).max(50),
  /** How phrases are chosen: "random" (grab bag, no repeats) or "sequential". */
  order: z.enum(["random", "sequential"]).default("random"),
  /** Repeat after the whole library has played, or stop once done. */
  loop: z.boolean().default(true),
  /** Voice FX applied to the spoken phrases (the bed is the ambience already, so
   *  phrases never re-add it). Mirror the GM's Voice FX toggles. */
  echo: z.boolean().default(true),
  /** 0..1 echo intensity (feedback + wet); lower keeps the voice intelligible. */
  echoAmount: z.number().min(0).max(1).optional(),
  distortion: z.boolean().default(true),
  pan: z.boolean().default(true),
  /** Play the looping dissonant bed as the ambience. Off → only the spoken
   *  phrases fire, with no continuous bed (mirrors the GM's Whispers-bed toggle). */
  bed: z.boolean().default(true),
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

/**
 * Adjust a running whisperscape's mix in real time, by its active-effect id: the
 * bed level ramps on the players immediately; the voice level takes effect on the
 * following phrases. Either field may be omitted to leave it unchanged.
 */
export const whisperscapeMixSchema = z.object({
  effectId: z.string().uuid(),
  bedGain: z.number().min(0).max(1).optional(),
  voiceGain: z.number().min(0).max(1).optional(),
  /** 0..1 echo intensity for the spoken phrases — lands on the next phrase. */
  echoAmount: z.number().min(0).max(1).optional(),
});
export type WhisperscapeMix = z.infer<typeof whisperscapeMixSchema>;

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

// ===========================================================================
// The player voice/text plane (M3) — the inverse path: a player speaks back to
// the GM. A player taps the resting canvas and either writes (the quill → text)
// or holds-to-talk (the crystal ball → a recorded clip the server transcribes via
// STT). Both surface to the GM as a ChannelMessage; the GM replies with ANY
// effect (the existing effect router, targeted at the sender) to close the loop.
//
// DM-only for M3: every message goes to the GM (the recipient is implicit).
// Multi-contact + agent channels extend this later (a `to`/`channelId`), so the
// shape stays small now. INVIOLABLE (D10): the microphone is ALWAYS player-
// initiated — the server only ever receives an already-recorded clip; it never
// asks a device to capture. Voice clips are recorded + transcribed, disclosed at
// consent, and the player sees an active indicator while recording.
// ===========================================================================

/**
 * A player's message to the GM — typed (`text`, via the quill) or spoken
 * (`voice`, via the crystal ball PTT, transcribed by STT). For a voice message,
 * `text` is the transcript and `audio` optionally carries the recorded clip as a
 * data: URL so the GM can play back the real voice. Server-stamped id/createdAt.
 */
export const channelMessageSchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  /** Sender player id. */
  from: z.string().uuid(),
  /** Sender's display name at send time (so the GM inbox needs no roster join). */
  fromName: z.string().min(1).max(40),
  /** How it was composed: the quill (typed) or the crystal ball (spoken). */
  via: z.enum(["text", "voice"]),
  /** The body — typed text, or the STT transcript of a voice clip. */
  text: z.string().min(1).max(2000),
  /** voice only: the recorded clip as a data: URL, for GM playback. Optional. */
  audio: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type ChannelMessage = z.infer<typeof channelMessageSchema>;

/** Player → server: send typed text to the GM (the quill). */
export const sendTextRequestSchema = z.object({
  text: z.string().min(1).max(2000),
});
export type SendTextRequest = z.infer<typeof sendTextRequestSchema>;

/**
 * Player → server: send a recorded voice clip (the crystal-ball PTT). The server
 * decodes the data: URL, runs STT to a transcript, and surfaces it to the GM.
 * The clip is bounded (~2MB of base64) to stay within the socket buffer; PTT
 * clips are short. mimeType labels the upload for the STT provider.
 */
export const sendVoiceRequestSchema = z.object({
  /** The recorded audio as a data: URL (e.g. data:audio/webm;base64,...). */
  audio: z.string().min(1).max(3_000_000),
  /** The clip's MIME type (e.g. "audio/webm"); the recorder reports it. */
  mimeType: z.string().max(120).optional(),
  /** Clip length in ms (from the recorder), informational. */
  durationMs: z.number().int().positive().max(120_000).optional(),
});
export type SendVoiceRequest = z.infer<typeof sendVoiceRequestSchema>;

/**
 * Result of a player message send: the stored ChannelMessage on success (the
 * voice transcript rides back in `message.text`), or an error (e.g. STT
 * unavailable when no key is configured).
 */
export const sendMessageResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), message: channelMessageSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SendMessageResult = z.infer<typeof sendMessageResultSchema>;

// ===========================================================================
// The D&D layer (M5) — characters, GM-called rolls, the initiative tracker.
//
// We are the SYSTEM OF RECORD for rolls + initiative (DECISIONS D6): there is no
// D&D Beyond write path and no official API, so we model only the *roll-relevant*
// modifiers internally, behind a sheet-provider adapter, with MANUAL ENTRY as the
// guaranteed path and DDB public-link import as a best-effort convenience. Rolls
// are resolved AUTHORITATIVELY on the server (one fair RNG, correct modifiers,
// advantage/disadvantage, crit/fumble); the player's 3D die (M4) merely
// VISUALIZES the server's result.
// ===========================================================================

/** The six ability scores. */
export const ability = z.enum(["str", "dex", "con", "int", "wis", "cha"]);
export type Ability = z.infer<typeof ability>;

/** The standard 18 skills. */
export const skill = z.enum([
  "acrobatics", "animal_handling", "arcana", "athletics", "deception",
  "history", "insight", "intimidation", "investigation", "medicine",
  "nature", "perception", "performance", "persuasion", "religion",
  "sleight_of_hand", "stealth", "survival",
]);
export type Skill = z.infer<typeof skill>;

/** Which ability governs each skill (drives "correct modifiers"). */
export const SKILL_ABILITY: Record<Skill, Ability> = {
  acrobatics: "dex", animal_handling: "wis", arcana: "int", athletics: "str",
  deception: "cha", history: "int", insight: "wis", intimidation: "cha",
  investigation: "int", medicine: "wis", nature: "int", perception: "wis",
  performance: "cha", persuasion: "cha", religion: "int",
  sleight_of_hand: "dex", stealth: "dex", survival: "wis",
};

/** Ability modifier from a score: floor((score − 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Standard proficiency bonus for a character level (1–4 → +2, 5–8 → +3, …). */
export function proficiencyForLevel(level: number): number {
  return 2 + Math.floor((Math.max(1, Math.min(20, level)) - 1) / 4);
}

/** The polyhedral dice we support. */
export const dieSides = z.union([
  z.literal(4), z.literal(6), z.literal(8), z.literal(10),
  z.literal(12), z.literal(20), z.literal(100),
]);
export type DieSides = z.infer<typeof dieSides>;

/** The six scores, as a map ability→score (3–30 to allow boosted statlines). */
export const abilityScoresSchema = z.object({
  str: z.number().int().min(1).max(30),
  dex: z.number().int().min(1).max(30),
  con: z.number().int().min(1).max(30),
  int: z.number().int().min(1).max(30),
  wis: z.number().int().min(1).max(30),
  cha: z.number().int().min(1).max(30),
});
export type AbilityScores = z.infer<typeof abilityScoresSchema>;

/**
 * A character sheet — only the roll-relevant modifiers (D6). Persisted per
 * circle. `source` records whether it was hand-entered or DDB-imported;
 * `proficiencyBonus` is optional (derive from level when absent).
 */
export const characterSchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  name: z.string().min(1).max(60),
  level: z.number().int().min(1).max(20),
  abilities: abilityScoresSchema,
  /** Override the level-derived proficiency bonus when set. */
  proficiencyBonus: z.number().int().min(0).max(10).optional(),
  /** Skills the character is proficient in. */
  skillProficiencies: z.array(skill).max(18),
  /** Abilities the character is proficient in saving throws for. */
  saveProficiencies: z.array(ability).max(6),
  maxHp: z.number().int().min(0).max(1000).optional(),
  ac: z.number().int().min(0).max(40).optional(),
  source: z.enum(["manual", "ddb"]).default("manual"),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Character = z.infer<typeof characterSchema>;

/** Create/update a character (id present = update). Server stamps timestamps. */
export const saveCharacterRequestSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  level: z.number().int().min(1).max(20),
  abilities: abilityScoresSchema,
  proficiencyBonus: z.number().int().min(0).max(10).optional(),
  skillProficiencies: z.array(skill).max(18).default([]),
  saveProficiencies: z.array(ability).max(6).default([]),
  maxHp: z.number().int().min(0).max(1000).optional(),
  ac: z.number().int().min(0).max(40).optional(),
});
export type SaveCharacterRequest = z.infer<typeof saveCharacterRequestSchema>;

export const saveCharacterResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), character: characterSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SaveCharacterResult = z.infer<typeof saveCharacterResultSchema>;

export const charactersListSchema = z.object({
  circleId: z.string().uuid(),
  characters: z.array(characterSchema),
});
export type CharactersList = z.infer<typeof charactersListSchema>;

/** Best-effort DDB import of a public character share link (D6: never depend on it). */
export const importCharacterRequestSchema = z.object({
  /** A D&D Beyond public character URL or its numeric id. */
  url: z.string().min(1).max(400),
});
export type ImportCharacterRequest = z.infer<typeof importCharacterRequestSchema>;

/** Whether a roll has advantage, disadvantage, or neither. */
export const rollMode = z.enum(["normal", "advantage", "disadvantage"]);
export type RollMode = z.infer<typeof rollMode>;

/**
 * What the GM is asking to roll. Derived kinds (check/save/skill) pull the
 * modifier from the named character's sheet; `raw` is an explicit NdS+mod (damage,
 * a flat d20, etc.).
 */
export const rollSpecSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check"), ability }),
  z.object({ kind: z.literal("save"), ability }),
  z.object({ kind: z.literal("skill"), skill }),
  z.object({
    kind: z.literal("raw"),
    count: z.number().int().min(1).max(20),
    sides: dieSides,
    modifier: z.number().int().min(-50).max(50),
  }),
]);
export type RollSpec = z.infer<typeof rollSpecSchema>;

/** GM → server: call a roll. The server resolves it authoritatively. */
export const rollRequestSchema = z.object({
  spec: rollSpecSchema,
  /** Derive modifiers from this character (required for check/save/skill). */
  characterId: z.string().uuid().optional(),
  mode: rollMode.default("normal"),
  /** Override the auto label, e.g. "Death Save". */
  label: z.string().max(80).optional(),
  /** Show the rolling die on this player's screen (the M4 dice viz). */
  targetPlayerId: z.string().uuid().optional(),
  /** Broadcast the result to all players (vs. GM-only / target-only). */
  public: z.boolean().default(false),
});
export type RollRequest = z.infer<typeof rollRequestSchema>;

/**
 * The resolved roll (server-authoritative). `dice` are the raw faces rolled (two
 * d20s for advantage/disadvantage; N dice for `raw`); `kept` is the chosen/summed
 * dice before the modifier; `total = kept + modifier`. crit/fumble flag a natural
 * 20/1 on a single-d20 check/save/skill.
 */
export const rollResultSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  characterName: z.string().optional(),
  sides: dieSides,
  dice: z.array(z.number().int()),
  kept: z.number().int(),
  modifier: z.number().int(),
  total: z.number().int(),
  mode: rollMode,
  crit: z.boolean(),
  fumble: z.boolean(),
  /** Which player's die should visualize this (if any). */
  targetPlayerId: z.string().uuid().optional(),
  createdAt: z.string().datetime(),
});
export type RollResult = z.infer<typeof rollResultSchema>;

// ---------------------------------------------------------------------------
// Initiative tracker — server-authoritative ordered combat order (D6: owned).
// ---------------------------------------------------------------------------

export const initiativeEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(60),
  initiative: z.number().int().min(-10).max(60),
  /** Optional links/fields for a fuller tracker. */
  characterId: z.string().uuid().optional(),
  hp: z.number().int().optional(),
  maxHp: z.number().int().optional(),
});
export type InitiativeEntry = z.infer<typeof initiativeEntrySchema>;

/** The live initiative order: entries sorted high→low, with a current-turn cursor. */
export const initiativeStateSchema = z.object({
  circleId: z.string().uuid(),
  round: z.number().int().min(0),
  /** Index of the entry whose turn it is (−1 when not started/empty). */
  turnIndex: z.number().int().min(-1),
  entries: z.array(initiativeEntrySchema),
});
export type InitiativeState = z.infer<typeof initiativeStateSchema>;

/** GM → server: replace the whole initiative order (add/edit/remove/reorder). */
export const setInitiativeRequestSchema = z.object({
  entries: z
    .array(
      z.object({
        id: z.string().uuid().optional(),
        name: z.string().min(1).max(60),
        initiative: z.number().int().min(-10).max(60),
        characterId: z.string().uuid().optional(),
        hp: z.number().int().optional(),
        maxHp: z.number().int().optional(),
      }),
    )
    .max(50),
});
export type SetInitiativeRequest = z.infer<typeof setInitiativeRequestSchema>;

// ===========================================================================
// The intelligence layer (M6) — room transcript, LLM summaries/log, agents.
//
// Room audio is captured on the GM LAPTOP (D2 — foreground, powered) and chunked
// to the server for STT (D11: Scribe is batch-friendly, so we segment into short
// clips). Claude (behind an adapter, D11) filters cross-talk, writes session
// summaries, and edits the log. **LLM agents are actors** (D3): a configured agent
// (knowledge + a TTS voice) is prompted and its reply is delivered as ANY effect
// through the existing router — no new delivery plumbing. INVIOLABLE (D10): room
// capture is GM-initiated, disclosed, and shows a visible recording indicator;
// the server never silently captures.
// ===========================================================================

/** One line of the running session transcript/log. */
export const transcriptEntrySchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  /** When the line was captured/added (ISO). */
  at: z.string().datetime(),
  text: z.string().max(4000),
  /** Optional speaker label (the GM may tag lines). */
  speaker: z.string().max(60).optional(),
  /** How the line entered the log. */
  source: z.enum(["capture", "manual", "agent"]),
});
export type TranscriptEntry = z.infer<typeof transcriptEntrySchema>;

export const transcriptStateSchema = z.object({
  circleId: z.string().uuid(),
  /** Whether room capture is currently recording (drives the indicator/disclosure). */
  recording: z.boolean(),
  entries: z.array(transcriptEntrySchema),
});
export type TranscriptState = z.infer<typeof transcriptStateSchema>;

/**
 * GM → server: a captured room-audio chunk to transcribe + append to the log.
 * The GM laptop records continuously and segments into short clips (~5–10s). The
 * data URL is bounded like the M3 voice clip.
 */
export const transcriptChunkRequestSchema = z.object({
  audio: z.string().min(1).max(3_000_000),
  mimeType: z.string().max(120).optional(),
});
export type TranscriptChunkRequest = z.infer<typeof transcriptChunkRequestSchema>;

/** GM → server: add a hand-typed log line (the guaranteed path when no STT key). */
export const addEntryRequestSchema = z.object({
  text: z.string().min(1).max(4000),
  speaker: z.string().max(60).optional(),
});
export type AddEntryRequest = z.infer<typeof addEntryRequestSchema>;

/** GM → server: edit or delete a log line (ad-hoc log editing). */
export const editEntryRequestSchema = z.object({
  entryId: z.string().uuid(),
  /** New text (edit); omit with delete=true to remove the line. */
  text: z.string().max(4000).optional(),
  delete: z.boolean().optional(),
});
export type EditEntryRequest = z.infer<typeof editEntryRequestSchema>;

/** A finished session summary (LLM-written). */
export const summarySchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  style: z.enum(["recap", "bullets", "dramatic"]),
  text: z.string(),
  createdAt: z.string().datetime(),
});
export type Summary = z.infer<typeof summarySchema>;

/**
 * GM → server: summarize the transcript (Claude filters cross-talk in-prompt).
 * `entryIds` optionally restricts the source lines (source selection); omitted →
 * the whole transcript.
 */
export const summarizeRequestSchema = z.object({
  style: z.enum(["recap", "bullets", "dramatic"]).default("recap"),
  entryIds: z.array(z.string().uuid()).max(2000).optional(),
});
export type SummarizeRequest = z.infer<typeof summarizeRequestSchema>;

export const summarizeResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), summary: summarySchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SummarizeResult = z.infer<typeof summarizeResultSchema>;

/**
 * An LLM agent — an actor (D3) with configured knowledge + a TTS voice. The GM
 * prompts it; the reply is delivered as an effect (spoken or parchment).
 */
export const agentSchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  name: z.string().min(1).max(60),
  /** A short persona/knowledge brief that grounds the agent's replies. */
  knowledge: z.string().max(4000),
  /** Optional ElevenLabs voice id for spoken replies. */
  voice: z.string().max(80).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Agent = z.infer<typeof agentSchema>;

export const saveAgentRequestSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(60),
  knowledge: z.string().max(4000),
  voice: z.string().max(80).optional(),
});
export type SaveAgentRequest = z.infer<typeof saveAgentRequestSchema>;

export const saveAgentResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), agent: agentSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type SaveAgentResult = z.infer<typeof saveAgentResultSchema>;

export const agentsListSchema = z.object({
  circleId: z.string().uuid(),
  agents: z.array(agentSchema),
});
export type AgentsList = z.infer<typeof agentsListSchema>;

/**
 * GM → server: prompt an agent. The server asks the LLM (grounded in the agent's
 * knowledge), then delivers the reply as an effect to the target — spoken (TTS in
 * the agent's voice) or a parchment message — and returns the reply text to the GM.
 */
export const promptAgentRequestSchema = z.object({
  agentId: z.string().uuid(),
  prompt: z.string().min(1).max(2000),
  deliverAs: z.enum(["voice", "message"]).default("voice"),
  target: targetSchema,
  /** Spooky-voice treatment for a spoken reply (mirrors the audio effect FX). */
  whispers: z.boolean().optional(),
  echo: z.boolean().optional(),
});
export type PromptAgentRequest = z.infer<typeof promptAgentRequestSchema>;

export const promptAgentResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    agentName: z.string(),
    reply: z.string(),
    deliveredTo: z.number().int().nonnegative(),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type PromptAgentResult = z.infer<typeof promptAgentResultSchema>;

// ===========================================================================
// Join ritual + ship (M7) — session-end summary delivery + player log history.
//
// Players own a persistent history of session logs/summaries (DECISIONS D9). At
// session end the GM delivers a chronicle (typically the M6 summary) to the
// players; the server persists one per recipient and notifies them, and a player
// can fetch their history. (QR/hearth join + onboarding are client conventions —
// the join URL carries `?code=NNNNNN` — and need no wire shape.)
// ===========================================================================

/** A chronicle the player keeps — a delivered session summary/log line. */
export const playerLogSchema = z.object({
  id: z.string().uuid(),
  circleId: z.string().uuid(),
  playerId: z.string().uuid(),
  title: z.string().max(120).optional(),
  text: z.string().max(20_000),
  createdAt: z.string().datetime(),
});
export type PlayerLog = z.infer<typeof playerLogSchema>;

/** GM → server: deliver a chronicle to the target's players (persist one each). */
export const deliverLogRequestSchema = z.object({
  title: z.string().max(120).optional(),
  text: z.string().min(1).max(20_000),
  target: targetSchema,
});
export type DeliverLogRequest = z.infer<typeof deliverLogRequestSchema>;

export const playerLogsSchema = z.object({
  playerId: z.string().uuid(),
  logs: z.array(playerLogSchema),
});
export type PlayerLogs = z.infer<typeof playerLogsSchema>;

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
  /** Server ramps the gain of a running sustained sound (e.g. a whisper bed). */
  "effect:gain": (info: { effectId: string; gain: number }) => void;
  /** Server delivers a player's channel message (text/voice) to the GM(s). */
  "channel:message": (message: ChannelMessage) => void;
  /** Server pushes the circle's character roster to the GM(s) (M5). */
  "characters:list": (list: CharactersList) => void;
  /** Server delivers a resolved roll: to the GM(s), the target player (its die
   *  visualizes it), and all players when the roll is public. */
  "roll:result": (result: RollResult) => void;
  /** Server pushes the live initiative order to the GM(s). */
  "initiative:update": (state: InitiativeState) => void;
  /** Server pushes the live room transcript/log to the GM(s) (M6). */
  "transcript:update": (state: TranscriptState) => void;
  /** Server pushes the circle's agent roster to the GM(s). */
  "agents:list": (list: AgentsList) => void;
  /** Server tells players whether the room is being recorded (D10 disclosure). */
  "capture:state": (info: { recording: boolean }) => void;
  /** Server delivers a chronicle (session summary/log) to a player (M7). */
  "log:receive": (log: PlayerLog) => void;
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
  /** GM adjusts a running whisperscape's bed/voice mix in real time. */
  "whisperscape:mix": (req: WhisperscapeMix) => void;
  /** GM stops a sustained effect (or cancels a transient one early). */
  "effect:stop": (
    req: { effectId: string },
    ack: (result: StopEffectResult) => void,
  ) => void;
  /** Player sends typed text to the GM (the quill). */
  "channel:text": (
    req: SendTextRequest,
    ack: (result: SendMessageResult) => void,
  ) => void;
  /** Player sends a recorded voice clip; the server transcribes it (crystal ball PTT). */
  "channel:voice": (
    req: SendVoiceRequest,
    ack: (result: SendMessageResult) => void,
  ) => void;
  /** GM creates/updates a character sheet (id present = update). */
  "character:save": (
    req: SaveCharacterRequest,
    ack: (result: SaveCharacterResult) => void,
  ) => void;
  /** GM fetches the circle's characters. */
  "character:list": (ack: (list: CharactersList) => void) => void;
  /** GM deletes a character. */
  "character:delete": (
    req: { characterId: string },
    ack: (result: { ok: boolean }) => void,
  ) => void;
  /** GM imports a character from a D&D Beyond public link (best-effort, D6). */
  "character:import": (
    req: ImportCharacterRequest,
    ack: (result: SaveCharacterResult) => void,
  ) => void;
  /** GM calls a roll; the server resolves it authoritatively and returns it. */
  "roll:call": (
    req: RollRequest,
    ack: (
      result: { ok: true; result: RollResult } | { ok: false; error: string },
    ) => void,
  ) => void;
  /** GM replaces the initiative order (add/edit/remove/reorder). */
  "initiative:set": (
    req: SetInitiativeRequest,
    ack: (state: InitiativeState) => void,
  ) => void;
  /** GM advances to the next combatant's turn (wraps + bumps the round). */
  "initiative:advance": (ack: (state: InitiativeState) => void) => void;
  /** GM clears the initiative tracker. */
  "initiative:clear": (ack: (state: InitiativeState) => void) => void;
  /** GM toggles room recording (sets the indicator + discloses to players). */
  "capture:set": (req: { recording: boolean }) => void;
  /** GM sends a captured room-audio chunk; the server transcribes + appends it. */
  "transcript:chunk": (
    req: TranscriptChunkRequest,
    ack: (
      result: { ok: true; entry: TranscriptEntry | null } | { ok: false; error: string },
    ) => void,
  ) => void;
  /** GM adds a hand-typed log line. */
  "transcript:add": (
    req: AddEntryRequest,
    ack: (result: { ok: true; entry: TranscriptEntry }) => void,
  ) => void;
  /** GM edits or deletes a log line. */
  "transcript:edit": (
    req: EditEntryRequest,
    ack: (result: { ok: boolean }) => void,
  ) => void;
  /** GM fetches the current transcript/log. */
  "transcript:list": (ack: (state: TranscriptState) => void) => void;
  /** GM asks Claude for a session summary of (a selection of) the transcript. */
  "summarize": (
    req: SummarizeRequest,
    ack: (result: SummarizeResult) => void,
  ) => void;
  /** GM creates/updates an LLM agent (an actor with knowledge + a voice). */
  "agent:save": (
    req: SaveAgentRequest,
    ack: (result: SaveAgentResult) => void,
  ) => void;
  /** GM fetches the circle's agents. */
  "agent:list": (ack: (list: AgentsList) => void) => void;
  /** GM deletes an agent. */
  "agent:delete": (
    req: { agentId: string },
    ack: (result: { ok: boolean }) => void,
  ) => void;
  /** GM prompts an agent; the reply is delivered as an effect + returned to the GM. */
  "agent:prompt": (
    req: PromptAgentRequest,
    ack: (result: PromptAgentResult) => void,
  ) => void;
  /** GM delivers a chronicle (session summary/log) to the target's players (M7). */
  "log:deliver": (
    req: DeliverLogRequest,
    ack: (result: { ok: boolean; deliveredTo: number }) => void,
  ) => void;
  /** Player fetches its own persisted chronicle history. */
  "player:logs": (ack: (logs: PlayerLogs) => void) => void;
}

export const DEFAULT_SERVER_PORT = 3001;
