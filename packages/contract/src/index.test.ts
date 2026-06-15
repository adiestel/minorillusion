import { describe, expect, it } from "vitest";
import {
  abilityModifier,
  activeEffectSchema,
  ambianceScene,
  AUDIO_CUE_DURATION_MS,
  audioCue,
  channelMessageSchema,
  characterSchema,
  circleSchema,
  deliveredEffectSchema,
  effectMirrorSchema,
  effectSpecSchema,
  hapticPattern,
  initiativeStateSchema,
  joinRequestSchema,
  joinResultSchema,
  messageEffectSchema,
  presenceUpdateSchema,
  agentSchema,
  promptAgentRequestSchema,
  proficiencyForLevel,
  rollRequestSchema,
  rollResultSchema,
  saveAgentRequestSchema,
  summarizeRequestSchema,
  transcriptChunkRequestSchema,
  transcriptEntrySchema,
  transcriptStateSchema,
  sendCueRequestSchema,
  sendEffectRequestSchema,
  sendMessageResultSchema,
  sendTextRequestSchema,
  sendVoiceRequestSchema,
  sixDigitCode,
  skill,
  SKILL_ABILITY,
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

  it("accepts a player carrying a live viewport (and rejects a bad one)", () => {
    const now = new Date().toISOString();
    const base = {
      id: crypto.randomUUID(),
      circleId: crypto.randomUUID(),
      name: "Aria",
      connected: true,
      joinedAt: now,
    };
    expect(
      presenceUpdateSchema.safeParse({
        circleId: crypto.randomUUID(),
        players: [{ ...base, viewport: { width: 390, height: 844 } }],
      }).success,
    ).toBe(true);
    // A zero/negative dimension is rejected.
    expect(
      presenceUpdateSchema.safeParse({
        circleId: crypto.randomUUID(),
        players: [{ ...base, viewport: { width: 0, height: 844 } }],
      }).success,
    ).toBe(false);
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

  it("accepts the spooky-voice treatment on a spoken audio spec", () => {
    expect(
      effectSpecSchema.safeParse({
        kind: "audio",
        source: { via: "tts", text: "Come closer…" },
        gain: 0.9,
        whispers: true,
        echo: true,
        pan: true,
        whisperGain: 0.4,
      }).success,
    ).toBe(true);
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

describe("active-effects control rework", () => {
  const now = new Date().toISOString();

  it("accepts a flash spec and delivered flash", () => {
    expect(effectSpecSchema.safeParse({ kind: "flash", intensity: 0.9 }).success).toBe(true);
    expect(
      deliveredEffectSchema.safeParse({
        id: crypto.randomUUID(),
        kind: "flash",
        intensity: 0.9,
        durationMs: 320,
        createdAt: now,
      }).success,
    ).toBe(true);
  });

  it("validates sustained + transient active-effect records", () => {
    const sustained = activeEffectSchema.safeParse({
      id: crypto.randomUUID(),
      kind: "ambiance",
      label: "Storm",
      target: { kind: "broadcast" },
      sustained: true,
      startedAt: now,
    });
    expect(sustained.success).toBe(true);

    const transient = activeEffectSchema.safeParse({
      id: crypto.randomUUID(),
      kind: "audio",
      label: "Thunderclap",
      target: { kind: "players", playerIds: [crypto.randomUUID()] },
      sustained: false,
      startedAt: now,
      durationMs: 5000,
    });
    expect(transient.success).toBe(true);
  });

  it("exposes a duration for each one-shot cue (rain loops → 0)", () => {
    expect(AUDIO_CUE_DURATION_MS.thunder).toBeGreaterThan(0);
    expect(AUDIO_CUE_DURATION_MS.chime).toBeGreaterThan(0);
    expect(AUDIO_CUE_DURATION_MS.rain).toBe(0);
  });

  it("carries an ambiance scene on an active record (drives the GM Stage)", () => {
    const r = activeEffectSchema.safeParse({
      id: crypto.randomUUID(),
      kind: "ambiance",
      label: "Storm",
      target: { kind: "broadcast" },
      sustained: true,
      startedAt: now,
      scene: "storm",
    });
    expect(r.success).toBe(true);
    // A non-scene (bad enum) is rejected.
    expect(
      activeEffectSchema.safeParse({
        id: crypto.randomUUID(),
        kind: "ambiance",
        label: "Blizzard",
        target: { kind: "broadcast" },
        sustained: true,
        startedAt: now,
        scene: "blizzard",
      }).success,
    ).toBe(false);
  });
});

describe("effect mirror (GM Stage live view)", () => {
  const now = new Date().toISOString();

  it("validates a mirrored flash with its recipient ids", () => {
    const r = effectMirrorSchema.safeParse({
      playerIds: [crypto.randomUUID(), crypto.randomUUID()],
      effect: {
        id: crypto.randomUUID(),
        kind: "flash",
        intensity: 0.85,
        durationMs: 320,
        createdAt: now,
      },
    });
    expect(r.success).toBe(true);
  });

  it("rejects a mirror whose recipient ids are not uuids", () => {
    const r = effectMirrorSchema.safeParse({
      playerIds: ["not-a-uuid"],
      effect: { id: crypto.randomUUID(), kind: "haptic", pattern: "buzz", createdAt: now },
    });
    expect(r.success).toBe(false);
  });
});

describe("player voice/text plane (M3)", () => {
  const now = new Date().toISOString();

  it("validates a typed (quill) text request and rejects an empty one", () => {
    expect(sendTextRequestSchema.safeParse({ text: "I search the door." }).success).toBe(true);
    expect(sendTextRequestSchema.safeParse({ text: "" }).success).toBe(false);
  });

  it("validates a voice request (data: URL) and rejects a missing clip", () => {
    expect(
      sendVoiceRequestSchema.safeParse({
        audio: "data:audio/webm;base64,AAAA",
        mimeType: "audio/webm",
        durationMs: 2400,
      }).success,
    ).toBe(true);
    // No audio payload → rejected.
    expect(sendVoiceRequestSchema.safeParse({ audio: "" }).success).toBe(false);
  });

  it("accepts a text and a voice ChannelMessage", () => {
    const base = {
      id: crypto.randomUUID(),
      circleId: crypto.randomUUID(),
      from: crypto.randomUUID(),
      fromName: "Bram",
      createdAt: now,
    };
    expect(
      channelMessageSchema.safeParse({ ...base, via: "text", text: "Hello GM" }).success,
    ).toBe(true);
    expect(
      channelMessageSchema.safeParse({
        ...base,
        via: "voice",
        text: "the transcript",
        audio: "data:audio/webm;base64,AAAA",
      }).success,
    ).toBe(true);
    // An unknown `via` is rejected (closed set).
    expect(
      channelMessageSchema.safeParse({ ...base, via: "telepathy", text: "x" }).success,
    ).toBe(false);
  });

  it("parses a send-message result (ok carries the message; error carries a string)", () => {
    const okR = sendMessageResultSchema.safeParse({
      ok: true,
      message: {
        id: crypto.randomUUID(),
        circleId: crypto.randomUUID(),
        from: crypto.randomUUID(),
        fromName: "Bram",
        via: "text",
        text: "Hello",
        createdAt: now,
      },
    });
    expect(okR.success).toBe(true);
    expect(
      sendMessageResultSchema.safeParse({ ok: false, error: "STT unavailable" }).success,
    ).toBe(true);
  });
});

describe("D&D layer (M5)", () => {
  const now = new Date().toISOString();

  it("computes ability modifiers (floor((score-10)/2))", () => {
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(11)).toBe(0);
    expect(abilityModifier(12)).toBe(1);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(20)).toBe(5);
    expect(abilityModifier(1)).toBe(-5);
  });

  it("computes proficiency bonus by level (+2 at 1–4, +3 at 5–8, … +6 at 17–20)", () => {
    expect(proficiencyForLevel(1)).toBe(2);
    expect(proficiencyForLevel(4)).toBe(2);
    expect(proficiencyForLevel(5)).toBe(3);
    expect(proficiencyForLevel(9)).toBe(4);
    expect(proficiencyForLevel(13)).toBe(5);
    expect(proficiencyForLevel(20)).toBe(6);
  });

  it("maps every skill to a governing ability", () => {
    for (const s of skill.options) {
      expect(SKILL_ABILITY[s]).toBeDefined();
    }
    expect(SKILL_ABILITY.stealth).toBe("dex");
    expect(SKILL_ABILITY.perception).toBe("wis");
    expect(SKILL_ABILITY.persuasion).toBe("cha");
  });

  it("validates a character sheet and rejects an out-of-range score", () => {
    const base = {
      id: crypto.randomUUID(),
      circleId: crypto.randomUUID(),
      name: "Bram",
      level: 5,
      abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
      skillProficiencies: ["stealth", "perception"],
      saveProficiencies: ["dex", "con"],
      source: "manual",
      createdAt: now,
      updatedAt: now,
    };
    expect(characterSchema.safeParse(base).success).toBe(true);
    expect(
      characterSchema.safeParse({ ...base, abilities: { ...base.abilities, str: 99 } }).success,
    ).toBe(false);
  });

  it("validates derived + raw roll requests and rejects an unknown kind", () => {
    expect(
      rollRequestSchema.safeParse({ spec: { kind: "save", ability: "dex" }, characterId: crypto.randomUUID() }).success,
    ).toBe(true);
    expect(
      rollRequestSchema.safeParse({ spec: { kind: "skill", skill: "stealth" }, mode: "advantage" }).success,
    ).toBe(true);
    expect(
      rollRequestSchema.safeParse({ spec: { kind: "raw", count: 2, sides: 6, modifier: 3 } }).success,
    ).toBe(true);
    // d7 isn't a real die.
    expect(
      rollRequestSchema.safeParse({ spec: { kind: "raw", count: 1, sides: 7, modifier: 0 } }).success,
    ).toBe(false);
    expect(rollRequestSchema.safeParse({ spec: { kind: "bogus" } }).success).toBe(false);
  });

  it("validates a resolved roll result", () => {
    const r = rollResultSchema.safeParse({
      id: crypto.randomUUID(),
      label: "Dexterity Save",
      characterName: "Bram",
      sides: 20,
      dice: [17, 4],
      kept: 17,
      modifier: 5,
      total: 22,
      mode: "advantage",
      crit: false,
      fumble: false,
      createdAt: now,
    });
    expect(r.success).toBe(true);
  });

  it("validates initiative state with a turn cursor", () => {
    const r = initiativeStateSchema.safeParse({
      circleId: crypto.randomUUID(),
      round: 1,
      turnIndex: 0,
      entries: [
        { id: crypto.randomUUID(), name: "Bram", initiative: 18 },
        { id: crypto.randomUUID(), name: "Goblin", initiative: 12, hp: 7, maxHp: 7 },
      ],
    });
    expect(r.success).toBe(true);
    // turnIndex -1 (not started) is allowed; -2 is not.
    expect(
      initiativeStateSchema.safeParse({ circleId: crypto.randomUUID(), round: 0, turnIndex: -2, entries: [] }).success,
    ).toBe(false);
  });
});

describe("intelligence layer (M6)", () => {
  const now = new Date().toISOString();

  it("validates a transcript entry + state and rejects a bad source", () => {
    const entry = {
      id: crypto.randomUUID(),
      circleId: crypto.randomUUID(),
      at: now,
      text: "The door creaks open.",
      source: "capture",
    };
    expect(transcriptEntrySchema.safeParse(entry).success).toBe(true);
    expect(transcriptEntrySchema.safeParse({ ...entry, source: "telepathy" }).success).toBe(false);
    expect(
      transcriptStateSchema.safeParse({ circleId: crypto.randomUUID(), recording: true, entries: [entry] }).success,
    ).toBe(true);
  });

  it("validates a captured audio chunk + a summarize request", () => {
    expect(
      transcriptChunkRequestSchema.safeParse({ audio: "data:audio/webm;base64,AAAA", mimeType: "audio/webm" }).success,
    ).toBe(true);
    expect(transcriptChunkRequestSchema.safeParse({ audio: "" }).success).toBe(false);
    expect(summarizeRequestSchema.safeParse({ style: "dramatic" }).success).toBe(true);
    // default style applies when omitted.
    const parsed = summarizeRequestSchema.parse({});
    expect(parsed.style).toBe("recap");
  });

  it("validates an agent + a prompt request", () => {
    const agent = {
      id: crypto.randomUUID(),
      circleId: crypto.randomUUID(),
      name: "The Oracle",
      knowledge: "Speaks in riddles; knows the fate of the party.",
      voice: "voice-id",
      createdAt: now,
      updatedAt: now,
    };
    expect(agentSchema.safeParse(agent).success).toBe(true);
    expect(saveAgentRequestSchema.safeParse({ name: "The Oracle", knowledge: "x" }).success).toBe(true);
    expect(
      promptAgentRequestSchema.safeParse({
        agentId: crypto.randomUUID(),
        prompt: "What awaits us in the crypt?",
        deliverAs: "voice",
        target: { kind: "broadcast" },
      }).success,
    ).toBe(true);
    // an empty prompt is rejected.
    expect(
      promptAgentRequestSchema.safeParse({ agentId: crypto.randomUUID(), prompt: "", target: { kind: "broadcast" } }).success,
    ).toBe(false);
  });
});
