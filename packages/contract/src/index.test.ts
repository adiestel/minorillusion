import { describe, expect, it } from "vitest";
import {
  circleSchema,
  joinRequestSchema,
  joinResultSchema,
  presenceUpdateSchema,
  sixDigitCode,
} from "./index.js";

describe("contract schemas", () => {
  it("accepts a valid 6-digit code", () => {
    expect(sixDigitCode.safeParse("402913").success).toBe(true);
    expect(sixDigitCode.safeParse("000000").success).toBe(true);
  });

  it("rejects malformed codes", () => {
    expect(sixDigitCode.safeParse("12345").success).toBe(false);
    expect(sixDigitCode.safeParse("1234567").success).toBe(false);
    expect(sixDigitCode.safeParse("abcdef").success).toBe(false);
  });

  it("validates a well-formed join request", () => {
    const r = joinRequestSchema.safeParse({
      code: "402913",
      name: "Aria",
      deviceId: "device-1",
    });
    expect(r.success).toBe(true);
  });

  it("rejects a join with an empty name", () => {
    const r = joinRequestSchema.safeParse({
      code: "402913",
      name: "",
      deviceId: "device-1",
    });
    expect(r.success).toBe(false);
  });

  it("parses a successful join result", () => {
    const now = new Date().toISOString();
    const r = joinResultSchema.safeParse({
      ok: true,
      circle: { id: crypto.randomUUID(), code: "402913", name: null, createdAt: now },
      player: {
        id: crypto.randomUUID(),
        circleId: crypto.randomUUID(),
        name: "Aria",
        connected: true,
        joinedAt: now,
      },
    });
    expect(r.success).toBe(true);
  });

  it("validates a presence update", () => {
    const r = presenceUpdateSchema.safeParse({
      circleId: crypto.randomUUID(),
      players: [],
    });
    expect(r.success).toBe(true);
  });

  it("requires a non-null circle id to be a uuid", () => {
    const bad = circleSchema.safeParse({
      id: "not-a-uuid",
      code: "402913",
      name: null,
      createdAt: new Date().toISOString(),
    });
    expect(bad.success).toBe(false);
  });
});
