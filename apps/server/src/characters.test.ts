import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  characterSchema,
  saveCharacterRequestSchema,
  type SaveCharacterRequest,
} from "@minorillusion/contract";
import {
  CharacterService,
  mapDdbCharacter,
  parseDdbCharacterId,
  toCharacter,
  type CharacterUpsert,
  type CharactersStore,
} from "./characters.js";
import type { CharacterRow } from "./db/schema.js";

/**
 * Hermetic unit tests — no live DB or network. A fake in-memory store implements
 * the CharactersStore seam, and a stub fetch feeds the DDB import, so we exercise
 * the real service logic (upsert, scoping, row → contract mapping) and the pure
 * DDB helpers in isolation. Mirrors src/circles.test.ts.
 */

// ---------------------------------------------------------------------------
// Fake in-memory store implementing the DB seam.
// ---------------------------------------------------------------------------

class FakeCharactersStore implements CharactersStore {
  readonly rows: CharacterRow[] = [];

  async insertCharacter(
    input: Omit<CharacterUpsert, "id">,
  ): Promise<CharacterRow> {
    const now = new Date();
    const row: CharacterRow = {
      id: randomUUID(),
      circleId: input.circleId,
      name: input.name,
      level: input.level,
      abilities: input.abilities,
      proficiencyBonus: input.proficiencyBonus,
      skillProficiencies: input.skillProficiencies,
      saveProficiencies: input.saveProficiencies,
      maxHp: input.maxHp,
      ac: input.ac,
      source: input.source,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
  }

  async updateCharacter(
    input: CharacterUpsert & { id: string },
  ): Promise<CharacterRow | null> {
    const row = this.rows.find(
      (r) => r.id === input.id && r.circleId === input.circleId,
    );
    if (!row) return null;
    row.name = input.name;
    row.level = input.level;
    row.abilities = input.abilities;
    row.proficiencyBonus = input.proficiencyBonus;
    row.skillProficiencies = input.skillProficiencies;
    row.saveProficiencies = input.saveProficiencies;
    row.maxHp = input.maxHp;
    row.ac = input.ac;
    row.source = input.source;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1000); // bump
    return row;
  }

  async findCharacter(
    circleId: string,
    id: string,
  ): Promise<CharacterRow | null> {
    return (
      this.rows.find((r) => r.id === id && r.circleId === circleId) ?? null
    );
  }

  async listCharacters(circleId: string): Promise<CharacterRow[]> {
    return this.rows.filter((r) => r.circleId === circleId);
  }

  async deleteCharacter(input: {
    id: string;
    circleId: string;
  }): Promise<boolean> {
    const i = this.rows.findIndex(
      (r) => r.id === input.id && r.circleId === input.circleId,
    );
    if (i === -1) return false;
    this.rows.splice(i, 1);
    return true;
  }
}

const CIRCLE = "00000000-0000-0000-0000-000000000001";
const OTHER_CIRCLE = "00000000-0000-0000-0000-000000000002";

const REQ: SaveCharacterRequest = saveCharacterRequestSchema.parse({
  name: "Bram",
  level: 5,
  abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
  skillProficiencies: ["stealth"],
  saveProficiencies: ["dex", "con"],
  maxHp: 42,
  ac: 16,
});

// ---------------------------------------------------------------------------
// Service: upsert (insert vs update), scoping, list, delete, get.
// ---------------------------------------------------------------------------

