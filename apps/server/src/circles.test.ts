import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  joinRequestSchema,
  playerSchema,
  sixDigitCode,
} from "@minorillusion/contract";
import {
  CircleService,
  generateCode,
  toPlayers,
  uniqueCode,
  type CirclesStore,
} from "./circles.js";
import type { CircleRow, PlayerRow } from "./db/schema.js";

/**
 * Hermetic unit tests — no live DB or network. A fake in-memory store
 * implements the CirclesStore seam so we exercise the real service logic
 * (code generation, upsert, row → contract mapping, presence) in isolation.
 */

// ---------------------------------------------------------------------------
// Fake in-memory store implementing the DB seam.
// ---------------------------------------------------------------------------

class FakeCirclesStore implements CirclesStore {
  readonly circles: CircleRow[] = [];
  readonly players: PlayerRow[] = [];

  async insertCircle(input: {
    code: string;
    name: string | null;
  }): Promise<CircleRow> {
    if (this.circles.some((c) => c.code === input.code)) {
      throw new Error("duplicate code");
    }
    const row: CircleRow = {
      id: randomUUID(),
      code: input.code,
      name: input.name,
      createdAt: new Date(),
    };
    this.circles.push(row);
    return row;
  }

  async findCircleByCode(code: string): Promise<CircleRow | null> {
    return this.circles.find((c) => c.code === code) ?? null;
  }

  async findCircleById(id: string): Promise<CircleRow | null> {
    return this.circles.find((c) => c.id === id) ?? null;
  }

  async codeExists(code: string): Promise<boolean> {
    return this.circles.some((c) => c.code === code);
  }

  async findPlayer(
    circleId: string,
    deviceId: string,
  ): Promise<PlayerRow | null> {
    return (
      this.players.find(
        (p) => p.circleId === circleId && p.deviceId === deviceId,
      ) ?? null
    );
  }

  async insertPlayer(input: {
    circleId: string;
    name: string;
    deviceId: string;
    connected: boolean;
  }): Promise<PlayerRow> {
    const row: PlayerRow = {
      id: randomUUID(),
      circleId: input.circleId,
      name: input.name,
      deviceId: input.deviceId,
      connected: input.connected,
      joinedAt: new Date(),
    };
    this.players.push(row);
    return row;
  }

  async updatePlayer(
    id: string,
    input: { name: string; connected: boolean },
  ): Promise<PlayerRow> {
    const row = this.players.find((p) => p.id === id);
    if (!row) throw new Error("player not found");
    row.name = input.name;
    row.connected = input.connected;
    return row;
  }

  async setConnected(playerId: string, connected: boolean): Promise<void> {
    const row = this.players.find((p) => p.id === playerId);
    if (row) row.connected = connected;
  }

  async listPlayers(circleId: string): Promise<PlayerRow[]> {
    return this.players.filter((p) => p.circleId === circleId);
  }
}

// ---------------------------------------------------------------------------
// Code generation / format.
// ---------------------------------------------------------------------------

describe("generateCode", () => {
  it("always produces a 6-digit string accepted by the contract schema", () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      expect(code).toMatch(/^\d{6}$/);
      expect(sixDigitCode.safeParse(code).success).toBe(true);
    }
  });

  it("zero-pads small numbers to six digits", () => {
    // Force the low end of the range to assert padding (e.g. 0 -> "000000").
    const original = Math.random;
    try {
      Math.random = () => 0;
      expect(generateCode()).toBe("000000");
    } finally {
      Math.random = original;
    }
  });
});

describe("uniqueCode", () => {
  it("retries past a colliding code and returns a free one", async () => {
    const store = new FakeCirclesStore();
    // Pre-seed the first code generateCode() will yield, forcing one retry.
    const original = Math.random;
    const seq = [0, 0.5]; // -> "000000" (taken), then "500000" (free)
    let i = 0;
    try {
      Math.random = () => seq[Math.min(i++, seq.length - 1)] ?? 0;
      await store.insertCircle({ code: "000000", name: null });
      const code = await uniqueCode(store);
      expect(code).toBe("500000");
    } finally {
      Math.random = original;
    }
  });
});

// ---------------------------------------------------------------------------
// Presence mapping: rows -> contract Player[] (dates as ISO strings).
// ---------------------------------------------------------------------------

