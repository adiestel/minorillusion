import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import {
  createCircleRequestSchema,
  joinRequestSchema,
  openCircleRequestSchema,
  sendCueRequestSchema,
  sendEffectRequestSchema,
  type ActiveEffect,
  type AmbianceScene,
  type ClientToServerEvents,
  type DeliveredEffect,
  type ServerToClientEvents,
  type Target,
} from "@minorillusion/contract";
import { CircleService } from "./circles.js";
import {
  buildCue,
  buildEffect,
  classifyEffect,
  resolveTargets,
  type EffectClassification,
} from "./effects.js";

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

/**
 * One row of the active-effects registry. The public fields mirror ActiveEffect
 * (what the GM panel renders); the trailing fields are server-internal handles
 * the registry uses to tear the effect down — an expiry timer for a transient
 * effect, and a storm runner's cancel for a running storm. They never go on the
 * wire (list() strips them).
 */
interface ActiveEffectRecord {
  id: string;
  kind: string;
  label: string;
  target: Target;
  sustained: boolean;
  startedAt: string;
  durationMs?: number;
  /** ambiance only: the running scene, surfaced so the GM Stage can paint it. */
  scene?: AmbianceScene;
  /** Transient effects: fires remove() when the effect auto-closes. */
  expireTimer?: ReturnType<typeof setTimeout>;
  /** Storm records: cancels the self-rescheduling strike runner. */
  stopStorm?: () => void;
}

/**
 * Per-circle registry of what is running, and for whom — the source of the GM's
 * live active-effects panel. Holds a record per effect id (the delivered effect
 * id, so effect:stop / effect:end reuse the id the player already has), owns the
 * teardown timers, and re-pushes effects:active to the circle's GM sockets on
 * every change. Stateful by design; the routing *decisions* stay pure in
 * classifyEffect (effects.ts).
 */
class ActiveEffectRegistry {
  private readonly byCircle = new Map<string, Map<string, ActiveEffectRecord>>();

  constructor(
    private readonly io: AppServer,
    /** The circle's GM sockets (bindings with that circleId and no playerId). */
    private readonly gmSockets: (circleId: string) => AppSocket[],
  ) {}

  /**
   * Record a freshly delivered effect. The record id IS the delivered effect id.
   * A transient effect (sustained=false with a durationMs) arms an expiry timer
   * that removes it when it auto-closes; a sustained one runs until stopped.
   */
  register(
    circleId: string,
    effect: DeliveredEffect,
    classified: EffectClassification,
    target: Target,
  ): void {
    let circle = this.byCircle.get(circleId);
    if (!circle) {
      circle = new Map();
      this.byCircle.set(circleId, circle);
    }

    const record: ActiveEffectRecord = {
      id: effect.id,
      kind: effect.kind,
      label: classified.label,
      target,
      sustained: classified.sustained,
      startedAt: new Date().toISOString(),
    };
    if (classified.durationMs !== undefined) record.durationMs = classified.durationMs;
    // ambiance carries its scene so the GM Stage can paint each tile.
    if (effect.kind === "ambiance") record.scene = effect.scene;

    // Transient: auto-close after its duration (sustained effects need a stop).
    if (!classified.sustained && classified.durationMs !== undefined) {
      record.expireTimer = setTimeout(() => {
        this.remove(circleId, effect.id);
      }, classified.durationMs);
    }

    circle.set(effect.id, record);
    this.push(circleId);
  }

  /**
   * Drop a record by id: clears its expiry timer + stops its storm runner, then
   * re-pushes the thinned registry. Safe to call for an unknown id (no-op).
   */
  remove(circleId: string, effectId: string): void {
    const circle = this.byCircle.get(circleId);
    const record = circle?.get(effectId);
    if (!circle || !record) return;
    if (record.expireTimer) clearTimeout(record.expireTimer);
    record.stopStorm?.();
    circle.delete(effectId);
    if (circle.size === 0) this.byCircle.delete(circleId);
    this.push(circleId);
  }

  /** Look up a single record (e.g. so the stop path can find its target). */
  get(circleId: string, effectId: string): ActiveEffectRecord | undefined {
    return this.byCircle.get(circleId)?.get(effectId);
  }

  /** Every record in a circle (the live snapshot), internal handles stripped. */
  list(circleId: string): ActiveEffect[] {
    const circle = this.byCircle.get(circleId);
    if (!circle) return [];
    const effects: ActiveEffect[] = [];
    for (const r of circle.values()) {
      const effect: ActiveEffect = {
        id: r.id,
        kind: r.kind,
        label: r.label,
        target: r.target,
        sustained: r.sustained,
        startedAt: r.startedAt,
      };
      if (r.durationMs !== undefined) effect.durationMs = r.durationMs;
      if (r.scene !== undefined) effect.scene = r.scene;
      effects.push(effect);
    }
    return effects;
  }

