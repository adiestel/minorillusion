import { sql } from "drizzle-orm";
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type { Ability, AbilityScores, Skill } from "@minorillusion/contract";

/**
 * Drizzle schema for the M0 realtime core: circles (sessions) and the players
 * pinned to them. Shapes here mirror `packages/contract` (the wire protocol);
 * `src/circles.ts` maps rows → contract types (dates → ISO strings).
 */

export const circles = pgTable("circles", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  /** Six-digit join code, unique across active circles. */
  code: text("code").notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const players = pgTable(
  "players",
  {
    id: uuid("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    circleId: uuid("circle_id")
      .notNull()
      .references(() => circles.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Stable per-device id; a returning device re-maps to one pinned player. */
    deviceId: text("device_id").notNull(),
    connected: boolean("connected").notNull().default(false),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // One pinned player per device per circle: re-join updates, never duplicates.
    unique("players_circle_device_unique").on(table.circleId, table.deviceId),
  ],
);

/**
 * The M5 D&D layer: a character sheet, holding only the roll-relevant modifiers
 * (D6 — we are the system of record for rolls, with no DDB write path). Mirrors
 * `characterSchema` in `packages/contract`; `src/characters.ts` maps rows →
 * contract types (dates → ISO strings). The score maps + proficiency lists ride
 * as jsonb (small, bounded sets), typed via the contract aliases so the row's
 * inferred type stays honest. Deleting a circle cascades its characters.
 */
export const characters = pgTable("characters", {
  id: uuid("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  circleId: uuid("circle_id")
    .notNull()
    .references(() => circles.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  level: integer("level").notNull(),
  /** The six ability scores as a map ability→score. */
  abilities: jsonb("abilities").$type<AbilityScores>().notNull(),
  /** Override the level-derived proficiency bonus; null = derive from level. */
  proficiencyBonus: integer("proficiency_bonus"),
  /** Skills the character is proficient in. */
  skillProficiencies: jsonb("skill_proficiencies")
    .$type<Skill[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  /** Abilities the character is proficient in saving throws for. */
  saveProficiencies: jsonb("save_proficiencies")
    .$type<Ability[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  maxHp: integer("max_hp"),
  ac: integer("ac"),
  /** Whether the sheet was hand-entered ("manual") or DDB-imported ("ddb"). */
  source: text("source").notNull().default("manual"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type CircleRow = typeof circles.$inferSelect;
export type PlayerRow = typeof players.$inferSelect;
export type CharacterRow = typeof characters.$inferSelect;
