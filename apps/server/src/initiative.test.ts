import { describe, expect, it } from "vitest";
import {
  initiativeStateSchema,
  type SetInitiativeRequest,
} from "@minorillusion/contract";
import {
  advanceTurn,
  clearInitiative,
  emptyInitiative,
  setEntries,
} from "./initiative.js";

/**
 * Pure-reducer unit tests for the initiative tracker — no I/O, no socket. We
 * exercise the ordering rules directly: high→low (stable) sort, the advance
 * cursor wrapping + round bump, clear, and the empty no-ops. The reducer is the
 * single source of truth for combat order (the socket layer just holds state).
 */

const CIRCLE = "00000000-0000-0000-0000-000000000010";

const set = (
  entries: SetInitiativeRequest["entries"],
): SetInitiativeRequest => ({ entries });

describe("setEntries — sorting + identity + reset", () => {
  it("sorts entries high→low by initiative", () => {
    const next = setEntries(
      emptyInitiative(CIRCLE),
      set([
        { name: "Goblin", initiative: 8 },
        { name: "Vex", initiative: 21 },
        { name: "Bram", initiative: 15 },
      ]),
    );
    expect(next.entries.map((e) => e.name)).toEqual(["Vex", "Bram", "Goblin"]);
    expect(next.entries.map((e) => e.initiative)).toEqual([21, 15, 8]);
  });

  it("is a STABLE sort: equal initiatives keep the GM's input order", () => {
    const next = setEntries(
      emptyInitiative(CIRCLE),
      set([
        { name: "First", initiative: 12 },
        { name: "Second", initiative: 12 },
        { name: "Third", initiative: 12 },
      ]),
    );
    expect(next.entries.map((e) => e.name)).toEqual([
      "First",
      "Second",
      "Third",
    ]);
  });

  it("mints uuids for new entries (no id) and preserves provided ids", () => {
    const existingId = "00000000-0000-0000-0000-0000000000aa";
    const next = setEntries(
      emptyInitiative(CIRCLE),
      set([
        { name: "Has Id", initiative: 10, id: existingId },
        { name: "No Id", initiative: 5 },
      ]),
    );
    expect(next.entries[0]?.id).toBe(existingId);
    expect(next.entries[1]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("resets to round 1, turnIndex 0 for a non-empty order", () => {
    const next = setEntries(
      emptyInitiative(CIRCLE),
      set([{ name: "Vex", initiative: 17 }]),
    );
    expect(next.round).toBe(1);
    expect(next.turnIndex).toBe(0);
    expect(next.circleId).toBe(CIRCLE);
  });

  it("an empty set collapses to the empty sentinel (round 0, turnIndex −1)", () => {
    const started = setEntries(
      emptyInitiative(CIRCLE),
      set([{ name: "Vex", initiative: 17 }]),
    );
    const cleared = setEntries(started, set([]));
    expect(cleared.entries).toHaveLength(0);
    expect(cleared.round).toBe(0);
    expect(cleared.turnIndex).toBe(-1);
  });

  it("carries through optional fields (characterId, hp, maxHp)", () => {
    const charId = "00000000-0000-0000-0000-0000000000bb";
    const next = setEntries(
      emptyInitiative(CIRCLE),
      set([
        { name: "Bram", initiative: 14, characterId: charId, hp: 30, maxHp: 42 },
      ]),
    );
    expect(next.entries[0]).toMatchObject({
      characterId: charId,
      hp: 30,
      maxHp: 42,
    });
  });

  it("produces a state that satisfies the contract schema", () => {
    const next = setEntries(
      emptyInitiative(CIRCLE),
      set([
        { name: "Vex", initiative: 21 },
        { name: "Goblin", initiative: 8 },
      ]),
    );
    expect(initiativeStateSchema.safeParse(next).success).toBe(true);
  });
});

describe("advanceTurn — cursor, wrap, round bump", () => {
  const order = setEntries(
    emptyInitiative(CIRCLE),
    set([
      { name: "A", initiative: 20 },
      { name: "B", initiative: 15 },
      { name: "C", initiative: 10 },
    ]),
  );

  it("moves the cursor forward by one without changing the round", () => {
    const next = advanceTurn(order); // 0 -> 1
    expect(next.turnIndex).toBe(1);
    expect(next.round).toBe(1);
  });

  it("two advances reach the last entry, still round 1", () => {
    const next = advanceTurn(advanceTurn(order)); // 0 -> 1 -> 2
    expect(next.turnIndex).toBe(2);
    expect(next.round).toBe(1);
  });

  it("advancing past the last entry wraps to 0 and bumps the round", () => {
    // 0 -> 1 -> 2 -> wrap to 0 (round 2)
    const next = advanceTurn(advanceTurn(advanceTurn(order)));
    expect(next.turnIndex).toBe(0);
    expect(next.round).toBe(2);
  });

  it("a full second lap reaches round 3", () => {
    let s = order;
    for (let i = 0; i < 6; i++) s = advanceTurn(s); // two full laps
    expect(s.turnIndex).toBe(0);
    expect(s.round).toBe(3);
  });

  it("does not mutate the input state", () => {
    const before = JSON.parse(JSON.stringify(order));
    advanceTurn(order);
    expect(order).toEqual(before);
  });

  it("is a no-op on an empty order", () => {
    const empty = emptyInitiative(CIRCLE);
    const next = advanceTurn(empty);
    expect(next.turnIndex).toBe(-1);
    expect(next.round).toBe(0);
    expect(next.entries).toHaveLength(0);
  });

  it("recovers a −1 cursor on a non-empty order to the first entry", () => {
    const weird = { ...order, turnIndex: -1, round: 1 };
    const next = advanceTurn(weird);
    expect(next.turnIndex).toBe(0);
  });
});

describe("clearInitiative", () => {
  it("empties entries and resets round/turnIndex to the empty sentinel", () => {
    const order = setEntries(
      emptyInitiative(CIRCLE),
      set([{ name: "Vex", initiative: 21 }]),
    );
    const cleared = clearInitiative(advanceTurn(order));
    expect(cleared.entries).toHaveLength(0);
    expect(cleared.round).toBe(0);
    expect(cleared.turnIndex).toBe(-1);
    expect(cleared.circleId).toBe(CIRCLE);
  });
});
