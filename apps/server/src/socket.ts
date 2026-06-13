import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import {
  createCircleRequestSchema,
  joinRequestSchema,
  openCircleRequestSchema,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from "@minorillusion/contract";
import { CircleService } from "./circles.js";

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

  /** Broadcast the current roster of a circle to everyone in its room. */
  async function broadcastPresence(circleId: string): Promise<void> {
    const players = await service.presence(circleId);
    io.to(circleId).emit("presence:update", { circleId, players });
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

    // -- disconnect -> if a joined player, mark offline + broadcast. ----------
    socket.on("disconnect", async () => {
      const state = bindings.get(socket.id);
      bindings.delete(socket.id);
      if (!state?.playerId) return;
      try {
        await service.setConnected(state.playerId, false);
        await broadcastPresence(state.circleId);
      } catch (err) {
        app.log.error({ err }, "disconnect cleanup failed");
      }
    });
  });

  return io;
}
