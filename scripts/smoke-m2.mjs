/**
 * M2 end-to-end smoke test — the generalized effect engine over the wire:
 * GM fires audio / haptic / ambiance / heartbeat single effects + a choreographed
 * storm *cue*, and the joined player receives each as a typed effect:deliver of the
 * right kind (with server-stamped defaults + per-step startDelayMs). Requires
 * Postgres up and the server listening on :3001.
 *
 *   pnpm smoke:m2                 (core effects + cue; no external API)
 *   SMOKE_TTS=1 pnpm smoke:m2     (also exercises the live ElevenLabs TTS path)
 */
import { io } from "socket.io-client";

const URL = process.env.SMOKE_URL ?? "http://localhost:3001";
let failed = false;
const ok = (m) => console.log("  ok   —", m);
const bad = (m) => {
  failed = true;
  console.error("  FAIL —", m);
};
const check = (cond, m) => (cond ? ok(m) : bad(m));

const conn = () => io(URL, { transports: ["websocket"], reconnection: false });
const onConnect = (s, who) =>
  new Promise((res, rej) => {
    s.on("connect", res);
    s.on("connect_error", (e) => rej(new Error(`${who}: ${e.message}`)));
    setTimeout(() => rej(new Error(`${who} connect timeout`)), 5000);
  });
const waitFor = (s, ev, pred, ms = 3000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout waiting for ${ev}`)), ms);
    const h = (p) => {
      if (!pred || pred(p)) {
        clearTimeout(t);
        s.off(ev, h);
        res(p);
      }
    };
    s.on(ev, h);
  });

try {
  const gm = conn();
  await onConnect(gm, "GM");
  const create = await gm.timeout(5000).emitWithAck("circle:create", {});
  const code = create.circle.code;
  ok(`circle created (${code})`);

  const player = conn();
  await onConnect(player, "player");
  const join = await player
    .timeout(5000)
    .emitWithAck("circle:join", { code, name: "Bram", deviceId: "smoke-m2-dev" });
  check(join.ok === true, "player joined");
  const playerId = join.ok ? join.player.id : "";

  // --- audio cue (thunder), broadcast ------------------------------------
  let deliver = waitFor(player, "effect:deliver", (e) => e.kind === "audio");
  let send = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "audio", source: { via: "cue", cue: "thunder" } },
  });
  check(send.ok === true && send.deliveredTo >= 1, "audio effect:send acked (deliveredTo >= 1)");
  let eff = await deliver;
  check(
    eff.kind === "audio" && eff.source.via === "cue" && eff.source.cue === "thunder",
    "player received the audio cue (thunder)",
  );

  // --- haptic (buzz) ------------------------------------------------------
  deliver = waitFor(player, "effect:deliver", (e) => e.kind === "haptic");
  await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "haptic", pattern: "buzz" },
  });
  eff = await deliver;
  check(eff.kind === "haptic" && eff.pattern === "buzz", "player received the haptic (buzz)");

  // --- ambiance (storm) ---------------------------------------------------
  deliver = waitFor(player, "effect:deliver", (e) => e.kind === "ambiance");
  await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "ambiance", scene: "storm", intensity: 0.8 },
  });
  eff = await deliver;
  check(eff.kind === "ambiance" && eff.scene === "storm", "player received the ambiance (storm)");

  // --- heartbeat with explicit + defaulted params -------------------------
  deliver = waitFor(player, "effect:deliver", (e) => e.kind === "heartbeat");
  await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "heartbeat", bpm: 72, beats: 8 },
  });
  eff = await deliver;
  check(eff.kind === "heartbeat" && eff.bpm === 72 && eff.beats === 8, "player received the heartbeat (72/8)");

  deliver = waitFor(player, "effect:deliver", (e) => e.kind === "heartbeat");
  await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "heartbeat" }, // no bpm/beats → server defaults
  });
  eff = await deliver;
  check(eff.bpm === 60 && eff.beats === 8, "server applied heartbeat defaults (60/8)");

  // --- choreographed storm cue (3 steps) ----------------------------------
  const collected = [];
  const collector = (e) => collected.push(e);
  player.on("effect:deliver", collector);
  const cue = await gm.timeout(5000).emitWithAck("effect:cue", {
    target: { kind: "broadcast" },
    steps: [
      { spec: { kind: "ambiance", scene: "storm" } },
      { spec: { kind: "audio", source: { via: "cue", cue: "thunder" } }, startDelayMs: 300 },
      { spec: { kind: "haptic", pattern: "rumble" }, startDelayMs: 300 },
    ],
  });
  check(cue.ok === true && cue.effectIds.length === 3, "cue acked with 3 effect ids");
  await new Promise((r) => setTimeout(r, 500));
  player.off("effect:deliver", collector);
  const kinds = collected.map((e) => e.kind).sort();
  check(
    collected.length === 3 && kinds.join(",") === "ambiance,audio,haptic",
    "player received all 3 cue steps (ambiance, audio, haptic)",
  );
  const delayed = collected.filter((e) => e.startDelayMs === 300);
  check(delayed.length === 2, "cue carried per-step startDelayMs (2 steps @ 300ms)");

  // --- targeted delivery --------------------------------------------------
  deliver = waitFor(player, "effect:deliver", (e) => e.kind === "audio" && e.source.cue === "chime");
  const targeted = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "players", playerIds: [playerId] },
    spec: { kind: "audio", source: { via: "cue", cue: "chime" } },
  });
  check(targeted.ok === true && targeted.deliveredTo === 1, "targeted audio delivered to exactly 1");
  await deliver;
  ok("player received the targeted chime");

  // --- TTS (live ElevenLabs) — opt-in via SMOKE_TTS=1 ---------------------
  if (process.env.SMOKE_TTS === "1") {
    deliver = waitFor(player, "effect:deliver", (e) => e.kind === "audio" && e.source.via === "data", 15000);
    const tts = await gm.timeout(20000).emitWithAck("effect:send", {
      target: { kind: "broadcast" },
      spec: { kind: "audio", source: { via: "tts", text: "The cavern echoes with your footsteps." } },
    });
    if (tts.ok) {
      eff = await deliver;
      check(
        eff.kind === "audio" && eff.source.via === "data" && eff.source.data.startsWith("data:audio/mpeg"),
        "TTS synthesized to an inline data: audio effect",
      );
    } else {
      bad(`TTS effect:send returned an error: ${tts.error}`);
    }
  } else {
    console.log("  skip — TTS path (set SMOKE_TTS=1 to exercise the live ElevenLabs API)");
  }

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE M2: FAILED" : "\nSMOKE M2: PASSED");
process.exit(failed ? 1 : 0);