describe("toPlayers", () => {
  it("maps DB rows to contract Player shapes with ISO date strings", () => {
    const circleId = randomUUID();
    const rows: PlayerRow[] = [
      {
        id: randomUUID(),
        circleId,
        name: "Vex",
        deviceId: "device-a",
        connected: true,
        joinedAt: new Date("2026-01-02T03:04:05.000Z"),
      },
    ];
    const players = toPlayers(rows);
    expect(players).toHaveLength(1);
    const [player] = players;
    expect(player).toBeDefined();
    expect(player?.joinedAt).toBe("2026-01-02T03:04:05.000Z");
    // deviceId must NOT leak into the wire shape.
    expect(player).not.toHaveProperty("deviceId");
    // The mapped shape must satisfy the contract schema exactly.
    expect(playerSchema.safeParse(player).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Contract validation: invalid joins are rejected by the zod schemas.
// ---------------------------------------------------------------------------

describe("joinRequestSchema (contract validation)", () => {
  it("rejects a non-6-digit code", () => {
    const result = joinRequestSchema.safeParse({
      code: "12ab",
      name: "Vex",
      deviceId: "device-a",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const result = joinRequestSchema.safeParse({
      code: "123456",
      name: "",
      deviceId: "device-a",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed join request", () => {
    const result = joinRequestSchema.safeParse({
      code: "123456",
      name: "Vex",
      deviceId: "device-a",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Service behavior: join -> presence, upsert by (circle, device).
// ---------------------------------------------------------------------------

describe("CircleService", () => {
  it("creates a circle with a contract-valid code and null name by default", async () => {
    const service = new CircleService(new FakeCirclesStore());
    const circle = await service.createCircle();
    expect(circle.name).toBeNull();
    expect(sixDigitCode.safeParse(circle.code).success).toBe(true);
  });

  it("join then presence reflects the connected player", async () => {
    const store = new FakeCirclesStore();
    const service = new CircleService(store);
    const circle = await service.createCircle("Saturday Game");

    const joined = await service.joinCircle({
      code: circle.code,
      name: "Vex",
      deviceId: "device-a",
    });
    expect(joined.ok).toBe(true);

    const presence = await service.presence(circle.id);
    expect(presence).toHaveLength(1);
    expect(presence[0]?.name).toBe("Vex");
    expect(presence[0]?.connected).toBe(true);
  });

  it("re-join from the same device updates the pinned player, never duplicates", async () => {
    const store = new FakeCirclesStore();
    const service = new CircleService(store);
    const circle = await service.createCircle();

    const first = await service.joinCircle({
      code: circle.code,
      name: "Vex",
      deviceId: "device-a",
    });
    expect(first.ok).toBe(true);
    const firstId = first.ok ? first.player.id : "";

    // Same device, different name -> same player row, updated name.
    const second = await service.joinCircle({
      code: circle.code,
      name: "Vex'ahlia",
      deviceId: "device-a",
    });
    expect(second.ok).toBe(true);
    expect(second.ok && second.player.id).toBe(firstId);

    const presence = await service.presence(circle.id);
    expect(presence).toHaveLength(1);
    expect(presence[0]?.name).toBe("Vex'ahlia");
  });

  it("a second distinct device adds a second player to presence", async () => {
    const store = new FakeCirclesStore();
    const service = new CircleService(store);
    const circle = await service.createCircle();

    await service.joinCircle({
      code: circle.code,
      name: "Vex",
      deviceId: "device-a",
    });
    await service.joinCircle({
      code: circle.code,
      name: "Grog",
      deviceId: "device-b",
    });

    const presence = await service.presence(circle.id);
    expect(presence).toHaveLength(2);
    expect(presence.map((p) => p.name).sort()).toEqual(["Grog", "Vex"]);
  });

  it("rejects a join to a non-existent circle code", async () => {
    const service = new CircleService(new FakeCirclesStore());
    const result = await service.joinCircle({
      code: "999999",
      name: "Vex",
      deviceId: "device-a",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBeTruthy();
  });

  it("openCircle returns null for an unknown code and the roster for a known one", async () => {
    const store = new FakeCirclesStore();
    const service = new CircleService(store);
    expect(await service.openCircle("424242")).toBeNull();

    const circle = await service.createCircle();
    await service.joinCircle({
      code: circle.code,
      name: "Vex",
      deviceId: "device-a",
    });
    const opened = await service.openCircle(circle.code);
    expect(opened?.circle.id).toBe(circle.id);
    expect(opened?.players).toHaveLength(1);
  });

  it("setConnected toggles the player's connected flag (disconnect path)", async () => {
    const store = new FakeCirclesStore();
    const service = new CircleService(store);
    const circle = await service.createCircle();
    const joined = await service.joinCircle({
      code: circle.code,
      name: "Vex",
      deviceId: "device-a",
    });
    const playerId = joined.ok ? joined.player.id : "";

    await service.setConnected(playerId, false);
    const presence = await service.presence(circle.id);
    expect(presence[0]?.connected).toBe(false);
  });
});