  /** Records of a circle (mutable view) — the socket layer scans these to find
   * an ambiance already running on an overlapping target. */
  records(circleId: string): ActiveEffectRecord[] {
    const circle = this.byCircle.get(circleId);
    return circle ? [...circle.values()] : [];
  }

  /** Tear a whole circle down (last socket left): clear every timer + runner. */
  clearCircle(circleId: string): void {
    const circle = this.byCircle.get(circleId);
    if (!circle) return;
    for (const r of circle.values()) {
      if (r.expireTimer) clearTimeout(r.expireTimer);
      r.stopStorm?.();
    }
    this.byCircle.delete(circleId);
  }

  /** Re-push effects:active to one GM socket (e.g. on circle:open / reconnect). */
  pushTo(socket: AppSocket, circleId: string): void {
    socket.emit("effects:active", { circleId, effects: this.list(circleId) });
  }

  /** Push the current registry of a circle to all of its GM sockets. */
  private push(circleId: string): void {
    const active = { circleId, effects: this.list(circleId) };
    for (const gm of this.gmSockets(circleId)) {
      gm.emit("effects:active", active);
    }
  }
}

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

  /** The GM sockets of a circle: bindings with that circleId and no playerId. */
  function gmSockets(circleId: string): AppSocket[] {
    const result: AppSocket[] = [];
    for (const [socketId, state] of bindings) {
      if (state.circleId !== circleId || state.playerId !== undefined) continue;
      const gmSocket = io.sockets.sockets.get(socketId);
      if (gmSocket) result.push(gmSocket);
    }
    return result;
  }

  /**
   * Mirror a delivered effect to the circle's GM sockets so the GM's live Stage
   * can render what the players are seeing (incl. server-driven storm strikes
   * that never enter the registry). `playerIds` is who actually received it. A
   * read-only copy — the GM paints a silent visual, never plays the sound.
   * Skipped when no one received the effect (nothing to mirror).
   */
  function mirrorToGMs(
    circleId: string,
    playerIds: string[],
    effect: DeliveredEffect,
  ): void {
    if (playerIds.length === 0) return;
    for (const gm of gmSockets(circleId)) {
      gm.emit("effect:mirror", { playerIds, effect });
    }
  }

  /** Does any socket (GM or player) remain bound to a circle? */
  function circleHasSockets(circleId: string): boolean {
    for (const state of bindings.values()) {
      if (state.circleId === circleId) return true;
    }
    return false;
  }

  // The circle's live "what's running" registry, used to drive the GM panel and
  // to stop sustained effects (loops, ambiance, storms) by id.
  const active = new ActiveEffectRegistry(io, gmSockets);

  /**
   * Do two targets overlap (share at least one possible recipient)? Used to keep
   * "one ambiance per target": a broadcast overlaps anything; two player sets
   * overlap iff they intersect. Conservative — a broadcast active ambiance is
   * replaced by any new ambiance, and vice versa.
   */
  function targetsOverlap(a: Target, b: Target): boolean {
    if (a.kind === "broadcast" || b.kind === "broadcast") return true;
    const set = new Set(a.playerIds);
    return b.playerIds.some((id) => set.has(id));
  }

  /**
   * The stop path for a sustained/transient record: clear its timers + storm
   * runner, tell the target's present players to end it (so a loop stops or an
   * ambiance clears on their screens), then drop it from the registry. The
   * delivered effect id is the registry id, so effect:end reuses it directly.
   */
  function stopRecord(circleId: string, effectId: string): void {
    const record = active.get(circleId, effectId);
    if (!record) return;
    const present = presentPlayerSockets(circleId);
    const recipientIds = resolveTargets(record.target, [...present.keys()]);
    for (const playerId of recipientIds) {
      present.get(playerId)?.emit("effect:end", { effectId });
    }
    active.remove(circleId, effectId); // clears timers/runner + pushes effects:active.
  }

  /**
   * Start a storm's strike runner for an active storm record. A self-
   * rescheduling timer: a first strike after 800–2000ms, then one every
   * 5000–12000ms. Each strike flashes everyone present in the storm's target,
   * and a thunderclap follows on ONE random present player (delayed a beat, so
   * the clap trails the flash — a distance feel). Strike effects are NOT
   * registered. The record's stopStorm() cancels the loop (effect:stop / circle
   * teardown call it); every emit is guarded so players leaving mid-storm is fine.
   */
  function startStorm(circleId: string, record: ActiveEffectRecord): void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const strike = async (): Promise<void> => {
      if (stopped) return;
      try {
        const present = presentPlayerSockets(circleId);
        const recipientIds = resolveTargets(record.target, [...present.keys()]);
        if (recipientIds.length > 0) {
          // Flash everyone in-target; the clap lands on one random player.
          const flash = await buildEffect(
            { kind: "flash", intensity: 0.85 },
            { durationMs: 320 },
          );
          if (stopped) return; // a stop may have raced the async mint.
          for (const playerId of recipientIds) {
            present.get(playerId)?.emit("effect:deliver", flash);
          }
          // Mirror the room-wide flash to the GM Stage (all in-target tiles flash).
          mirrorToGMs(circleId, recipientIds, flash);
          const clapPlayerId =
            recipientIds[Math.floor(Math.random() * recipientIds.length)];
          const clapSocket =
            clapPlayerId !== undefined ? present.get(clapPlayerId) : undefined;
          if (clapSocket && clapPlayerId !== undefined) {
            const clap = await buildEffect(
              { kind: "audio", source: { via: "cue", cue: "thunder" } },
              { startDelayMs: Math.round(150 + Math.random() * 950) },
            );
            if (!stopped) {
              clapSocket.emit("effect:deliver", clap);
              // Mirror the clap to the GM Stage (one tile shows the thunder pip).
              mirrorToGMs(circleId, [clapPlayerId], clap);
            }
          }
        }
      } catch (err) {
        app.log.error({ err }, "storm strike failed");
      }
      if (stopped) return;
      // Reschedule the next strike with a fresh random gap.
      timer = setTimeout(() => void strike(), 5000 + Math.random() * 7000);
    };

    record.stopStorm = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };

    // First strike lands soon after the storm rolls in.
    timer = setTimeout(() => void strike(), 800 + Math.random() * 1200);
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
        // A reconnecting GM should see what is already running in the circle.
        active.pushTo(socket, result.circle.id);
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
      const reached: string[] = [];
      for (const playerId of recipientIds) {
        const playerSocket = present.get(playerId);
        if (!playerSocket) continue;
        playerSocket.emit("effect:deliver", effect);
        reached.push(playerId);
        deliveredTo++;
      }
      // Mirror to the GM Stage (who saw what) before the registry bookkeeping.
      mirrorToGMs(state.circleId, reached, effect);

      // Reflect this effect in the GM's active-effects registry per its kind.
      const spec = parsed.data.spec;
      const c = classifyEffect(spec);
      const target = parsed.data.target;
      if (spec.kind === "ambiance" && spec.scene === "clear") {
        // A clear is a STOP: end any active ambiance/storm overlapping this
        // target (the clear was already delivered above so screens clear now).
        for (const r of active.records(state.circleId)) {
          if (r.kind === "ambiance" && targetsOverlap(r.target, target)) {
            stopRecord(state.circleId, r.id);
          }
        }
      } else if (c.register) {
        // One ambiance per target: a new sustained ambiance replaces any running
        // ambiance that overlaps the target before the new one is registered.
        if (spec.kind === "ambiance" && c.sustained) {
          for (const r of active.records(state.circleId)) {
            if (r.kind === "ambiance" && targetsOverlap(r.target, target)) {
              stopRecord(state.circleId, r.id);
            }
          }
        }
        active.register(state.circleId, effect, c, target);
        // A storm also drives its own strike runner, keyed to the new record.
        if (spec.kind === "ambiance" && spec.scene === "storm") {
          const record = active.get(state.circleId, effect.id);
          if (record) startStorm(state.circleId, record);
        }
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

      for (const [i, effect] of effects.entries()) {
        for (const playerSocket of recipients) {
          playerSocket.emit("effect:deliver", effect);
        }
        // Mirror each step to the GM Stage (every recipient got every step).
        mirrorToGMs(state.circleId, recipientIds, effect);
        // Each effect can be acknowledged independently; route every ack home.
        effectSenders.set(effect.id, socket.id);
        // Reflect each step in the registry per its kind (cue is rarely used now,
        // so we keep it simple: no ambiance-replacement / storm runner here).
        const step = parsed.data.steps[i];
        if (step) {
          const c = classifyEffect(step.spec);
          if (c.register) {
            active.register(state.circleId, effect, c, parsed.data.target);
          }
        }
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

    // -- effect:stop (GM) -> end a sustained effect (or cancel a transient). ---
    socket.on("effect:stop", (req, ack) => {
      // Only a GM (bound to a circle, no playerId) may stop an effect.
      const state = bindings.get(socket.id);
      if (!state || state.playerId !== undefined) {
        ack({ ok: false });
        return;
      }
      const record = active.get(state.circleId, req.effectId);
      if (!record) {
        ack({ ok: false });
        return;
      }
      // Clears timers + storm runner, tells the target's players to end it, and
      // drops it from the registry (which re-pushes effects:active to the GMs).
      stopRecord(state.circleId, req.effectId);
      ack({ ok: true });
    });

    // -- disconnect -> if a joined player, mark offline + broadcast. ----------
    socket.on("disconnect", async () => {
      const state = bindings.get(socket.id);
      bindings.delete(socket.id);

      // If that was the last socket in the circle, tear down its active-effects
      // registry so no expiry timer or storm runner leaks past an empty circle.
      if (state && !circleHasSockets(state.circleId)) {
        active.clearCircle(state.circleId);
      }

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
