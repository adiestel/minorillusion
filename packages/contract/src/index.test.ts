import { describe, expect, it } from "vitest";
import {
  ambianceScene,
  audioCue,
  circleSchema,
  deliveredEffectSchema,
  effectSpecSchema,
  hapticPattern,
  joinRequestSchema,
  joinResultSchema,
  messageEffectSchema,
  presenceUpdateSchema,
  sendCueRequestSchema,
  sendEffectRequestSchema,
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

describe("effect vocabulary enums", () => {
  it("accepts known cues / patterns / scenes and rejects unknown ones", () => {
    expect(audioCue.safeParse("thunder").success).toBe(true);
    expect(audioCue.safeParse("kazoo").success).toBe(false);
    expect(hapticPattern.safeParse("heartbeat").success).toBe(true);
    expect(hapticPattern.safeParse("explode").success).toBe(false);
    expect(ambianceScene.safeParse("storm").success).toBe(true);
    expect(ambianceScene.safeParse("blizzard").success).toBe(false);
  });
});

describe("effect specs (what the GM asks for)", () => {
  it("accepts each effect kind", () => {
    const specs = [
      { kind: "message", body: "The door creaks open.", mode: "acknowledge" },
      { kind: "audio", source: { via: "cue", cue: "thunder" } },
      { kind: "audio", source: { via: "tts", text: "You hear a whisper." } },
      { kind: "haptic", pattern: "rumble" },
      { kind: "ambiance", scene: "storm", intensity: 0.8 },
      { kind: "heartbeat", bpm: 72, beats: 8 },
    ];
    for (const s of specs) {
      expect(effectSpecSchema.safeParse(s).success).toBe(true);
    }
  });

  it("rejects an unknown effect kind and out-of-range values", () => {
    expect(effectSpecSchema.safeParse({ kind: "earthquake" }).success).toBe(false);
    expect(
      effectSpecSchema.safeParse({ kind: "heartbeat", bpm: 5 }).success,
    ).toBe(false);
    expect(
      effectSpecSchema.safeParse({ kind: "ambiance", scene: "clear", intensity: 5 })
        .success,
    ).toBe(false);
  });

  it("requires a non-empty TTS text", () => {
    expect(
      effectSpecSchema.safeParse({
        kind: "audio",
        source: { via: "tts", text: "" },
      }).success,
    ).toBe(false);
  });
});

describe("send requests", () => {
  it("validates a single effect:send request with a delay", () => {
    const r = sendEffectRequestSchema.safeParse({
      target: { kind: "broadcast" },
      spec: { kind: "haptic", pattern: "buzz" },
      startDelayMs: 250,
    });
    expect(r.success).toBe(true);
  });

  it("validates a choreographed cue and rejects an empty one", () => {
    const ok = sendCueRequestSchema.safeParse({
      target: { kind: "broadcast" },
      steps: [
        { spec: { kind: "ambiance", scene: "storm" } },
        { spec: { kind: "audio", source: { via: "cue", cue: "thunder" } } },
        { spec: { kind: "haptic", pattern: "rumble" }, startDelayMs: 250 },
      ],
    });
    expect(ok.success).toBe(true);

    const empty = sendCueRequestSchema.safeParse({
      target: { kind: "broadcast" },
      steps: [],
    });
    expect(empty.success).toBe(false);
  });

  it("rejects a negative startDelayMs", () => {
    const r = sendEffectRequestSchema.safeParse({
      target: { kind: "broadcast" },
      spec: { kind: "haptic", pattern: "buzz" },
      startDelayMs: -1,
    });
    expect(r.success).toBe(false);
  });
});

describe("delivered effects (what a player receives)", () => {
  const now = new Date().toISOString();
  const id = () => crypto.randomUUID();

  it("still accepts the M1 message shape (back-compat)", () => {
    const r = messageEffectSchema.safeParse({
      id: id(),
      kind: "message",
      body: "The torches gutter.",
      mode: "acknowledge",
      createdAt: now,
    });
    expect(r.success).toBe(true);
  });

  it("accepts each delivered kind via the union", () => {
    const delivered = [
      { id: id(), kind: "message", body: "Hi", mode: "silent", createdAt: now },
      {
        id: id(),
        kind: "audio",
        source: { via: "cue", cue: "rain" },
        loop: true,
        createdAt: now,
      },
      {
        id: id(),
        kind: "audio",
        source: { via: "data", data: "data:audio/mpeg;base64,AAAA" },
        createdAt: now,
      },
      { id: id(), kind: "haptic", pattern: "double", createdAt: now },
      { id: id(), kind: "ambiance", scene: "clear", createdAt: now },
      { id: id(), kind: "heartbeat", bpm: 60, beats: 8, createdAt: now },
    ];
    for (const d of delivered) {
      expect(deliveredEffectSchema.safeParse(d).success).toBe(true);
    }
  });
});
