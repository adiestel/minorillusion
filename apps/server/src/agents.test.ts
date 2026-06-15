import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  agentSchema,
  saveAgentRequestSchema,
  type SaveAgentRequest,
} from "@minorillusion/contract";
import {
  AgentService,
  agentSystemPrompt,
  toAgent,
  type AgentUpsert,
  type AgentsStore,
} from "./agents.js";
import type { AgentRow } from "./db/schema.js";

/**
 * Hermetic unit tests — no live DB or network. A fake in-memory store implements
 * the AgentsStore seam, so we exercise the real service logic (upsert, scoping,
 * row → contract mapping) and the pure prompt helper in isolation. Mirrors
 * src/characters.test.ts.
 */

// ---------------------------------------------------------------------------
// Fake in-memory store implementing the DB seam.
// ---------------------------------------------------------------------------

class FakeAgentsStore implements AgentsStore {
  readonly rows: AgentRow[] = [];

  async insertAgent(input: Omit<AgentUpsert, "id">): Promise<AgentRow> {
    const now = new Date();
    const row: AgentRow = {
      id: randomUUID(),
      circleId: input.circleId,
      name: input.name,
      knowledge: input.knowledge,
      voice: input.voice,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.push(row);
    return row;
  }

  async updateAgent(
    input: AgentUpsert & { id: string },
  ): Promise<AgentRow | null> {
    const row = this.rows.find(
      (r) => r.id === input.id && r.circleId === input.circleId,
    );
    if (!row) return null;
    row.name = input.name;
    row.knowledge = input.knowledge;
    row.voice = input.voice;
    row.updatedAt = new Date(row.updatedAt.getTime() + 1000); // bump
    return row;
  }

  async findAgent(circleId: string, id: string): Promise<AgentRow | null> {
    return this.rows.find((r) => r.id === id && r.circleId === circleId) ?? null;
  }

  async listAgents(circleId: string): Promise<AgentRow[]> {
    return this.rows.filter((r) => r.circleId === circleId);
  }

  async deleteAgent(input: { id: string; circleId: string }): Promise<boolean> {
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

const REQ: SaveAgentRequest = saveAgentRequestSchema.parse({
  name: "The Oracle",
  knowledge: "A blind seer who speaks in riddles about the players' fate.",
  voice: "voice-abc",
});

// ---------------------------------------------------------------------------
// Service: upsert (insert vs update), scoping, list, delete, get.
// ---------------------------------------------------------------------------

describe("AgentService — save/upsert", () => {
  it("inserts a new agent (no id) and returns a contract-valid shape", async () => {
    const svc = new AgentService(new FakeAgentsStore());
    const result = await svc.saveAgent(CIRCLE, REQ);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent.name).toBe("The Oracle");
    expect(result.agent.circleId).toBe(CIRCLE);
    expect(result.agent.voice).toBe("voice-abc");
    expect(agentSchema.safeParse(result.agent).success).toBe(true);
  });

  it("updates by id (in the same circle) and bumps updatedAt", async () => {
    const store = new FakeAgentsStore();
    const svc = new AgentService(store);
    const created = await svc.saveAgent(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await svc.saveAgent(CIRCLE, {
      ...REQ,
      id: created.agent.id,
      name: "The Oracle of Bones",
      knowledge: "Now also remembers the fall of the old king.",
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.agent.id).toBe(created.agent.id);
    expect(updated.agent.name).toBe("The Oracle of Bones");
    expect(updated.agent.knowledge).toMatch(/old king/);
    expect(new Date(updated.agent.updatedAt).getTime()).toBeGreaterThan(
      new Date(created.agent.createdAt).getTime(),
    );
    expect(store.rows).toHaveLength(1); // an update, not an insert
  });

  it("treats a stale/foreign id as not-found (no cross-circle write)", async () => {
    const svc = new AgentService(new FakeAgentsStore());
    const created = await svc.saveAgent(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const miss = await svc.saveAgent(OTHER_CIRCLE, {
      ...REQ,
      id: created.agent.id,
    });
    expect(miss.ok).toBe(false);
    if (miss.ok) return;
    expect(miss.error).toBeTruthy();
  });

  it("omits the voice field when not provided", async () => {
    const svc = new AgentService(new FakeAgentsStore());
    const minimal = saveAgentRequestSchema.parse({
      name: "Voiceless",
      knowledge: "Replies as parchment only.",
    });
    const result = await svc.saveAgent(CIRCLE, minimal);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.agent).not.toHaveProperty("voice");
    expect(agentSchema.safeParse(result.agent).success).toBe(true);
  });
});

describe("AgentService — list / get / delete (scoped)", () => {
  it("lists only the circle's agents (oldest first by the fake's insert order)", async () => {
    const svc = new AgentService(new FakeAgentsStore());
    await svc.saveAgent(CIRCLE, { ...REQ, name: "Oracle" });
    await svc.saveAgent(CIRCLE, { ...REQ, name: "Goblin King" });
    await svc.saveAgent(OTHER_CIRCLE, { ...REQ, name: "Stranger" });

    const list = await svc.listAgents(CIRCLE);
    expect(list.map((a) => a.name).sort()).toEqual(["Goblin King", "Oracle"]);
  });

  it("getAgent returns the agent for prompting; null cross-circle", async () => {
    const svc = new AgentService(new FakeAgentsStore());
    const created = await svc.saveAgent(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const got = await svc.getAgent(CIRCLE, created.agent.id);
    expect(got?.name).toBe("The Oracle");
    expect(await svc.getAgent(OTHER_CIRCLE, created.agent.id)).toBeNull();
  });

  it("deletes scoped to the circle", async () => {
    const svc = new AgentService(new FakeAgentsStore());
    const created = await svc.saveAgent(CIRCLE, REQ);
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Wrong circle -> no-op.
    expect(await svc.deleteAgent(OTHER_CIRCLE, created.agent.id)).toBe(false);
    expect(await svc.listAgents(CIRCLE)).toHaveLength(1);

    // Right circle -> removed.
    expect(await svc.deleteAgent(CIRCLE, created.agent.id)).toBe(true);
    expect(await svc.listAgents(CIRCLE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Row -> contract mapping (dates as ISO strings, null voice -> omitted).
// ---------------------------------------------------------------------------

describe("toAgent mapping", () => {
  it("maps a row to the contract shape, ISO dates, omitting a null voice", () => {
    const row: AgentRow = {
      id: randomUUID(),
      circleId: CIRCLE,
      name: "Ghost",
      knowledge: "A restless spirit.",
      voice: null,
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      updatedAt: new Date("2026-01-02T03:04:06.000Z"),
    };
    const a = toAgent(row);
    expect(a.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(a.updatedAt).toBe("2026-01-02T03:04:06.000Z");
    expect(a).not.toHaveProperty("voice");
    expect(agentSchema.safeParse(a).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// agentSystemPrompt (pure) — grounds the LLM in the agent's persona.
// ---------------------------------------------------------------------------

describe("agentSystemPrompt", () => {
  it("embeds the agent name + knowledge and asks for a short, in-character reply", () => {
    const prompt = agentSystemPrompt({
      name: "The Oracle",
      knowledge: "A blind seer who speaks in riddles.",
    });
    expect(prompt).toContain("The Oracle");
    expect(prompt).toContain("blind seer who speaks in riddles");
    expect(prompt.toLowerCase()).toContain("in character");
  });

  it("omits the persona block when knowledge is blank", () => {
    const prompt = agentSystemPrompt({ name: "Nameless", knowledge: "   " });
    expect(prompt).toContain("Nameless");
    expect(prompt).not.toContain("Who you are and what you know");
  });
});
