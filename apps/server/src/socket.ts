import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import {
  createCircleRequestSchema,
  joinRequestSchema,
  openCircleRequestSchema,
  sendCueRequestSchema,
  sendEffectRequestSchema,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@minorillusion/contract";
import { CircleService } from "./circles.js";
import { buildCue, buildEffect, resolveTargets } from "./effects.js";

/**
 * Typed Socket.IO server for the M0 realtime core. Rooms map 1:1 to circle ids;
 * the GM and players in a circle share a room, and presence is broadcast to it.
 * Inbound payloads are validated with the contract's zod schemas before use.
 */

const DEV_ORIGINS = ["http://localhost:5173", "http://localhost:5174"];

/** Per-socket binding to a circle (and a player, once joined). */
interface SocketState {
  circleId: string;
  playerId?: string;
}

type AppServer = Server<ClientToServerEvents, ServerToClientEvents>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

export interface SocketServerDeps {
  service: CircleService;
}

export function createSocketServer(
  app: FastifyInstance,
  { service }: SocketServerDeps,
): AppServer {
  const io: AppServer = new Server(app.server, {
    cors: { origin: DEV_ORIGINS },
  });

  // socket.id -> binding. Removed on disconnect.
  const bindings = new Map<string, SocketState>();

  // effectId -> the GM socket.id that sent it, so a player's ack can be routed
  // back to the originating GM. Entries are cleaned up on GM disconnect.
  const effectSenders = new Map<string, string>();

  /** Broadcast the current roster of a circle to everyone in its room. */
  async function broadcastPresence(circleId: string): Promise<void> {
    const players = await service.presence(circleId);
    io.to(circleId).emit("presence:update", { circleId, players });
  }

  /**
   * The players (playerId -> socket) currently connected in a circle, derived
   * from the live socket bindings — this is the router's "present" snapshot.
   * A binding with a playerId is a player; one without is the GM.
   */
  function presentPlayerSockets(circleId: string): Map<string, AppSocket> {
    const result = new Map<string, AppSocket>();
    for (const [socketId, state] of bindings) {
      if (state.circleId !== circleId || state.playerId === undefined) continue;
      const playerSocket = io.sockets.sockets.get(socketId);
      if (playerSocket) result.set(state.playerId, playerSocket);
    }
    return result;
  }

  io.on("connection", (socket: AppSocket) => {
    // -- circle:create (GM) -> create circle, join its room, ack {circle}. ----
    socket.on("circle:create", async (req, ack) => {
      const parsed = createCircleRequestSchema.safeParse(req);
      if (!parsed.success) {
        socket.emit("server:error", "Invalid create-circle request.");
        return;
      }
      try {
        const circle = await service.createCircle(parsed.data.name);
        await socket.join(circle.id);
        bindings.set(socket.id, { circleId: circle.id });
        ack({ circle });
      } catch (err) {
        app.log.error({ err }, "circle:create failed");
        socket.emit("server:error", "Failed to create circle.");
      }
    });

    // -- circle:open (GM) -> look up by code, subscribe to room, ack roster. --
    socket.on("circle:open", async (req, ack) => {
      const parsed = openCircleRequestSchema.safeParse(req);
      if (!parsed.success) {
        ack({ ok: false, error: "Invalid circle code." });
        return;
      }
      try {
        const result = await service.openCircle(parsed.data.code);
        if (!result) {
          ack({ ok: false, error: "Circle not found." });
          return;
        }
        await socket.join(result.circle.id);
        bindings.set(socket.id, { circleId: result.circle.id });
        ack({ ok: true, circle: result.circle, players: result.players });
      } catch (err) {
        app.log.error({ err }, "circle:open failed");
        ack({ ok: false, error: "Failed to open circle." });
      }
    });

    // -- circle:join (player) -> upsert+connect, join room, ack, broadcast. ---
    socket.on("circle:join", async (req, ack) => {
      const parsed = joinRequestSchema.safeParse(req);
      if (!parsed.success) {
        ack({ ok: false, error: "Invalid join request." });
        return;
      }
      try {
        const result = await service.joinCircle(parsed.data);
        if (!result.ok) {
          ack(result);
          return;
        }
        await socket.join(result.circle.id);
        bindings.set(socket.id, {
          circleId: result.circle.id,
          playerId: result.player.id,
        });
        ack(result);
        await broadcastPresence(result.circle.id);
      } catch (err) {
        app.log.error({ err }, "circle:join failed");
        ack({ ok: false, error: "Failed to join circle." });
      }
    });

    // -- effect:send (GM) -> route one effect (any kind) to its target(s). ----
    socket.on("effect:send", async (req, ack) => {
      const parsed = sendEffectRequestSchema.safeParse(req);
      if (!parsed.success) {
        ack({ ok: false, error: "Invalid effect request." });
        return;
      }
      // Only a GM may send effects: bound to a circle, but not a player.
      const state = bindings.get(socket.id);
      if (!state || state.playerId !== undefined) {
        ack({ ok: false, error: "Only a GM in a circle may send effects." });
        return;
      }

      // Minting may synthesize TTS (network), so it can throw — surface it as a
      // failed ack rather than crashing the connection.
      let effect;
      try {
        effect = await buildEffect(parsed.data.spec, {
          startDelayMs: parsed.data.startDelayMs,
        });
      } catch (err) {
        ack({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to build effect.",
        });
        return;
      }

      const present = presentPlayerSockets(state.circleId);
      const recipientIds = resolveTargets(parsed.data.target, [
        ...present.keys(),
      ]);

      let deliveredTo = 0;
      for (const playerId of recipientIds) {
        const playerSocket = present.get(playerId);
        if (!playerSocket) continue;
        playerSocket.emit("effect:deliver", effect);
        deliveredTo++;
      }

      // Remember who sent this effect so a later ack can be routed home.
      effectSenders.set(effect.id, socket.id);
      ack({ ok: true, effectId: effect.id, deliveredTo });
    });

    // -- effect:cue (GM) -> route a choreographed bundle to one target set. ----
    socket.on("effect:cue", async (req, ack) => {
      const parsed = sendCueRequestSchema.safeParse(req);
      if (!parsed.success) {
        ack({ ok: false, error: "Invalid cue request." });
        return;
      }
      // Only a GM may send effects: bound to a circle, but not a player.
      const state = bindings.get(socket.id);
      if (!state || state.playerId !== undefined) {
        ack({ ok: false, error: "Only a GM in a circle may send effects." });
        return;
      }

      // Mint every step up front (any may synthesize TTS, so it can throw).
      let effects;
      try {
        effects = await buildCue(parsed.data.steps);
      } catch (err) {
        ack({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to build cue.",
        });
        return;
      }

      // Resolve the recipient set once, then fan every step out to each of them
      // so the whole cue lands on the same devices (each step keeps its delay).
      const present = presentPlayerSockets(state.circleId);
      const recipientIds = resolveTargets(parsed.data.target, [
        ...present.keys(),
      ]);
      const recipients = recipientIds
        .map((playerId) => present.get(playerId))
        .filter((s): s is AppSocket => s !== undefined);

      for (const effect of effects) {
        for (const playerSocket of recipients) {
          playerSocket.emit("effect:deliver", effect);
        }
        // Each effect can be acknowledged independently; route every ack home.
        effectSenders.set(effect.id, socket.id);
      }

      ack({
        ok: true,
        effectIds: effects.map((e) => e.id),
        deliveredTo: recipients.length,
      });
    });

    // -- effect:ack (player) -> notify the originating GM of the ack. ---------
    socket.on("effect:ack", (info) => {
      const senderSocketId = effectSenders.get(info.effectId);
      if (senderSocketId === undefined) return; // unknown/expired effect.
      const state = bindings.get(socket.id);
      if (!state?.playerId) return; // only a player can acknowledge.
      const gmSocket = io.sockets.sockets.get(senderSocketId);
      if (!gmSocket) return; // GM has gone away.
      gmSocket.emit("effect:acked", {
        effectId: info.effectId,
        playerId: state.playerId,
      });
    });

    // -- disconnect -> if a joined player, mark offline + broadcast. ----------
    socket.on("disconnect", async () => {
      const state = bindings.get(socket.id);
      bindings.delete(socket.id);

      // A player: mark offline + broadcast the thinned roster.
      if (state?.playerId) {
        try {
          await service.setConnected(state.playerId, false);
          await broadcastPresence(state.circleId);
        } catch (err) {
          app.log.error({ err }, "disconnect cleanup failed");
        }
        return;
      }

      // Otherwise a GM (or unbound socket): best-effort drop any effects this
      // socket sent so the ack-router map doesn't leak entries for a gone GM.
      for (const [effectId, senderId] of effectSenders) {
        if (senderId === socket.id) effectSenders.delete(effectId);
      }
    });
  });

  return io;
}
