import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deliveredEffectSchema,
  type EffectSpec,
  type Target,
} from "@minorillusion/contract";
import {
  buildCue,
  buildEffect,
  classifyEffect,
  resolveTargets,
} from "./effects.js";
import type { TtsProvider } from "./tts.js";

/**
 * Hermetic unit tests for the effect router — no sockets, no DB, no network. We
 * exercise the pure routing decisions (who receives an effect), that a minted
 * effect satisfies the wire contract exactly, and that TTS resolution is driven
 * through an injected provider so no live vendor is ever hit.
 */

// Stable UUIDs for the present roster so target resolution is deterministic.
const vex = randomUUID();
const grog = randomUUID();
const pike = randomUUID();
const present = [vex, grog, pike];

/** A fake provider returning fixed bytes (the "ID3" MP3 tag) — no network. */
const fakeTts: TtsProvider = {
  async synthesize(): Promise<Buffer> {
    return Buffer.from([0x49, 0x44, 0x33]);
  },
};

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
// buildEffect — one minted instance per kind must satisfy the contract schema,
// apply its defaults, and carry an injected startDelayMs through.
// ---------------------------------------------------------------------------

describe("buildEffect", () => {
  it("message: contract-valid, no autoDismissMs when omitted", async () => {
    const spec: EffectSpec = {
      kind: "message",
      body: "The door creaks open.",
      mode: "acknowledge",
    };
    const effect = await buildEffect(spec);
    expect(effect.kind).toBe("message");
    if (effect.kind !== "message") throw new Error("narrowing");
    expect(effect.body).toBe("The door creaks open.");
    expect(effect.mode).toBe("acknowledge");
    expect(effect).not.toHaveProperty("autoDismissMs");
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("message: carries autoDismissMs through for auto_dismiss mode", async () => {
    const spec: EffectSpec = {
      kind: "message",
      body: "A whisper fades.",
      mode: "auto_dismiss",
      autoDismissMs: 5000,
    };
    const effect = await buildEffect(spec);
    if (effect.kind !== "message") throw new Error("narrowing");
    expect(effect.autoDismissMs).toBe(5000);
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("audio (cue): passes the bundled cue through unchanged", async () => {
    const spec: EffectSpec = {
      kind: "audio",
      source: { via: "cue", cue: "thunder" },
      gain: 0.5,
      loop: true,
      label: "storm hit",
    };
    const effect = await buildEffect(spec);
    if (effect.kind !== "audio") throw new Error("narrowing");
    expect(effect.source).toEqual({ via: "cue", cue: "thunder" });
    expect(effect.gain).toBe(0.5);
    expect(effect.loop).toBe(true);
    expect(effect.label).toBe("storm hit");
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("audio (cue): omits gain/loop/label when not supplied", async () => {
    const spec: EffectSpec = {
      kind: "audio",
      source: { via: "cue", cue: "chime" },
    };
    const effect = await buildEffect(spec);
    if (effect.kind !== "audio") throw new Error("narrowing");
    expect(effect).not.toHaveProperty("gain");
    expect(effect).not.toHaveProperty("loop");
    expect(effect).not.toHaveProperty("label");
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("audio (tts): resolves to an inline data: URL via the injected provider", async () => {
    const spec: EffectSpec = {
      kind: "audio",
      source: { via: "tts", text: "Beware the dark.", voice: "narrator" },
    };
    const effect = await buildEffect(spec, { tts: fakeTts });
    if (effect.kind !== "audio") throw new Error("narrowing");
    expect(effect.source.via).toBe("data");
    if (effect.source.via !== "data") throw new Error("narrowing");
    expect(effect.source.data.startsWith("data:audio/mpeg;base64,")).toBe(true);
    // The fake's bytes (0x49 0x44 0x33 = "ID3") round-trip into the data URL.
    expect(effect.source.data).toBe(
      "data:audio/mpeg;base64," + Buffer.from([0x49, 0x44, 0x33]).toString("base64"),
    );
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("haptic: carries the named pattern", async () => {
    const spec: EffectSpec = { kind: "haptic", pattern: "rumble" };
    const effect = await buildEffect(spec);
    if (effect.kind !== "haptic") throw new Error("narrowing");
    expect(effect.pattern).toBe("rumble");
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("ambiance: carries scene, with intensity only when supplied", async () => {
    const withIntensity = await buildEffect({
      kind: "ambiance",
      scene: "storm",
      intensity: 0.8,
    });
    if (withIntensity.kind !== "ambiance") throw new Error("narrowing");
    expect(withIntensity.scene).toBe("storm");
    expect(withIntensity.intensity).toBe(0.8);
    expect(deliveredEffectSchema.safeParse(withIntensity).success).toBe(true);

    const without = await buildEffect({ kind: "ambiance", scene: "clear" });
    expect(without).not.toHaveProperty("intensity");
    expect(deliveredEffectSchema.safeParse(without).success).toBe(true);
  });

  it("heartbeat: applies the 60 bpm / 8 beats defaults when omitted", async () => {
    const effect = await buildEffect({ kind: "heartbeat" });
    if (effect.kind !== "heartbeat") throw new Error("narrowing");
    expect(effect.bpm).toBe(60);
    expect(effect.beats).toBe(8);
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("heartbeat: honors supplied bpm / beats over the defaults", async () => {
    const effect = await buildEffect({ kind: "heartbeat", bpm: 120, beats: 16 });
    if (effect.kind !== "heartbeat") throw new Error("narrowing");
    expect(effect.bpm).toBe(120);
    expect(effect.beats).toBe(16);
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("flash: carries intensity + durationMs + startDelayMs when supplied", async () => {
    const effect = await buildEffect(
      { kind: "flash", intensity: 0.85 },
      { durationMs: 320, startDelayMs: 150 },
    );
    if (effect.kind !== "flash") throw new Error("narrowing");
    expect(effect.intensity).toBe(0.85);
    expect(effect.durationMs).toBe(320);
    expect(effect.startDelayMs).toBe(150);
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("flash: omits intensity / durationMs when not supplied", async () => {
    const effect = await buildEffect({ kind: "flash" });
    if (effect.kind !== "flash") throw new Error("narrowing");
    expect(effect).not.toHaveProperty("intensity");
    expect(effect).not.toHaveProperty("durationMs");
    expect(effect).not.toHaveProperty("startDelayMs");
    expect(deliveredEffectSchema.safeParse(effect).success).toBe(true);
  });

  it("attaches startDelayMs only when supplied", async () => {
    const spec: EffectSpec = { kind: "haptic", pattern: "buzz" };
    const delayed = await buildEffect(spec, { startDelayMs: 750 });
    expect(delayed.startDelayMs).toBe(750);
    expect(deliveredEffectSchema.safeParse(delayed).success).toBe(true);

    const immediate = await buildEffect(spec);
    expect(immediate).not.toHaveProperty("startDelayMs");
  });

  it("mints a fresh UUID id and an ISO createdAt each call", async () => {
    const spec: EffectSpec = {
      kind: "message",
      body: "Roll for initiative.",
      mode: "silent",
    };
    const a = await buildEffect(spec);
    const b = await buildEffect(spec);
    expect(a.id).not.toBe(b.id);
    // Schema enforces uuid id + datetime createdAt; assert it holds.
    expect(deliveredEffectSchema.safeParse(a).success).toBe(true);
    expect(() => new Date(a.createdAt).toISOString()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// buildCue — every step is minted, in order, each carrying its own delay.
// ---------------------------------------------------------------------------

describe("buildCue", () => {
  it("mints one effect per step, in order, with per-step delays", async () => {
    const effects = await buildCue(
      [
        { spec: { kind: "ambiance", scene: "storm" } },
        { spec: { kind: "haptic", pattern: "rumble" }, startDelayMs: 200 },
        {
          spec: { kind: "audio", source: { via: "cue", cue: "thunder" } },
          startDelayMs: 500,
        },
      ],
      { tts: fakeTts },
    );

    expect(effects).toHaveLength(3);
    expect(effects.map((e) => e.kind)).toEqual(["ambiance", "haptic", "audio"]);
    // First step has no delay; the later two carry theirs.
    expect(effects[0]).not.toHaveProperty("startDelayMs");
    expect(effects[1]?.startDelayMs).toBe(200);
    expect(effects[2]?.startDelayMs).toBe(500);
    // Ids are unique and every minted effect satisfies the wire contract.
    const ids = new Set(effects.map((e) => e.id));
    expect(ids.size).toBe(3);
    for (const e of effects) {
      expect(deliveredEffectSchema.safeParse(e).success).toBe(true);
    }
  });

  it("threads the injected TTS provider through a tts step", async () => {
    const effects = await buildCue(
      [{ spec: { kind: "audio", source: { via: "tts", text: "Hello." } } }],
      { tts: fakeTts },
    );
    expect(effects).toHaveLength(1);
    const only = effects[0];
    if (!only || only.kind !== "audio" || only.source.via !== "data") {
      throw new Error("expected a resolved tts audio effect");
    }
    expect(only.source.data.startsWith("data:audio/mpeg;base64,")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyEffect — the pure policy for how a GM-initiated effect appears in the
// active-effects registry (register? sustained? duration? label?). No sockets,
// no timers — just the decision the socket layer then acts on.
// ---------------------------------------------------------------------------

describe("classifyEffect", () => {
  it("audio loop → sustained, registered, cue label", () => {
    expect(
      classifyEffect({
        kind: "audio",
        source: { via: "cue", cue: "rain" },
        loop: true,
      }),
    ).toEqual({ register: true, sustained: true, label: "Rain" });
  });

  it("audio loop → honors an explicit label over the cue label", () => {
    expect(
      classifyEffect({
        kind: "audio",
        source: { via: "cue", cue: "rain" },
        loop: true,
        label: "Downpour",
      }),
    ).toEqual({ register: true, sustained: true, label: "Downpour" });
  });

  it("audio cue thunder → transient, durationMs 5000, label Thunderclap", () => {
    expect(
      classifyEffect({ kind: "audio", source: { via: "cue", cue: "thunder" } }),
    ).toEqual({
      register: true,
      sustained: false,
      durationMs: 5000,
      label: "Thunderclap",
    });
  });

  it("audio cue chime → transient, durationMs 4000, label Chime", () => {
    expect(
      classifyEffect({ kind: "audio", source: { via: "cue", cue: "chime" } }),
    ).toEqual({
      register: true,
      sustained: false,
      durationMs: 4000,
      label: "Chime",
    });
  });

  it("audio cue heartbeat → label is the capitalized cue name", () => {
    expect(
      classifyEffect({ kind: "audio", source: { via: "cue", cue: "heartbeat" } }),
    ).toEqual({
      register: true,
      sustained: false,
      durationMs: 4000,
      label: "Heartbeat",
    });
  });

  it("audio tts → transient, label Speak, duration scales with text length", () => {
    const c = classifyEffect({
      kind: "audio",
      source: { via: "tts", text: "Hi" }, // 2 chars → 1500 + 120 = 1620
    });
    expect(c.register).toBe(true);
    expect(c.sustained).toBe(false);
    expect(c.label).toBe("Speak");
    expect(c.durationMs).toBe(1620);
  });

  it("audio tts → duration is capped at 20000ms for long text", () => {
    const c = classifyEffect({
      kind: "audio",
      source: { via: "tts", text: "x".repeat(600) },
    });
    expect(c.durationMs).toBe(20_000);
  });

  it("ambiance storm → sustained, registered, label Storm", () => {
    expect(classifyEffect({ kind: "ambiance", scene: "storm" })).toEqual({
      register: true,
      sustained: true,
      label: "Storm",
    });
  });

  it("ambiance ember → sustained, registered, label Stir embers", () => {
    expect(classifyEffect({ kind: "ambiance", scene: "ember" })).toEqual({
      register: true,
      sustained: true,
      label: "Stir embers",
    });
  });

  it("ambiance clear → not registered (the socket layer treats it as a stop)", () => {
    expect(classifyEffect({ kind: "ambiance", scene: "clear" })).toEqual({
      register: false,
      sustained: false,
      label: "Calm",
    });
  });

  it("heartbeat → transient, durationMs computed from beats / bpm", () => {
    // defaults: 8 beats at 60 bpm = 8s.
    expect(classifyEffect({ kind: "heartbeat" })).toEqual({
      register: true,
      sustained: false,
      durationMs: 8000,
      label: "Heartbeat",
    });
    // 16 beats at 120 bpm = 8s as well; 4 beats at 60 bpm = 4s.
    expect(classifyEffect({ kind: "heartbeat", bpm: 60, beats: 4 }).durationMs).toBe(
      4000,
    );
  });

  it("message → not registered (never shown in the panel)", () => {
    expect(
      classifyEffect({ kind: "message", body: "hi", mode: "silent" }).register,
    ).toBe(false);
  });

  it("haptic → registered as a brief 2s transient with a pattern label", () => {
    expect(classifyEffect({ kind: "haptic", pattern: "buzz" })).toEqual({
      register: true,
      sustained: false,
      durationMs: 2000,
      label: "Buzz",
    });
    expect(classifyEffect({ kind: "haptic", pattern: "rumble" }).label).toBe("Rumble");
  });

  it("flash → not registered (never shown in the panel)", () => {
    expect(classifyEffect({ kind: "flash", intensity: 0.85 }).register).toBe(false);
  });
});
