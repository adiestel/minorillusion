import { eq } from "drizzle-orm";
import { type Summary } from "@minorillusion/contract";
import { db as defaultDb, type Database } from "./db/client.js";
import { summaries, type SummaryRow } from "./db/schema.js";

/**
 * Repository/service over session summaries — the M6 intelligence layer. A
 * summary is the LLM-written recap of (a selection of) the room transcript. We
 * PERSIST summaries (durable campaign recaps) while the transcript itself stays
 * transient session state (in memory only, like initiative). DB access sits
 * behind the `SummariesStore` seam so the service logic + row → contract mapping
 * is unit-testable with a fake in-memory store. Mirrors src/characters.ts.
 */

export type SummaryStyle = Summary["style"];

// ---------------------------------------------------------------------------
// Storage seam — the only surface that touches the DB.
// ---------------------------------------------------------------------------

export interface SummariesStore {
  insertSummary(input: {
    circleId: string;
    style: SummaryStyle;
    text: string;
  }): Promise<SummaryRow>;
  listSummaries(circleId: string): Promise<SummaryRow[]>;
}

// ---------------------------------------------------------------------------
// Mapping: DB row → contract Summary (dates as ISO strings).
// ---------------------------------------------------------------------------

export function toSummary(row: SummaryRow): Summary {
  return {
    id: row.id,
    circleId: row.circleId,
    // The column is a free text style; narrow it back to the contract enum
    // (rows only ever hold one of these — the handler validates before writing).
    style: row.style as SummaryStyle,
    text: row.text,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Service — business logic over the store. Returns contract shapes.
// ---------------------------------------------------------------------------

export class SummaryService {
  constructor(private readonly store: SummariesStore) {}

  /** Persist a freshly written summary and return the contract shape. */
  async saveSummary(
    circleId: string,
    style: SummaryStyle,
    text: string,
  ): Promise<Summary> {
    const row = await this.store.insertSummary({ circleId, style, text });
    return toSummary(row);
  }

  /** The circle's saved summaries (oldest first). */
  async listSummaries(circleId: string): Promise<Summary[]> {
    return (await this.store.listSummaries(circleId)).map(toSummary);
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed store (the production implementation).
// ---------------------------------------------------------------------------

export class DrizzleSummariesStore implements SummariesStore {
  constructor(private readonly db: Database = defaultDb) {}

  async insertSummary(input: {
    circleId: string;
    style: SummaryStyle;
    text: string;
  }): Promise<SummaryRow> {
    const [row] = await this.db.insert(summaries).values(input).returning();
    if (!row) throw new Error("summary insert returned no row");
    return row;
  }

  async listSummaries(circleId: string): Promise<SummaryRow[]> {
    return this.db
      .select()
      .from(summaries)
      .where(eq(summaries.circleId, circleId))
      .orderBy(summaries.createdAt);
  }
}
