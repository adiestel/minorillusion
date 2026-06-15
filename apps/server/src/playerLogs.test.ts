import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { playerLogSchema } from "@minorillusion/contract";
import {
  PlayerLogService,
  toPlayerLog,
  type PlayerLogStore,
} from "./playerLogs.js";
import type { PlayerLogRow } from "./db/schema.js";

/**
 * Hermetic unit tests — no live DB. A fake in-memory store implements the
 * PlayerLogStore seam, so we exercise the real service logic (deliver →
 * insert + map, listForPlayer newest-first + scoped to one player) in
 * isolation. Mirrors src/characters.test.ts.
 */

// ---------------------------------------------------------------------------
// Fake in-memory store implementing the DB seam.
// ---------------------------------------------------------------------------

class FakePlayerLogStore implements PlayerLogStore {
  readonly rows: PlayerLogRow[] = [];
  /** Bumped per insert so each row gets a strictly-later createdAt (stable order). */
  private clock = 0;

  async insertLog(input: {
    circleId: string;
    playerId: string;
    title: string | null;
    text: string;
  }): Promise<PlayerLogRow> {
    const row: PlayerLogRow = {
      id: randomUUID(),
      circleId: input.circleId,
      playerId: input.playerId,
      title: input.title,
      text: input.text,
      createdAt: new Date(Date.UTC(2026, 0, 1) + this.clock++ * 1000),
    };
    this.rows.push(row);
    return row;
  }

  async listForPlayer(playerId: string): Promise<PlayerLogRow[]> {
    // Newest first, mirroring the Drizzle store's `orderBy(desc(createdAt))`.
    return this.rows
      .filter((r) => r.playerId === playerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
}

const CIRCLE = "00000000-0000-0000-0000-000000000001";
const PLAYER = "00000000-0000-0000-0000-0000000000a1";
const OTHER_PLAYER = "00000000-0000-0000-0000-0000000000a2";

// ---------------------------------------------------------------------------
// Service: deliver (persist + return), listForPlayer (newest-first, scoped).
// ---------------------------------------------------------------------------

describe("PlayerLogService — deliver", () => {
  it("persists a chronicle and returns a contract-valid PlayerLog", async () => {
    const store = new FakePlayerLogStore();
    const svc = new PlayerLogService(store);

    const log = await svc.deliver(CIRCLE, PLAYER, {
      title: "Session 1",
      text: "The party descended into the crypt.",
    });

    expect(log.circleId).toBe(CIRCLE);
    expect(log.playerId).toBe(PLAYER);
    expect(log.title).toBe("Session 1");
    expect(log.text).toBe("The party descended into the crypt.");
    expect(typeof log.createdAt).toBe("string");
    expect(playerLogSchema.safeParse(log).success).toBe(true);
    // One row persisted.
    expect(store.rows).toHaveLength(1);
  });

  it("omits the title when none is provided (untitled chronicle)", async () => {
    const store = new FakePlayerLogStore();
    const svc = new PlayerLogService(store);

    const log = await svc.deliver(CIRCLE, PLAYER, { text: "A quiet evening." });

    expect(log).not.toHaveProperty("title");
    expect(store.rows[0]?.title).toBeNull();
    expect(playerLogSchema.safeParse(log).success).toBe(true);
  });
});

describe("PlayerLogService — listForPlayer (scoped, newest-first)", () => {
  it("returns the player's logs newest-first, not another player's", async () => {
    const store = new FakePlayerLogStore();
    const svc = new PlayerLogService(store);

    // Two for our player (delivered in order), one for someone else.
    await svc.deliver(CIRCLE, PLAYER, { title: "First", text: "Chapter one." });
    await svc.deliver(OTHER_PLAYER, OTHER_PLAYER, {
      title: "Theirs",
      text: "Not yours.",
    });
    await svc.deliver(CIRCLE, PLAYER, { title: "Second", text: "Chapter two." });

    const logs = await svc.listForPlayer(PLAYER);

    // Only this player's logs.
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.playerId === PLAYER)).toBe(true);
    // Newest first: the second delivery leads.
    expect(logs.map((l) => l.title)).toEqual(["Second", "First"]);
  });

  it("returns an empty history for a player with no logs", async () => {
    const svc = new PlayerLogService(new FakePlayerLogStore());
    expect(await svc.listForPlayer(PLAYER)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row -> contract mapping (date as ISO string, null title omitted).
// ---------------------------------------------------------------------------

describe("toPlayerLog mapping", () => {
  it("maps a row to the contract shape, ISO date, omitting a null title", () => {
    const row: PlayerLogRow = {
      id: randomUUID(),
      circleId: CIRCLE,
      playerId: PLAYER,
      title: null,
      text: "An untitled chronicle.",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
    };
    const log = toPlayerLog(row);
    expect(log.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(log).not.toHaveProperty("title");
    expect(playerLogSchema.safeParse(log).success).toBe(true);
  });
});
