import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  messageEffectSchema,
  type SendMessageRequest,
  type Target,
} from "@minorillusion/contract";
import { buildMessageEffect, resolveTargets } from "./effects.js";

/**
 * Hermetic unit tests for the effect router — no sockets, no DB. We exercise
 * the pure routing decisions (who receives an effect) and that a minted effect
 * satisfies the wire contract exactly.
 */

// Stable UUIDs for the present roster so target resolution is deterministic.
const vex = randomUUID();
const grog = randomUUID();
const pike = randomUUID();
const present = [vex, grog, pike];

// ---------------------------------------------------------------------------
// resolveTargets — broadcast vs. specific players (the router's core decision).
// ---------------------------------------------------------------------------

describe("resolveTargets", () => {
  it("broadcast resolves to every present player", () => {
    const target: Target = { kind: "broadcast" };
    expect(resolveTargets(target, present)).toEqual([vex, grog, pike]);
  });

  it("broadcast with no one present resolves to nobody", () => {
    expect(resolveTargets({ kind: "broadcast" }, [])).toEqual([]);
  });

  it("players resolves to the intersection of requested and present", () => {
    const target: Target = { kind: "players", playerIds: [vex, pike] };
    expect(resolveTargets(target, present)).toEqual([vex, pike]);
  });

  it("drops a requested id that is NOT present", () => {
    const absent = randomUUID();
    const target: Target = { kind: "players", playerIds: [vex, absent] };
    const resolved = resolveTargets(target, present);
    expect(resolved).toEqual([vex]);
    expect(resolved).not.toContain(absent);
  });

  it("resolves to nobody when none of the requested are present", () => {
    const target: Target = {
      kind: "players",
      playerIds: [randomUUID(), randomUUID()],
    };
    expect(resolveTargets(target, present)).toEqual([]);
  });

  it("does not mutate the present roster it is given", () => {
    const roster = [...present];
    resolveTargets({ kind: "broadcast" }, roster);
    resolveTargets({ kind: "players", playerIds: [vex] }, roster);
    expect(roster).toEqual(present);
  });
});

// ---------------------------------------------------------------------------
// buildMessageEffect — the minted instance must satisfy the contract schema.
// ---------------------------------------------------------------------------

describe("buildMessageEffect", () => {
  it("produces a contract-valid message effect (no autoDismissMs)", () => {
    const req: SendMessageRequest = {
      target: { kind: "broadcast" },
      body: "The door creaks open.",
      mode: "acknowledge",
    };
    const effect = buildMessageEffect(req);
    expect(effect.kind).toBe("message");
    expect(effect.body).toBe(req.body);
    expect(effect.mode).toBe("acknowledge");
    expect(effect).not.toHaveProperty("autoDismissMs");
    expect(messageEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("carries autoDismissMs through for auto_dismiss mode", () => {
    const req: SendMessageRequest = {
      target: { kind: "players", playerIds: [vex] },
      body: "A whisper fades.",
      mode: "auto_dismiss",
      autoDismissMs: 5000,
    };
    const effect = buildMessageEffect(req);
    expect(effect.autoDismissMs).toBe(5000);
    expect(messageEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("mints a fresh UUID id and an ISO createdAt each call", () => {
    const req: SendMessageRequest = {
      target: { kind: "broadcast" },
      body: "Roll for initiative.",
      mode: "silent",
    };
    const a = buildMessageEffect(req);
    const b = buildMessageEffect(req);
    expect(a.id).not.toBe(b.id);
    // Schema enforces uuid id + datetime createdAt; assert it holds.
    expect(messageEffectSchema.safeParse(a).success).toBe(true);
    expect(() => new Date(a.createdAt).toISOString()).not.toThrow();
  });
});
