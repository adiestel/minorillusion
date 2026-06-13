import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

/**
 * postgres.js + Drizzle client. Defaults to the local docker-compose Postgres
 * (see docker-compose.yml) when DATABASE_URL is unset, so local == prod config.
 */

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgres://minorillusion:localdev@localhost:5432/minorillusion";

export const sql = postgres(DATABASE_URL);

export const db = drizzle(sql, { schema });

export type Database = typeof db;
