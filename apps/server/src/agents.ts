import { and, eq } from "drizzle-orm";
import {
  type Agent,
  type SaveAgentRequest,
  type SaveAgentResult,
} from "@minorillusion/contract";
import { db as defaultDb, type Database } from "./db/client.js";
import { agents, type AgentRow } from "./db/schema.js";

/**
 * Repository/service over agents — the M6 intelligence layer. An agent is an
 * actor (D3): configured knowledge + an optional TTS voice; the GM prompts it and
 * the reply is delivered as an effect through the existing router. All DB access
 * sits behind the `AgentsStore` seam so the service logic (upsert, row → contract
 * mapping) is unit-testable with a fake in-memory store — no live Postgres
 * required. Mirrors src/characters.ts. See src/agents.test.ts.
 */

// ---------------------------------------------------------------------------
// Storage seam — the only surface that touches the DB.
// ---------------------------------------------------------------------------

/** A row to insert/update. id absent = insert; timestamps the service stamps. */
export interface AgentUpsert {
  id?: string;
  circleId: string;
  name: string;
  knowledge: string;
  voice: string | null;
}

export interface AgentsStore {
  insertAgent(input: Omit<AgentUpsert, "id">): Promise<AgentRow>;
  /** Update an agent scoped to its circle; null if no such row in it. */
  updateAgent(input: AgentUpsert & { id: string }): Promise<AgentRow | null>;
  findAgent(circleId: string, id: string): Promise<AgentRow | null>;
  listAgents(circleId: string): Promise<AgentRow[]>;
  /** Delete an agent scoped to its circle; true if a row was removed. */
  deleteAgent(input: { id: string; circleId: string }): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Mapping: DB row → contract Agent (dates as ISO strings, null voice omitted).
// ---------------------------------------------------------------------------

export function toAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    circleId: row.circleId,
    name: row.name,
    knowledge: row.knowledge,
    ...(row.voice !== null ? { voice: row.voice } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toAgents(rows: AgentRow[]): Agent[] {
  return rows.map(toAgent);
}

// ---------------------------------------------------------------------------
// Prompt grounding — the system prompt that puts the LLM in character.
// ---------------------------------------------------------------------------

/**
 * Build the system prompt that grounds an agent's reply in its configured
 * knowledge and keeps the reply SHORT + IN-CHARACTER (it is spoken aloud through
 * a player's device or shown as a brief parchment, so length matters). Pure (no
 * I/O) so the handler stays thin and the prompt is directly testable. The agent's
 * knowledge brief is embedded verbatim as the persona.
 */
export function agentSystemPrompt(agent: Pick<Agent, "name" | "knowledge">): string {
  const persona = agent.knowledge.trim();
  return (
    `You are "${agent.name}", a character in a tabletop RPG session, speaking ` +
    "directly to the players. Stay fully in character. Reply in ONE to THREE " +
    "short sentences — your words are spoken aloud at the table, so be vivid " +
    "but brief. Never break character, never mention being an AI, and never " +
    "describe your own actions in stage directions." +
    (persona ? `\n\nWho you are and what you know:\n${persona}` : "")
  );
}

// ---------------------------------------------------------------------------
// Service — business logic over the store. Returns contract shapes.
// ---------------------------------------------------------------------------

export class AgentService {
  constructor(private readonly store: AgentsStore) {}

  /**
   * Upsert an agent: an id present updates the matching row in this circle
   * (updatedAt always bumps); absent inserts a new one (createdAt stamped). A
   * stale/foreign id (no row in this circle) is treated as a not-found error.
   */
  async saveAgent(
    circleId: string,
    req: SaveAgentRequest,
  ): Promise<SaveAgentResult> {
    const base = {
      circleId,
      name: req.name,
      knowledge: req.knowledge,
      voice: req.voice ?? null,
    };
    if (req.id) {
      const row = await this.store.updateAgent({ ...base, id: req.id });
      if (!row) return { ok: false, error: "Agent not found." };
      return { ok: true, agent: toAgent(row) };
    }
    const row = await this.store.insertAgent(base);
    return { ok: true, agent: toAgent(row) };
  }

  async listAgents(circleId: string): Promise<Agent[]> {
    return toAgents(await this.store.listAgents(circleId));
  }

  /** Fetch one agent (for prompting); null if not in this circle. */
  async getAgent(circleId: string, id: string): Promise<Agent | null> {
    const row = await this.store.findAgent(circleId, id);
    return row ? toAgent(row) : null;
  }

  /** Delete an agent (scoped to its circle). True if a row was removed. */
  async deleteAgent(circleId: string, id: string): Promise<boolean> {
    return this.store.deleteAgent({ id, circleId });
  }
}

// ---------------------------------------------------------------------------
// Drizzle-backed store (the production implementation).
// ---------------------------------------------------------------------------

export class DrizzleAgentsStore implements AgentsStore {
  constructor(private readonly db: Database = defaultDb) {}

  async insertAgent(input: Omit<AgentUpsert, "id">): Promise<AgentRow> {
    const [row] = await this.db.insert(agents).values(input).returning();
    if (!row) throw new Error("agent insert returned no row");
    return row;
  }

  async updateAgent(
    input: AgentUpsert & { id: string },
  ): Promise<AgentRow | null> {
    const { id, circleId, ...rest } = input;
    const [row] = await this.db
      .update(agents)
      .set({ ...rest, updatedAt: new Date() })
      .where(and(eq(agents.id, id), eq(agents.circleId, circleId)))
      .returning();
    return row ?? null;
  }

  async findAgent(circleId: string, id: string): Promise<AgentRow | null> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.circleId, circleId)))
      .limit(1);
    return row ?? null;
  }

  async listAgents(circleId: string): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agents)
      .where(eq(agents.circleId, circleId))
      .orderBy(agents.createdAt);
  }

  async deleteAgent(input: { id: string; circleId: string }): Promise<boolean> {
    const rows = await this.db
      .delete(agents)
      .where(and(eq(agents.id, input.id), eq(agents.circleId, input.circleId)))
      .returning({ id: agents.id });
    return rows.length > 0;
  }
}
