import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { Server, type Socket } from "socket.io";
import {
  createCircleRequestSchema,
  joinRequestSchema,
  mixerSetSchema,
  openCircleRequestSchema,
  removePlayerRequestSchema,
  renamePlayerRequestSchema,
  sendCueRequestSchema,
  sendEffectRequestSchema,
  viewportSchema,
  whisperscapeRequestSchema,
  type ActiveEffect,
  type AmbianceScene,
  type ClientToServerEvents,
  type DeliveredEffect,
  type ServerToClientEvents,
  type Target,
  type Viewport,
  type WhisperProgress,
} from "@minorillusion/contract";
import { CircleService } from "./circles.js";
import {
  buildCue,
  buildEffect,
  classifyEffect,
  resolveTargets,
  type EffectClassification,
} from "./effects.js";
import { estimateClipMs, getTtsProvider } from "./tts.js";
import { makePhraseSequencer } from "./grabbag.js";

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
  /** A joined player's last-reported viewport (CSS px); drives the GM Stage. */
  viewport?: Viewport;
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
  /**
   * The exact effect to re-deliver when a target (re)joins, so a refresh resumes
   * the sound: a storm/rain ambiance, the whisper bed, a looping audio. Set for
   * sustained effects only — transient effects are momentary and don't resume.
   */
  delivered?: DeliveredEffect;
  /** Transient effects: fires remove() when the effect auto-closes. */
  expireTimer?: ReturnType<typeof setTimeout>;
  /** Storm records: cancels the self-rescheduling strike runner. */
  stopStorm?: () => void;
  /** Whisperscape records: cancels the phrase runner + ends the bed. */
  stopWhispers?: () => void;
  /** Whisperscape records: live phrase progress (which line is sounding, how
   *  many remain) — surfaced on the wire so the GM panel + Stage can show it. */
  whisper?: WhisperProgress;
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
    // Sustained effects resume on (re)join: keep the delivered effect to re-send.
    if (classified.sustained) record.delivered = effect;

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
   * Register a server-orchestrated sustained effect that has no single delivered
   * effect of its own (e.g. a whisperscape: a bed + a phrase runner). The caller
   * owns teardown via the record's stop hooks.
   */
  registerRaw(
    circleId: string,
    id: string,
    kind: string,
    label: string,
    target: Target,
    /** The bed effect to re-deliver on (re)join so the ambience resumes. */
    delivered?: DeliveredEffect,
  ): void {
    let circle = this.byCircle.get(circleId);
    if (!circle) {
      circle = new Map();
      this.byCircle.set(circleId, circle);
    }
    const record: ActiveEffectRecord = {
      id,
      kind,
      label,
      target,
      sustained: true,
      startedAt: new Date().toISOString(),
    };
    if (delivered) record.delivered = delivered;
    circle.set(id, record);
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
    record.stopWhispers?.();
    circle.delete(effectId);
    if (circle.size === 0) this.byCircle.delete(circleId);
    this.push(circleId);
  }

  /** Look up a single record (e.g. so the stop path can find its target). */
  get(circleId: string, effectId: string): ActiveEffectRecord | undefined {
    return this.byCircle.get(circleId)?.get(effectId);
  }

  /**
   * Update a whisperscape record's live phrase progress and re-push the registry
   * so the GM panel + Stage highlight the playing phrase. No-op for an unknown
   * id (the run may have just stopped).
   */
  setWhisperProgress(
    circleId: string,
    effectId: string,
    progress: WhisperProgress,
  ): void {
    const record = this.byCircle.get(circleId)?.get(effectId);
    if (!record) return;
    record.whisper = progress;
    this.push(circleId);
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
      if (r.whisper !== undefined) effect.whisper = r.whisper;
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
      r.stopWhispers?.();
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

  /**
   * Live viewport per connected player, from the socket bindings — the GM Stage
   * uses it to size each tile to the device's real shape. Only present for
   * players that have reported one this connection.
   */
  function playerViewports(circleId: string): Map<string, Viewport> {
    const map = new Map<string, Viewport>();
    for (const state of bindings.values()) {
      if (state.circleId === circleId && state.playerId && state.viewport) {
        map.set(state.playerId, state.viewport);
      }
    }
    return map;
  }

  /** Broadcast the current roster of a circle to everyone in its room. */
  async function broadcastPresence(circleId: string): Promise<void> {
    const players = await service.presence(circleId);
    const viewports = playerViewports(circleId);
    const enriched = players.map((p) => {
      const vp = viewports.get(p.id);
      return vp ? { ...p, viewport: vp } : p;
    });
    io.to(circleId).emit("presence:update", { circleId, players: enriched });
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
   * Re-deliver the circle's active sustained effects that target a given player —
   * called when a player (re)joins so a refresh resumes the storm rain, the
   * whisper bed, and any looping scene. The server-side strike/phrase runners
   * already fire to whoever is present, so only the beds/scenes need re-sending;
   * transient effects are momentary and aren't resumed. Re-delivering the same
   * effect id keeps a later effect:end matching on the resumed player.
   */
  function resumeSustainedFor(
    circleId: string,
    playerId: string,
    socket: AppSocket,
  ): void {
    for (const record of active.records(circleId)) {
      if (!record.sustained || !record.delivered) continue;
      // Resolve the target against just this player: present iff in-target.
      if (resolveTargets(record.target, [playerId]).includes(playerId)) {
        socket.emit("effect:deliver", record.delivered);
      }
    }
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

  /**
   * Run a whisperscape's phrase runner for an active record. A self-rescheduling
   * timer speaks one library phrase (real TTS, echo + distortion, NO bed — the
   * bed is already the ambience) to ONE random present player every minGap–maxGap
   * ms. Phrases play in grab-bag "random" or the GM's "sequential" order, and the
   * live "now playing / N left" progress is published on the record each fire so
   * the GM panel + Stage can highlight it. When loop is false the run tears itself
   * down (ending the bed) after the last phrase plays out. record.stopWhispers()
   * cancels the loop AND ends the bed (effect:stop / circle teardown call it). The
   * library is pre-warmed so cached synthesis doesn't delay the first fires.
   */
  function startWhisperscape(
    circleId: string,
    record: ActiveEffectRecord,
    opts: {
      phrases: string[];
      order: "random" | "sequential";
      loop: boolean;
      echo: boolean;
      distortion: boolean;
      pan: boolean;
      voiceGain: number;
      minGap: number;
      maxGap: number;
      voice?: string;
      bedId: string;
    },
  ): void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const { phrases, order, loop, echo, distortion, pan, voiceGain, minGap, maxGap, voice, bedId } =
      opts;

    // Phrase order: a no-repeat grab bag ("random") or the GM's order
    // ("sequential"), tracking the position within the pass for the live readout.
    const nextPhrase = makePhraseSequencer(phrases, order, loop);

    // Pre-warm the TTS cache so the first fires aren't delayed by synthesis.
    const tts = getTtsProvider();
    for (const phrase of phrases) void tts.synthesize(phrase, voice).catch(() => {});

    // Reverb tail so a clip rings out before the bed fades on a non-looping stop.
    const ECHO_TAIL_MS = 1500;

    const fire = async (): Promise<void> => {
      if (stopped) return;
      const step = nextPhrase();
      if (step === null) return; // empty library (guarded upstream)
      // Publish progress so the GM panel + Stage highlight the playing phrase.
      active.setWhisperProgress(circleId, record.id, {
        phrase: step.phrase,
        index: step.index,
        total: step.total,
        remaining: step.remaining,
        order,
        loop,
      });
      // How long the clip we deliver this fire will play (0 if none delivered).
      let clipMs = 0;
      try {
        const present = presentPlayerSockets(circleId);
        const recipientIds = resolveTargets(record.target, [...present.keys()]);
        const whisperPlayerId =
          recipientIds[Math.floor(Math.random() * recipientIds.length)];
        const sock =
          whisperPlayerId !== undefined ? present.get(whisperPlayerId) : undefined;
        if (sock && whisperPlayerId !== undefined) {
          // GM-configured FX, NO bed (the bed is already the ambience).
          const eff = await buildEffect({
            kind: "audio",
            source: { via: "tts", text: step.phrase, ...(voice ? { voice } : {}) },
            echo,
            distortion,
            pan,
            gain: voiceGain,
          });
          if (!stopped) {
            sock.emit("effect:deliver", eff);
            mirrorToGMs(circleId, [whisperPlayerId], eff);
            clipMs = estimateClipMs(
              step.phrase,
              eff.kind === "audio" && eff.source.via === "data" ? eff.source.data : undefined,
            );
          }
        }
      } catch (err) {
        app.log.error({ err }, "whisperscape phrase failed");
      }
      if (stopped) return;
      if (step.done) {
        // Non-looping run: let the final phrase ring out, then end the bed and
        // drop the record (active.remove runs stopWhispers + re-pushes).
        timer = setTimeout(() => {
          if (!stopped) active.remove(circleId, record.id);
        }, clipMs + ECHO_TAIL_MS);
        return;
      }
      // Schedule the NEXT whisper only after this one FINISHES, then the random
      // gap — so the gap starts at clip end and a long clip never overlaps the
      // next one (the bug: scheduling off the gap alone stacked long clips).
      const gap = minGap + Math.random() * (maxGap - minGap);
      timer = setTimeout(() => void fire(), clipMs + gap);
    };

    record.stopWhispers = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      // End the bed on the present in-target players.
      const present = presentPlayerSockets(circleId);
      const recipientIds = resolveTargets(record.target, [...present.keys()]);
      for (const playerId of recipientIds) {
        present.get(playerId)?.emit("effect:end", { effectId: bedId });
      }
    };

    // First phrase after a short, partial gap.
    timer = setTimeout(() => void fire(), minGap * 0.5 + Math.random() * minGap * 0.5);
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
        // A (re)joining player resumes any sustained ambiance/bed targeting them
        // (storm rain, whisper bed, looping audio) — a refresh restarts the sound.
        resumeSustainedFor(result.circle.id, result.player.id, socket);
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

    // -- player:viewport (player) -> record live viewport, refresh presence. --
    socket.on("player:viewport", (info) => {
      const parsed = viewportSchema.safeParse(info);
      if (!parsed.success) return; // ignore malformed reports
      const state = bindings.get(socket.id);
      if (!state?.playerId) return; // only a joined player reports a viewport
      state.viewport = parsed.data;
      // Re-broadcast so the GM Stage re-sizes this player's tile (player debounces).
      void broadcastPresence(state.circleId);
    });

    // -- mixer:set (GM) -> apply the master effects volume to present players. -
    socket.on("mixer:set", (req) => {
      const parsed = mixerSetSchema.safeParse(req);
      if (!parsed.success) return;
      const state = bindings.get(socket.id);
      if (!state || state.playerId !== undefined) return; // GM only
      for (const s of presentPlayerSockets(state.circleId).values()) {
        s.emit("mixer:apply", { gain: parsed.data.gain });
      }
    });

    // -- whisperscape:start (GM) -> dissonant bed + random spoken-phrase runner. -
    socket.on("whisperscape:start", async (req, ack) => {
      const parsed = whisperscapeRequestSchema.safeParse(req);
      if (!parsed.success) {
        ack({ ok: false, error: "Invalid whisperscape request." });
        return;
      }
      const state = bindings.get(socket.id);
      if (!state || state.playerId !== undefined) {
        ack({ ok: false, error: "Only a GM in a circle may start a whisperscape." });
        return;
      }

      const { target, phrases, order, loop, echo, distortion, pan } = parsed.data;
      const bedGain = parsed.data.bedGain ?? 0.5;
      const voiceGain = parsed.data.voiceGain ?? 0.9;
      const minGap = parsed.data.minGapMs ?? 8000;
      const maxGap = Math.max(minGap, parsed.data.maxGapMs ?? 20000);
      const voice = parsed.data.voice;

      try {
        // Deliver the dissonant bed (a whispers loop) to present in-target players.
        const present = presentPlayerSockets(state.circleId);
        const recipientIds = resolveTargets(target, [...present.keys()]);
        const bed = await buildEffect({
          kind: "audio",
          source: { via: "cue", cue: "whispers" },
          loop: true,
          gain: bedGain,
        });
        let deliveredTo = 0;
        for (const playerId of recipientIds) {
          present.get(playerId)?.emit("effect:deliver", bed);
          deliveredTo++;
        }

        // Register the sustained record (the GM Active panel shows "Whispers").
        // The bed rides along so a (re)joining player resumes the ambience.
        const recordId = randomUUID();
        active.registerRaw(state.circleId, recordId, "whisperscape", "Whispers", target, bed);
        const record = active.get(state.circleId, recordId);
        if (record) {
          startWhisperscape(state.circleId, record, {
            phrases,
            order,
            loop,
            echo,
            distortion,
            pan,
            voiceGain,
            minGap,
            maxGap,
            voice,
            bedId: bed.id,
          });
        }
        ack({ ok: true, effectId: recordId, deliveredTo });
      } catch (err) {
        app.log.error({ err }, "whisperscape:start failed");
        ack({
          ok: false,
          error: err instanceof Error ? err.message : "Failed to start whisperscape.",
        });
      }
    });

    // -- player:rename (GM) -> rename a player in this circle, refresh roster. --
    socket.on("player:rename", async (req, ack) => {
      const parsed = renamePlayerRequestSchema.safeParse(req);
      if (!parsed.success) {
        ack({ ok: false, error: "Invalid rename request." });
        return;
      }
      const state = bindings.get(socket.id);
      if (!state || state.playerId !== undefined) {
        ack({ ok: false, error: "Only a GM may rename players." });
        return;
      }
      try {
        const player = await service.renamePlayer(
          state.circleId,
          parsed.data.playerId,
          parsed.data.name,
        );
        if (!player) {
          ack({ ok: false, error: "Player not found." });
          return;
        }
        await broadcastPresence(state.circleId);
        ack({ ok: true, player });
      } catch (err) {
        app.log.error({ err }, "player:rename failed");
        ack({ ok: false, error: "Failed to rename player." });
      }
    });

    // -- player:remove (GM) -> eject + delete a player from this circle. -------
    socket.on("player:remove", async (req, ack) => {
      const parsed = removePlayerRequestSchema.safeParse(req);
      if (!parsed.success) {
        ack({ ok: false });
        return;
      }
      const state = bindings.get(socket.id);
      if (!state || state.playerId !== undefined) {
        ack({ ok: false });
        return;
      }
      try {
        const removed = await service.removePlayer(
          state.circleId,
          parsed.data.playerId,
        );
        if (!removed) {
          ack({ ok: false });
          return;
        }
        // If the player is currently connected, tell their client it was removed
        // (so it clears its session + returns to the join screen) and drop it.
        const present = presentPlayerSockets(state.circleId);
        const target = present.get(parsed.data.playerId);
        if (target) {
          target.emit("circle:ejected", { reason: "Removed by the GM." });
          target.disconnect(true);
        }
        await broadcastPresence(state.circleId);
        ack({ ok: true });
      } catch (err) {
        app.log.error({ err }, "player:remove failed");
        ack({ ok: false });
      }
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

      // A player: mark offline + broadcast the thinned roster — UNLESS the same
      // player already holds another live socket (a reconnect that re-joined
      // before this old socket's disconnect landed). Marking offline then would
      // wrongly flicker them out ("ghost offline") right after they returned.
      if (state?.playerId) {
        const reconnected = [...bindings.values()].some(
          (b) => b.playerId === state.playerId,
        );
        if (reconnected) return; // a newer socket holds this player — leave it.
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
