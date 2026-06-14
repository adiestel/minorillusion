import { and, eq } from "drizzle-orm";
import type {
  Circle,
  JoinRequest,
  JoinResult,
  Player,
} from "@minorillusion/contract";
import { db as defaultDb, type Database } from "./db/client.js";
import {
  circles,
  players,
  type CircleRow,
  type PlayerRow,
} from "./db/schema.js";

/**
 * Repository/service over circles + players. All DB access sits behind the
 * `CirclesStore` interface so the service logic (code generation, upsert
 * orchestration, row → contract mapping) is unit-testable with a fake in-memory
 * store — no live Postgres required. See src/circles.test.ts.
 */

// ---------------------------------------------------------------------------
// Storage seam — the only surface that touches the DB.
// ---------------------------------------------------------------------------

export interface CirclesStore {
  /** Insert a circle with a pre-generated code. Throws on code collision. */
  insertCircle(input: { code: string; name: string | null }): Promise<CircleRow>;
  findCircleByCode(code: string): Promise<CircleRow | null>;
  findCircleById(id: string): Promise<CircleRow | null>;
  /** True if a circle already uses this code (collision check). */
  codeExists(code: string): Promise<boolean>;

  findPlayer(
    circleId: string,
    deviceId: string,
  ): Promise<PlayerRow | null>;
  insertPlayer(input: {
    circleId: string;
    name: string;
    deviceId: string;
    connected: boolean;
  }): Promise<PlayerRow>;
  /** Update an existing player's name + connected flag (returning device). */
  updatePlayer(
    id: string,
    input: { name: string; connected: boolean },
  ): Promise<PlayerRow>;
  setConnected(playerId: string, connected: boolean): Promise<void>;
  listPlayers(circleId: string): Promise<PlayerRow[]>;
  /** Rename a player scoped to its circle; null if no such player in it. */
  renamePlayer(input: {
    id: string;
    circleId: string;
    name: string;
  }): Promise<PlayerRow | null>;
  /** Delete a player scoped to its circle; true if a row was removed. */
  deletePlayer(input: { id: string; circleId: string }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Mapping: DB rows → contract shapes (dates as ISO strings).
// ---------------------------------------------------------------------------

export function toCircle(row: CircleRow): Circle {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toPlayer(row: PlayerRow): Player {
  return {
    id: row.id,
    circleId: row.circleId,
    name: row.name,
    connected: row.connected,
    joinedAt: row.joinedAt.toISOString(),
  };
}

export function toPlayers(rows: PlayerRow[]): Player[] {
  return rows.map(toPlayer);
}

// ---------------------------------------------------------------------------
// Code generation — six-digit, zero-padded, collision-retried.
// ---------------------------------------------------------------------------

/** Generate a random six-digit code (000000–999999), always zero-padded. */
export function generateCode(): string {
  return Math.floor(Math.random() * 1_000_000)
    .toString()
    .padStart(6, "0");
}

const CODE_COLLISION_RETRIES = 10;

/** Find a code not currently in use, retrying on collision. */
export async function uniqueCode(store: CirclesStore): Promise<string> {
  for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt++) {
    const code = generateCode();
    if (!(await store.codeExists(code))) return code;
  }
  throw new Error("could not allocate a unique circle code");
}

// ---------------------------------------------------------------------------
// Service — business logic over the store. Returns contract shapes.
// ---------------------------------------------------------------------------

export class CircleService {
  constructor(private readonly store: CirclesStore) {}

  async createCircle(name?: string): Promise<Circle> {
    const code = await uniqueCode(this.store);
    const row = await this.store.insertCircle({
      code,
      name: name ?? null,
    });
    return toCircle(row);
  }

  async openCircle(
    code: string,
  ): Promise<{ circle: Circle; players: Player[] } | null> {
    const circle = await this.store.findCircleByCode(code);
    if (!circle) return null;
    const playerRows = await this.store.listPlayers(circle.id);
    return { circle: toCircle(circle), players: toPlayers(playerRows) };
  }

  async joinCircle(
    req: JoinRequest,
  ): Promise<
    { ok: true; circle: Circle; player: Player } | { ok: false; error: string }
  > {
    const circle = await this.store.findCircleByCode(req.code);
    if (!circle) return { ok: false, error: "Circle not found." };

    // Upsert by (circle_id, device_id): a returning device re-maps to its one
    // pinned player (update name + reconnect); a new device creates one.
    const existing = await this.store.findPlayer(circle.id, req.deviceId);
    const playerRow = existing
      ? await this.store.updatePlayer(existing.id, {
          name: req.name,
          connected: true,
        })
      : await this.store.insertPlayer({
          circleId: circle.id,
          name: req.name,
          deviceId: req.deviceId,
          connected: true,
        });

    return { ok: true, circle: toCircle(circle), player: toPlayer(playerRow) };
  }

  async presence(circleId: string): Promise<Player[]> {
    return toPlayers(await this.store.listPlayers(circleId));
  }

  async setConnected(playerId: string, connected: boolean): Promise<void> {
    await this.store.setConnected(playerId, connected);
  }

  /** Rename a player (scoped to its circle). Returns the updated player, or
   *  null when no such player exists in that circle. */
  async renamePlayer(
    circleId: string,
    playerId: string,
    name: string,
  ): Promise<Player | null> {
    const row = await this.store.renamePlayer({ id: playerId, circleId, name });
    return row ? toPlayer(row) : null;
  }

  /** Remove a player from a circle. Returns true if a row was deleted. */
  async removePlayer(circleId: string, playerId: string): Promise<boolean> {
    return this.store.deletePlayer({ id: playerId, circleId });
  }
}

// JoinResult is the contract wire type; the service result is structurally
// assignable to it. Re-export the alias for handler clarity.
export type { JoinResult };

// ---------------------------------------------------------------------------
// Drizzle-backed store (the production implementation).
// ---------------------------------------------------------------------------

export class DrizzleCirclesStore implements CirclesStore {
  constructor(private readonly db: Database = defaultDb) {}

  async insertCircle(input: {
    code: string;
    name: string | null;
  }): Promise<CircleRow> {
    const [row] = await this.db.insert(circles).values(input).returning();
    if (!row) throw new Error("circle insert returned no row");
    return row;
  }

  async findCircleByCode(code: string): Promise<CircleRow | null> {
    const [row] = await this.db
      .select()
      .from(circles)
      .where(eq(circles.code, code))
      .limit(1);
    return row ?? null;
  }

  async findCircleById(id: string): Promise<CircleRow | null> {
    const [row] = await this.db
      .select()
      .from(circles)
      .where(eq(circles.id, id))
      .limit(1);
    return row ?? null;
  }

  async codeExists(code: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: circles.id })
      .from(circles)
      .where(eq(circles.code, code))
      .limit(1);
    return row !== undefined;
  }

