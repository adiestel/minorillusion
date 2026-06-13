import { sql } from "drizzle-orm";
import {
  boolean,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

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

export type CircleRow = typeof circles.$inferSelect;
export type PlayerRow = typeof players.$inferSelect;
