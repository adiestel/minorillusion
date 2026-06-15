import { and, eq } from "drizzle-orm";
import {
  type Ability,
  type AbilityScores,
  type Character,
  type SaveCharacterRequest,
  type SaveCharacterResult,
  type Skill,
} from "@minorillusion/contract";
import { db as defaultDb, type Database } from "./db/client.js";
import { characters, type CharacterRow } from "./db/schema.js";

/**
 * Repository/service over characters — the M5 D&D layer (D6: we own the
 * roll-relevant sheet, with manual entry as the guaranteed path and a best-effort
 * DDB public-link import as a convenience). All DB access sits behind the
 * `CharactersStore` seam so the service logic (upsert, row → contract mapping,
 * the DDB id parse + mapping) is unit-testable with a fake in-memory store — no
 * live Postgres required. Mirrors src/circles.ts. See src/characters.test.ts.
 */

// ---------------------------------------------------------------------------
// Storage seam — the only surface that touches the DB.
// ---------------------------------------------------------------------------

/** A row to insert/update. id absent = insert; timestamps the service stamps. */
export interface CharacterUpsert {
  id?: string;
  circleId: string;
  name: string;
  level: number;
  abilities: AbilityScores;
  proficiencyBonus: number | null;
  skillProficiencies: Skill[];
  saveProficiencies: Ability[];
  maxHp: number | null;
  ac: number | null;
  source: "manual" | "ddb";
}