  async findPlayer(
    circleId: string,
    deviceId: string,
  ): Promise<PlayerRow | null> {
    const [row] = await this.db
      .select()
      .from(players)
      .where(
        and(eq(players.circleId, circleId), eq(players.deviceId, deviceId)),
      )
      .limit(1);
    return row ?? null;
  }

  async insertPlayer(input: {
    circleId: string;
    name: string;
    deviceId: string;
    connected: boolean;
  }): Promise<PlayerRow> {
    const [row] = await this.db.insert(players).values(input).returning();
    if (!row) throw new Error("player insert returned no row");
    return row;
  }

  async updatePlayer(
    id: string,
    input: { name: string; connected: boolean },
  ): Promise<PlayerRow> {
    const [row] = await this.db
      .update(players)
      .set(input)
      .where(eq(players.id, id))
      .returning();
    if (!row) throw new Error("player update returned no row");
    return row;
  }

  async setConnected(playerId: string, connected: boolean): Promise<void> {
    await this.db
      .update(players)
      .set({ connected })
      .where(eq(players.id, playerId));
  }

  async listPlayers(circleId: string): Promise<PlayerRow[]> {
    return this.db
      .select()
      .from(players)
      .where(eq(players.circleId, circleId))
      .orderBy(players.joinedAt);
  }

  async renamePlayer(input: {
    id: string;
    circleId: string;
    name: string;
  }): Promise<PlayerRow | null> {
    const [row] = await this.db
      .update(players)
      .set({ name: input.name })
      .where(and(eq(players.id, input.id), eq(players.circleId, input.circleId)))
      .returning();
    return row ?? null;
  }

  async deletePlayer(input: { id: string; circleId: string }): Promise<boolean> {
    const rows = await this.db
      .delete(players)
      .where(and(eq(players.id, input.id), eq(players.circleId, input.circleId)))
      .returning({ id: players.id });
    return rows.length > 0;
  }
}
