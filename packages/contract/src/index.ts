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

// ---------------------------------------------------------------------------
// Effects / Targets — stubs, expanded in M1/M2 (actor -> router -> target)
// ---------------------------------------------------------------------------

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("broadcast") }),
  z.object({ kind: z.literal("players"), playerIds: z.array(z.string().uuid()) }),
]);
export type Target = z.infer<typeof targetSchema>;

export const effectSchema = z.object({
  id: z.string(),
  type: z.string(),
  target: targetSchema,
  payload: z.record(z.unknown()),
});
export type Effect = z.infer<typeof effectSchema>;

// ---------------------------------------------------------------------------
// Socket.IO event maps (typed on both ends)
// ---------------------------------------------------------------------------

export interface ServerToClientEvents {
  "presence:update": (update: PresenceUpdate) => void;
  "server:error": (message: string) => void;
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
}

export const DEFAULT_SERVER_PORT = 3001;
