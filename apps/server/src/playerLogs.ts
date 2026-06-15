import { desc, eq } from "drizzle-orm";
import { type PlayerLog } from "@minorillusion/contract";
import { db as defaultDb, type Database } from "./db/client.js";
import { playerLogs, type PlayerLogRow } from "./db/schema.js";

/**
 * Repository/service over per-player chronicles — the M7 join-ritual + ship
 * layer. A chronicle is a session summary/log line the GM delivered to ONE
 * player, who keeps a persistent history of them (DECISIONS D9). One row is
 * persisted per recipient at delivery, so each player's history is independent.
 * DB access sits behind the `PlayerLogStore` seam so the service logic + row →
 * contract mapping is unit-testable with a fake in-memory store — no live
 * Postgres required. Mirrors src/summaries.ts. See src/playerLogs.test.ts.
 */

// ---------------------------------------------------------------------------
// Storage seam — the only surface that touches the DB.
// ---------------------------------------------------------------------------

export interface PlayerLogStore {
  insertLog(input: {
    circleId: string;
    playerId: string;
    title: string | null;
    text: string;
  }): Promise<PlayerLogRow>;
  /** A player's chronicles, newest first. */
  listForPlayer(playerId: string): Promise<PlayerLogRow[]>;
}

// ---------------------------------------------------------------------------
// Mapping: DB row → contract PlayerLog (dates as ISO strings, null title omitted).
// ---------------------------------------------------------------------------

export function toPlayerLog(row: PlayerLogRow): PlayerLog {
  return {
    id: row.id,
    circleId: row.circleId,
    playerId: row.playerId,
    ...(row.title !== null ? { title: row.title } : {}),
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Service — business logic over the store. Returns contract shapes.
// ---------------------------------------------------------------------------

export class PlayerLogService {
  constructor(private readonly store: PlayerLogStore) {}

  /**
   * Persist a chronicle delivered to one player (the same title/text the GM
   * sent) and return the stored PlayerLog. Called once per recipient.
   */
  async deliver(
    circleId: string,
    playerId: string,
    chronicle: { title?: string; text: string },
  ): Promise<PlayerLog> {
    const row = await this.store.insertLog({
      circleId,
      playerId,
      title: chronicle.title ?? null,
      text: chronicle.text,
    });
    return toPlayerLog(row);
  }

  /** The player's chronicle history, newest first. */
  async listForPlayer(playerId: string): Promise<PlayerLog[]> {
    return (await this.store.listForPlayer(playerId)).map(toPlayerLog);
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed store (the production implementation).
// ---------------------------------------------------------------------------

export class DrizzlePlayerLogStore implements PlayerLogStore {
  constructor(private readonly db: Database = defaultDb) {}

  async insertLog(input: {
    circleId: string;
    playerId: string;
    title: string | null;
    text: string;
  }): Promise<PlayerLogRow> {
    const [row] = await this.db.insert(playerLogs).values(input).returning();
    if (!row) throw new Error("player log insert returned no row");
    return row;
  }

  async listForPlayer(playerId: string): Promise<PlayerLogRow[]> {
    return this.db
      .select()
      .from(playerLogs)
      .where(eq(playerLogs.playerId, playerId))
      .orderBy(desc(playerLogs.createdAt));
  }
}