export interface CharactersStore {
  insertCharacter(input: Omit<CharacterUpsert, "id">): Promise<CharacterRow>;
  /** Update a character scoped to its circle; null if no such row in it. */
  updateCharacter(
    input: CharacterUpsert & { id: string },
  ): Promise<CharacterRow | null>;
  findCharacter(circleId: string, id: string): Promise<CharacterRow | null>;
  listCharacters(circleId: string): Promise<CharacterRow[]>;
  /** Delete a character scoped to its circle; true if a row was removed. */
  deleteCharacter(input: { id: string; circleId: string }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Mapping: DB row → contract Character (dates as ISO strings).
// ---------------------------------------------------------------------------

export function toCharacter(row: CharacterRow): Character {
  return {
    id: row.id,
    circleId: row.circleId,
    name: row.name,
    level: row.level,
    abilities: row.abilities,
    ...(row.proficiencyBonus !== null
      ? { proficiencyBonus: row.proficiencyBonus }
      : {}),
    skillProficiencies: row.skillProficiencies,
    saveProficiencies: row.saveProficiencies,
    ...(row.maxHp !== null ? { maxHp: row.maxHp } : {}),
    ...(row.ac !== null ? { ac: row.ac } : {}),
    source: row.source === "ddb" ? "ddb" : "manual",
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toCharacters(rows: CharacterRow[]): Character[] {
  return rows.map(toCharacter);
}

// ---------------------------------------------------------------------------
// D&D Beyond best-effort import (D6).
//
// There is NO official D&D Beyond API (per project memory, as of June 2026). The
// endpoint below is UNDOCUMENTED and UNOFFICIAL — it returns JSON for *public*
// characters only and MAY BREAK or change shape at any time. We never depend on
// it: every failure path (bad URL, network error, non-public/404, unexpected
// JSON) returns a clean error and the GM falls back to manual entry.
// ---------------------------------------------------------------------------

/** The unofficial public character-service endpoint (subject to change/removal). */
const DDB_CHARACTER_ENDPOINT =
  "https://character-service.dndbeyond.com/character/v5/character";

/**
 * Pull the numeric character id out of a D&D Beyond character URL (or accept a
 * bare numeric id). Handles the common share/sheet shapes, e.g.
 *   https://www.dndbeyond.com/characters/12345678
 *   https://www.dndbeyond.com/profile/me/characters/12345678/builder
 *   12345678
 * Pure (no network) so it's directly unit-testable. Returns null when no id is
 * found. We require the id to follow a "characters/" segment (or be the whole
 * string) so we don't grab an unrelated number from the URL.
 */
export function parseDdbCharacterId(input: string): string | null {
  const trimmed = input.trim();
  if (/^\d{1,20}$/.test(trimmed)) return trimmed;
  // The id is the digits immediately after a "/characters/" path segment.
  const match = trimmed.match(/\/characters\/(\d{1,20})/i);
  return match ? (match[1] ?? null) : null;
}

/** D&D Beyond ability ids → our ability keys (their stats[] is ordered by id). */
const DDB_STAT_ID: Record<number, Ability> = {
  1: "str",
  2: "dex",
  3: "con",
  4: "int",
  5: "wis",
  6: "cha",
};

const ALL_SKILLS: Skill[] = [
  "acrobatics", "animal_handling", "arcana", "athletics", "deception",
  "history", "insight", "intimidation", "investigation", "medicine",
  "nature", "perception", "performance", "persuasion", "religion",
  "sleight_of_hand", "stealth", "survival",
];

/** DDB modifier "subType" (kebab) → our skill key. */
const DDB_SKILL_SUBTYPE: Record<string, Skill> = {
  acrobatics: "acrobatics",
  "animal-handling": "animal_handling",
  arcana: "arcana",
  athletics: "athletics",
  deception: "deception",
  history: "history",
  insight: "insight",
  intimidation: "intimidation",
  investigation: "investigation",
  medicine: "medicine",
  nature: "nature",
  perception: "perception",
  performance: "performance",
  persuasion: "persuasion",
  religion: "religion",
  "sleight-of-hand": "sleight_of_hand",
  stealth: "stealth",
  survival: "survival",
};

/** DDB save modifier "subType" (e.g. "dexterity-saving-throws") → our ability. */
const DDB_SAVE_SUBTYPE: Record<string, Ability> = {
  "strength-saving-throws": "str",
  "dexterity-saving-throws": "dex",
  "constitution-saving-throws": "con",
  "intelligence-saving-throws": "int",
  "wisdom-saving-throws": "wis",
  "charisma-saving-throws": "cha",
};

function clampScore(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 10;
  return Math.max(1, Math.min(30, v));
}

/**
 * Map a D&D Beyond character JSON payload to a SaveCharacterRequest, pulling only
 * the roll-relevant fields (D6). Defensive throughout — DDB's shape is not a
 * contract; anything missing falls back to a sane default (score 10, level 1, no
 * proficiencies). The payload is the `.data` object of the endpoint response (or
 * the bare object, if the endpoint returns it unwrapped). Pure, so it's tested
 * directly against a captured fixture without a network. Returns null only when
 * the payload isn't a usable object at all.
 */
export function mapDdbCharacter(
  payload: unknown,
): SaveCharacterRequest | null {
  if (!payload || typeof payload !== "object") return null;
  // The endpoint wraps the character under `data`; accept either shape.
  const root = payload as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<
    string,
    unknown
  >;

  const name =
    typeof data.name === "string" && data.name.trim() !== ""
      ? data.name.trim().slice(0, 60)
      : "Imported Character";

  // Level: sum class levels (a multiclass character has several). Fall back to 1.
  let level = 0;
  if (Array.isArray(data.classes)) {
    for (const cls of data.classes) {
      const lvl = (cls as Record<string, unknown>)?.level;
      if (typeof lvl === "number" && Number.isFinite(lvl)) level += lvl;
    }
  }
  level = Math.max(1, Math.min(20, level || 1));

  // Ability scores: DDB `stats` is an array of { id, value } keyed by stat id.
  // `bonusStats`/`overrideStats` add racial/override adjustments where present.
  const scores: AbilityScores = {
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
  };
  const accum: Partial<Record<Ability, number>> = {};
  const addStats = (arr: unknown, mode: "base" | "bonus" | "override"): void => {
    if (!Array.isArray(arr)) return;
    for (const s of arr) {
      const rec = s as Record<string, unknown>;
      const ability = DDB_STAT_ID[Number(rec?.id)];
      if (!ability) continue;
      const value = rec?.value;
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      if (mode === "override") accum[ability] = value;
      else if (mode === "bonus") accum[ability] = (accum[ability] ?? 0) + value;
      else accum[ability] = value;
    }
  };
  addStats(data.stats, "base");
  addStats(data.bonusStats, "bonus");
  addStats(data.overrideStats, "override");
  for (const ability of Object.keys(scores) as Ability[]) {
    if (accum[ability] !== undefined) scores[ability] = clampScore(accum[ability]);
  }

  // Proficiencies live in `modifiers`, a map of source → modifier[]. A proficiency
  // modifier has type "proficiency" and a subType naming the skill/save.
  const skillSet = new Set<Skill>();
  const saveSet = new Set<Ability>();
  const modifiers = data.modifiers;
  if (modifiers && typeof modifiers === "object") {
    for (const group of Object.values(modifiers as Record<string, unknown>)) {
      if (!Array.isArray(group)) continue;
      for (const mod of group) {
        const rec = mod as Record<string, unknown>;
        if (rec?.type !== "proficiency") continue;
        const subType = typeof rec?.subType === "string" ? rec.subType : "";
        const skill = DDB_SKILL_SUBTYPE[subType];
        if (skill) skillSet.add(skill);
        const save = DDB_SAVE_SUBTYPE[subType];
        if (save) saveSet.add(save);
      }
    }
  }

  // Max HP: DDB exposes baseHitPoints (+ bonus/override). Best-effort.
  let maxHp: number | undefined;
  const baseHp = data.baseHitPoints;
  if (typeof baseHp === "number" && Number.isFinite(baseHp)) {
    const bonus =
      typeof data.bonusHitPoints === "number" ? data.bonusHitPoints : 0;
    const override = data.overrideHitPoints;
    const hp =
      typeof override === "number" && Number.isFinite(override)
        ? override
        : baseHp + bonus;
    maxHp = Math.max(0, Math.min(1000, Math.round(hp)));
  }

  // Keep the skill list in canonical order for stable output.
  const skillProficiencies = ALL_SKILLS.filter((s) => skillSet.has(s));
  const saveProficiencies = (Object.keys(scores) as Ability[]).filter((a) =>
    saveSet.has(a),
  );

  return {
    name,
    level,
    abilities: scores,
    skillProficiencies,
    saveProficiencies,
    ...(maxHp !== undefined ? { maxHp } : {}),
  };
}

// ---------------------------------------------------------------------------
// Service — business logic over the store. Returns contract shapes.
// ---------------------------------------------------------------------------

export class CharacterService {
  constructor(
    private readonly store: CharactersStore,
    /** Injected so tests stub the DDB fetch; defaults to global fetch. */
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Upsert a character: an id present updates the matching row in this circle
   * (updatedAt always bumps); absent inserts a new one (createdAt stamped). A
   * stale/foreign id (no row in this circle) is treated as a not-found error.
   */
  async saveCharacter(
    circleId: string,
    req: SaveCharacterRequest,
    source: "manual" | "ddb" = "manual",
  ): Promise<SaveCharacterResult> {
    const base = {
      circleId,
      name: req.name,
      level: req.level,
      abilities: req.abilities,
      proficiencyBonus: req.proficiencyBonus ?? null,
      skillProficiencies: req.skillProficiencies,
      saveProficiencies: req.saveProficiencies,
      maxHp: req.maxHp ?? null,
      ac: req.ac ?? null,
      source,
    };
    if (req.id) {
      const row = await this.store.updateCharacter({ ...base, id: req.id });
      if (!row) return { ok: false, error: "Character not found." };
      return { ok: true, character: toCharacter(row) };
    }
    const row = await this.store.insertCharacter(base);
    return { ok: true, character: toCharacter(row) };
  }

  async listCharacters(circleId: string): Promise<Character[]> {
    return toCharacters(await this.store.listCharacters(circleId));
  }

  /** Fetch one character (for roll resolution); null if not in this circle. */
  async getCharacter(
    circleId: string,
    id: string,
  ): Promise<Character | null> {
    const row = await this.store.findCharacter(circleId, id);
    return row ? toCharacter(row) : null;
  }

  /** Delete a character (scoped to its circle). True if a row was removed. */
  async deleteCharacter(circleId: string, id: string): Promise<boolean> {
    return this.store.deleteCharacter({ id, circleId });
  }

  /**
   * Best-effort DDB public-link import (D6). Parses the character id, GETs the
   * unofficial public endpoint, maps the roll-relevant fields, and persists the
   * result. NEVER throws — every failure (bad URL, network, non-public/404,
   * unexpected JSON) returns a clean { ok:false, error } so the caller falls back
   * to manual entry. Imported characters are stamped source:"ddb".
   */
  async importFromDdb(
    circleId: string,
    url: string,
  ): Promise<SaveCharacterResult> {
    const id = parseDdbCharacterId(url);
    if (!id) {
      return {
        ok: false,
        error: "Couldn't find a D&D Beyond character id in that link.",
      };
    }

    let payload: unknown;
    try {
      const res = await this.fetchImpl(`${DDB_CHARACTER_ENDPOINT}/${id}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        return {
          ok: false,
          error:
            res.status === 404
              ? "Character not found — is the sheet set to public?"
              : `D&D Beyond returned ${res.status}. Make sure the sheet is public.`,
        };
      }
      payload = await res.json();
    } catch {
      // Network error, DNS, abort, non-JSON body — all best-effort failures.
      return {
        ok: false,
        error: "Couldn't reach D&D Beyond. Try again, or enter the sheet manually.",
      };
    }

    const mapped = mapDdbCharacter(payload);
    if (!mapped) {
      return {
        ok: false,
        error: "Couldn't read that D&D Beyond character. Enter it manually.",
      };
    }
    return this.saveCharacter(circleId, mapped, "ddb");
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed store (the production implementation).
// ---------------------------------------------------------------------------

export class DrizzleCharactersStore implements CharactersStore {
  constructor(private readonly db: Database = defaultDb) {}

  async insertCharacter(
    input: Omit<CharacterUpsert, "id">,
  ): Promise<CharacterRow> {
    const [row] = await this.db.insert(characters).values(input).returning();
    if (!row) throw new Error("character insert returned no row");
    return row;
  }

  async updateCharacter(
    input: CharacterUpsert & { id: string },
  ): Promise<CharacterRow | null> {
    const { id, circleId, ...rest } = input;
    const [row] = await this.db
      .update(characters)
      .set({ ...rest, updatedAt: new Date() })
      .where(and(eq(characters.id, id), eq(characters.circleId, circleId)))
      .returning();
    return row ?? null;
  }

  async findCharacter(
    circleId: string,
    id: string,
  ): Promise<CharacterRow | null> {
    const [row] = await this.db
      .select()
      .from(characters)
      .where(and(eq(characters.id, id), eq(characters.circleId, circleId)))
      .limit(1);
    return row ?? null;
  }

  async listCharacters(circleId: string): Promise<CharacterRow[]> {
    return this.db
      .select()
      .from(characters)
      .where(eq(characters.circleId, circleId))
      .orderBy(characters.createdAt);
  }

  async deleteCharacter(input: {
    id: string;
    circleId: string;
  }): Promise<boolean> {
    const rows = await this.db
      .delete(characters)
      .where(
        and(
          eq(characters.id, input.id),
          eq(characters.circleId, input.circleId),
        ),
      )
      .returning({ id: characters.id });
    return rows.length > 0;
  }
}