describe("CharacterService — save/upsert", () => {
  it("inserts a new character (no id) and returns a contract-valid shape", async () => {
    const svc = new CharacterService(new FakeCharactersStore());
    const result = await svc.saveCharacter(CIRCLE, REQ);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.character.name).toBe("Bram");
    expect(result.character.circleId).toBe(CIRCLE);
    expect(result.character.source).toBe("manual");
    expect(result.character.maxHp).toBe(42);
    expect(characterSchema.safeParse(result.character).success).toBe(true);
  });

  it("updates by id (in the same circle) and bumps updatedAt", async () => {
    const store = new FakeCharactersStore();
    const svc = new CharacterService(store);
    const created = await svc.saveCharacter(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await svc.saveCharacter(CIRCLE, {
      ...REQ,
      id: created.character.id,
      name: "Bram the Bold",
      level: 6,
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.character.id).toBe(created.character.id);
    expect(updated.character.name).toBe("Bram the Bold");
    expect(updated.character.level).toBe(6);
    expect(
      new Date(updated.character.updatedAt).getTime(),
    ).toBeGreaterThan(new Date(created.character.createdAt).getTime());
    // Still one row — an update, not an insert.
    expect(store.rows).toHaveLength(1);
  });

  it("treats a stale/foreign id as not-found (no cross-circle write)", async () => {
    const store = new FakeCharactersStore();
    const svc = new CharacterService(store);
    const created = await svc.saveCharacter(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Same id, different circle -> not found (scoped update).
    const miss = await svc.saveCharacter(OTHER_CIRCLE, {
      ...REQ,
      id: created.character.id,
    });
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.error).toBeTruthy();
  });

  it("omits optional fields that weren't provided", async () => {
    const svc = new CharacterService(new FakeCharactersStore());
    const minimal = saveCharacterRequestSchema.parse({
      name: "Plain",
      level: 1,
      abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    });
    const result = await svc.saveCharacter(CIRCLE, minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.character).not.toHaveProperty("maxHp");
    expect(result.character).not.toHaveProperty("ac");
    expect(result.character).not.toHaveProperty("proficiencyBonus");
    expect(result.character.skillProficiencies).toEqual([]);
  });
});

describe("CharacterService — list / get / delete (scoped)", () => {
  it("lists only the circle's characters", async () => {
    const svc = new CharacterService(new FakeCharactersStore());
    await svc.saveCharacter(CIRCLE, { ...REQ, name: "Vex" });
    await svc.saveCharacter(CIRCLE, { ...REQ, name: "Bram" });
    await svc.saveCharacter(OTHER_CIRCLE, { ...REQ, name: "Stranger" });

    const list = await svc.listCharacters(CIRCLE);
    expect(list.map((c) => c.name).sort()).toEqual(["Bram", "Vex"]);
  });

  it("getCharacter returns the sheet for roll resolution; null cross-circle", async () => {
    const svc = new CharacterService(new FakeCharactersStore());
    const created = await svc.saveCharacter(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const got = await svc.getCharacter(CIRCLE, created.character.id);
    expect(got?.name).toBe("Bram");
    expect(await svc.getCharacter(OTHER_CIRCLE, created.character.id)).toBeNull();
  });

  it("deletes scoped to the circle", async () => {
    const svc = new CharacterService(new FakeCharactersStore());
    const created = await svc.saveCharacter(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Wrong circle -> no-op.
    expect(await svc.deleteCharacter(OTHER_CIRCLE, created.character.id)).toBe(
      false,
    );
    expect(await svc.listCharacters(CIRCLE)).toHaveLength(1);

    // Right circle -> removed.
    expect(await svc.deleteCharacter(CIRCLE, created.character.id)).toBe(true);
    expect(await svc.listCharacters(CIRCLE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Row -> contract mapping (dates as ISO strings, nullable -> omitted).
// ---------------------------------------------------------------------------

describe("toCharacter mapping", () => {
  it("maps a row to the contract shape, ISO dates, omitting nulls", () => {
    const row: CharacterRow = {
      id: randomUUID(),
      circleId: CIRCLE,
      name: "Vex",
      level: 3,
      abilities: { str: 8, dex: 18, con: 12, int: 13, wis: 14, cha: 16 },
      proficiencyBonus: null,
      skillProficiencies: ["stealth", "perception"],
      saveProficiencies: ["dex"],
      maxHp: null,
      ac: null,
      source: "manual",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      updatedAt: new Date("2026-01-02T03:04:06.000Z"),
    };
    const c = toCharacter(row);
    expect(c.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(c.updatedAt).toBe("2026-01-02T03:04:06.000Z");
    expect(c).not.toHaveProperty("proficiencyBonus");
    expect(c).not.toHaveProperty("maxHp");
    expect(c).not.toHaveProperty("ac");
    expect(characterSchema.safeParse(c).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// DDB URL id parser (pure).
// ---------------------------------------------------------------------------

describe("parseDdbCharacterId", () => {
  it("extracts the id from a standard character URL", () => {
    expect(
      parseDdbCharacterId("https://www.dndbeyond.com/characters/12345678"),
    ).toBe("12345678");
  });

  it("extracts the id from a deeper builder URL", () => {
    expect(
      parseDdbCharacterId(
        "https://www.dndbeyond.com/profile/me/characters/98765432/builder",
      ),
    ).toBe("98765432");
  });

  it("accepts a bare numeric id", () => {
    expect(parseDdbCharacterId("42424242")).toBe("42424242");
    expect(parseDdbCharacterId("  42424242  ")).toBe("42424242");
  });

  it("returns null when there is no character id", () => {
    expect(parseDdbCharacterId("https://www.dndbeyond.com/")).toBeNull();
    expect(parseDdbCharacterId("not a url")).toBeNull();
    expect(parseDdbCharacterId("https://example.com/page/999")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DDB payload -> SaveCharacterRequest mapping (pure, defensive).
// ---------------------------------------------------------------------------

/** A minimal slice of the DDB character-service shape (the fields we read). */
const DDB_FIXTURE = {
  data: {
    name: "Sir Reginald",
    classes: [{ level: 3 }, { level: 2 }], // multiclass -> level 5
    stats: [
      { id: 1, value: 16 }, // str
      { id: 2, value: 12 }, // dex
      { id: 3, value: 14 }, // con
      { id: 4, value: 10 }, // int
      { id: 5, value: 13 }, // wis
      { id: 6, value: 8 }, // cha
    ],
    bonusStats: [{ id: 1, value: 2 }], // +2 str -> 18
    overrideStats: [{ id: 6, value: null }],
    baseHitPoints: 38,
    bonusHitPoints: 4,
    overrideHitPoints: null,
    modifiers: {
      race: [
        { type: "proficiency", subType: "perception" },
        { type: "bonus", subType: "speed" }, // ignored (not a proficiency)
      ],
      class: [
        { type: "proficiency", subType: "athletics" },
        { type: "proficiency", subType: "constitution-saving-throws" },
        { type: "proficiency", subType: "strength-saving-throws" },
        { type: "proficiency", subType: "sleight-of-hand" },
      ],
    },
  },
};

describe("mapDdbCharacter", () => {
  it("maps the roll-relevant fields from a public-character payload", () => {
    const mapped = mapDdbCharacter(DDB_FIXTURE);
    expect(mapped).not.toBeNull();
    if (!mapped) return;
    expect(mapped.name).toBe("Sir Reginald");
    expect(mapped.level).toBe(5); // 3 + 2
    expect(mapped.abilities).toEqual({
      str: 18, // 16 base + 2 bonus
      dex: 12,
      con: 14,
      int: 10,
      wis: 13,
      cha: 8,
    });
    expect(mapped.maxHp).toBe(42); // 38 + 4
    expect(mapped.skillProficiencies.sort()).toEqual([
      "athletics",
      "perception",
      "sleight_of_hand",
    ]);
    expect(mapped.saveProficiencies.sort()).toEqual(["con", "str"]);
  });

  it("produces a request the contract schema accepts", () => {
    const mapped = mapDdbCharacter(DDB_FIXTURE);
    expect(saveCharacterRequestSchema.safeParse(mapped).success).toBe(true);
  });

  it("accepts an unwrapped payload (no data envelope)", () => {
    const mapped = mapDdbCharacter(DDB_FIXTURE.data);
    expect(mapped?.name).toBe("Sir Reginald");
  });

  it("falls back to sane defaults for an empty/garbage payload", () => {
    const mapped = mapDdbCharacter({});
    expect(mapped).not.toBeNull();
    if (!mapped) return;
    expect(mapped.name).toBe("Imported Character");
    expect(mapped.level).toBe(1);
    expect(mapped.abilities).toEqual({
      str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    });
    expect(mapped.skillProficiencies).toEqual([]);
    expect(mapped.saveProficiencies).toEqual([]);
  });

  it("returns null only for a non-object payload", () => {
    expect(mapDdbCharacter(null)).toBeNull();
    expect(mapDdbCharacter("nope")).toBeNull();
    expect(mapDdbCharacter(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// importFromDdb — best-effort, never throws (D6). Stub fetch each path.
// ---------------------------------------------------------------------------

function fetchReturning(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): typeof fetch {
  return (async () =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }) as Response) as unknown as typeof fetch;
}

describe("CharacterService.importFromDdb (best-effort)", () => {
  it("imports a public character and stamps source 'ddb'", async () => {
    const svc = new CharacterService(
      new FakeCharactersStore(),
      fetchReturning(DDB_FIXTURE),
    );
    const result = await svc.importFromDdb(
      CIRCLE,
      "https://www.dndbeyond.com/characters/12345678",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.character.name).toBe("Sir Reginald");
    expect(result.character.source).toBe("ddb");
    expect(result.character.circleId).toBe(CIRCLE);
  });

  it("fails gracefully on an unparseable link (no id)", async () => {
    const svc = new CharacterService(
      new FakeCharactersStore(),
      fetchReturning(DDB_FIXTURE),
    );
    const result = await svc.importFromDdb(CIRCLE, "totally not a link");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/id/i);
  });

  it("fails gracefully on a 404 (non-public sheet)", async () => {
    const svc = new CharacterService(
      new FakeCharactersStore(),
      fetchReturning(null, { ok: false, status: 404 }),
    );
    const result = await svc.importFromDdb(CIRCLE, "12345678");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/public/i);
  });

  it("fails gracefully on a network error (fetch throws)", async () => {
    const throwingFetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const svc = new CharacterService(new FakeCharactersStore(), throwingFetch);
    const result = await svc.importFromDdb(CIRCLE, "12345678");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/manually|reach/i);
  });

  it("does not persist anything when the import fails", async () => {
    const store = new FakeCharactersStore();
    const svc = new CharacterService(
      store,
      fetchReturning(null, { ok: false, status: 404 }),
    );
    await svc.importFromDdb(CIRCLE, "12345678");
    expect(store.rows).toHaveLength(0);
  });
});
