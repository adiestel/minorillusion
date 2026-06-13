import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db } from "./client.js";

/**
 * Apply pending SQL migrations from apps/server/drizzle/ on startup, before the
 * server listens, so a fresh database is ready for the smoke test. Migrations
 * are generated with `pnpm --filter @minorillusion/server db:generate`.
 */
export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: "./drizzle" });
}
