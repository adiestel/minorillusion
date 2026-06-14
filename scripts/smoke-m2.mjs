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
const waitUntil = (pred, ms = 4000) =>
  new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      if (pred()) return res();
      if (Date.now() - t0 > ms) return rej(new Error("waitUntil timeout"));
      setTimeout(tick, 50);
    };
    tick();
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

  // --- player viewport → carried to the GM via presence (drives the Stage) ---
  const vpUpdate = waitFor(
    gm,
    "presence:update",
    (u) => u.players.some((p) => p.id === playerId && p.viewport),
  );
  player.emit("player:viewport", { width: 412, height: 915 });
  const vp = await vpUpdate;
  const me = vp.players.find((p) => p.id === playerId);
  check(
    me?.viewport?.width === 412 && me?.viewport?.height === 915,
    "GM presence carries the player's reported viewport (412x915)",
  );

  // --- mixer: GM master effects volume reaches the player ----------------
  const mixerApply = waitFor(player, "mixer:apply", (m) => m.gain === 0.5);
  gm.emit("mixer:set", { gain: 0.5 });
  const mixed = await mixerApply;
  check(mixed.gain === 0.5, "GM mixer:set reaches the player as mixer:apply (0.5)");

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

  // === control rework: active registry, stop → effect:end, storm strikes ===

  // Keep the latest registry snapshot (earlier tests leave sustained effects;
  // the server replaces overlapping ambiances, so match on the new id).
  let latestActive = [];
  gm.on("effects:active", (a) => {
    latestActive = a.effects;
  });

  // Collect mirrored effects pushed to the GM (drives the live Stage view).
  const mirrors = [];
  gm.on("effect:mirror", (m) => mirrors.push(m));

  // A plain effect:send mirrors to the GM with the recipient player id(s).
  const mirrorChime = waitFor(gm, "effect:mirror", (m) => m.effect.kind === "audio" && m.effect.source.cue === "chime");
  await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "audio", source: { via: "cue", cue: "chime" } },
  });
  const chimeMirror = await mirrorChime;
  check(
    chimeMirror.playerIds.includes(playerId),
    "GM received effect:mirror for a sent effect (with the recipient id)",
  );

  // Rain LOOP → appears in effects:active as sustained; player gets the loop.
  let activeP = waitFor(gm, "effects:active", (a) => a.effects.some((e) => e.sustained && e.label === "Rain"));
  const rainDeliver = waitFor(player, "effect:deliver", (e) => e.kind === "audio" && e.source.cue === "rain");
  const rainSend = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "audio", source: { via: "cue", cue: "rain" }, loop: true },
  });
  check(rainSend.ok === true, "rain loop effect:send acked");
  const rainActive = await activeP;
  check(
    rainActive.effects.some((e) => e.id === rainSend.effectId && e.sustained),
    "rain shows in effects:active as a sustained effect",
  );
  await rainDeliver;
  ok("player received the rain loop");

  // Whispers LOOP → a chained bed; delivered as a looping "whispers" audio cue
  // and registered as a sustained "Whispers" effect.
  const whisperActive = waitFor(gm, "effects:active", (a) => a.effects.some((e) => e.sustained && e.label === "Whispers"));
  const whisperDeliver = waitFor(player, "effect:deliver", (e) => e.kind === "audio" && e.source.cue === "whispers" && e.loop === true);
  const whisperSend = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "audio", source: { via: "cue", cue: "whispers" }, loop: true },
  });
  check(whisperSend.ok === true, "whispers loop effect:send acked");
  await whisperDeliver;
  ok("player received the whispers loop (cue=whispers, loop)");
  await whisperActive;
  ok("whispers shows in effects:active as sustained");
  await gm.timeout(5000).emitWithAck("effect:stop", { effectId: whisperSend.effectId });

  // Stop the rain → player gets effect:end; rain leaves the registry.
  const rainEnd = waitFor(player, "effect:end", (i) => i.effectId === rainSend.effectId);
  activeP = waitFor(gm, "effects:active", (a) => !a.effects.some((e) => e.id === rainSend.effectId));
  const stopAck = await gm.timeout(5000).emitWithAck("effect:stop", { effectId: rainSend.effectId });
  check(stopAck.ok === true, "effect:stop acked ok");
  await rainEnd;
  ok("player received effect:end for the stopped rain loop");
  await activeP;
  ok("rain cleared from effects:active");

  // Haptic now shows briefly (a 2s transient) so the GM gets confirmation.
  const buzzSend = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "haptic", pattern: "buzz" },
  });
  await waitUntil(() =>
    latestActive.some(
      (e) => e.id === buzzSend.effectId && e.label === "Buzz" && e.sustained === false && e.durationMs === 2000,
    ),
  );
  ok("haptic (buzz) shows as a brief 2s transient in effects:active");

  // One-shot thunderclap → transient in the registry with a countdown duration.
  activeP = waitFor(gm, "effects:active", (a) =>
    a.effects.some((e) => e.label === "Thunderclap" && e.sustained === false && e.durationMs > 0),
  );
  await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "audio", source: { via: "cue", cue: "thunder" } },
  });
  await activeP;
  ok("one-shot thunderclap shows as transient with a countdown duration");

  // Storm → sustained registry entry + a server-driven strike (flash + clap) soon.
  const flashDeliver = waitFor(player, "effect:deliver", (e) => e.kind === "flash", 4000);
  const stormClap = waitFor(player, "effect:deliver", (e) => e.kind === "audio" && e.source.cue === "thunder", 4000);
  const stormSend = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "ambiance", scene: "storm" },
  });
  check(stormSend.ok === true, "storm effect:send acked");
  await waitUntil(() =>
    latestActive.some((e) => e.id === stormSend.effectId && e.label === "Storm" && e.scene === "storm"),
  );
  ok("storm shows in effects:active as sustained, carrying scene=storm (drives the Stage)");
  await flashDeliver;
  ok("storm runner delivered a lightning flash to the player");
  await stormClap;
  ok("storm runner delivered a (randomly-targeted) thunderclap");
  // The room-wide flash also mirrors to the GM's Stage.
  await waitUntil(() => mirrors.some((m) => m.effect.kind === "flash" && m.playerIds.includes(playerId)));
  ok("GM received an effect:mirror for the storm lightning flash");

  // Switch to Rain → storm is replaced (weather is mutually exclusive, no layering).
  const stormEnded = waitFor(player, "effect:end", (i) => i.effectId === stormSend.effectId);
  const rainSwitch = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "ambiance", scene: "rain" },
  });
  await stormEnded;
  ok("starting Rain ended the Storm (no layered weather)");
  await waitUntil(
    () =>
      latestActive.some((e) => e.id === rainSwitch.effectId && e.label === "Rain") &&
      !latestActive.some((e) => e.id === stormSend.effectId),
  );
  ok("Rain replaced Storm in effects:active");

  // Stop the rain → player clears it via effect:end.
  const rainEnded = waitFor(player, "effect:end", (i) => i.effectId === rainSwitch.effectId);
  await gm.timeout(5000).emitWithAck("effect:stop", { effectId: rainSwitch.effectId });
  await rainEnded;
  ok("rain stopped — player received effect:end");

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

      // Whispers-mode speech carries the spooky-voice flags through to the player.
      const spookyDeliver = waitFor(player, "effect:deliver", (e) => e.kind === "audio" && e.whispers === true, 15000);
      const spooky = await gm.timeout(20000).emitWithAck("effect:send", {
        target: { kind: "broadcast" },
        spec: {
          kind: "audio",
          source: { via: "tts", text: "The walls remember your name." },
          gain: 0.9,
          whispers: true,
          echo: true,
          pan: true,
          whisperGain: 0.4,
        },
      });
      if (spooky.ok) {
        const se = await spookyDeliver;
        check(
          se.whispers === true && se.echo === true && se.pan === true && se.whisperGain === 0.4,
          "whispers-mode speech carries whispers/echo/pan/whisperGain to the player",
        );
      } else {
        bad(`whispers-mode TTS returned an error: ${spooky.error}`);
      }
    } else {
      bad(`TTS effect:send returned an error: ${tts.error}`);
    }
  } else {
    console.log("  skip — TTS path (set SMOKE_TTS=1 to exercise the live ElevenLabs API)");
  }

  // === player management: rename + remove (a throwaway player) =============
  const p2 = conn();
  await onConnect(p2, "player2");
  const j2 = await p2
    .timeout(5000)
    .emitWithAck("circle:join", { code, name: "Temp", deviceId: "smoke-m2-dev2" });
  const p2id = j2.ok ? j2.player.id : "";

  // rename → ack carries the new name + presence reflects it.
  const renamePresence = waitFor(gm, "presence:update", (u) =>
    u.players.some((p) => p.id === p2id && p.name === "Renamed"),
  );
  const renameAck = await gm.timeout(5000).emitWithAck("player:rename", { playerId: p2id, name: "Renamed" });
  check(renameAck.ok === true && renameAck.player.name === "Renamed", "player:rename acked with the new name");
  await renamePresence;
  ok("rename reflected in presence");

  // remove → the player is ejected and drops out of presence.
  const ejected = waitFor(p2, "circle:ejected");
  const removePresence = waitFor(gm, "presence:update", (u) => !u.players.some((p) => p.id === p2id));
  const removeAck = await gm.timeout(5000).emitWithAck("player:remove", { playerId: p2id });
  check(removeAck.ok === true, "player:remove acked ok");
  await ejected;
  ok("removed player received circle:ejected");
  await removePresence;
  ok("removed player gone from presence");
  p2.close();

  // === reconnect race: an OLD socket dropping AFTER a same-device rejoin must
  //     NOT mark the player offline ("ghost offline" presence flicker) ========
  const rcA = conn();
  await onConnect(rcA, "reconnectA");
  const rj1 = await rcA
    .timeout(5000)
    .emitWithAck("circle:join", { code, name: "Echo", deviceId: "smoke-reconnect-dev" });
  const rcId = rj1.ok ? rj1.player.id : "";
  // The same device joins again on a fresh socket (what a reconnect does).
  const rcB = conn();
  await onConnect(rcB, "reconnectB");
  const rj2 = await rcB
    .timeout(5000)
    .emitWithAck("circle:join", { code, name: "Echo", deviceId: "smoke-reconnect-dev" });
  check(rj2.ok === true && rj2.player.id === rcId, "same-device rejoin maps to the same player id");
  // Drop the OLD socket; the player must stay connected (newer socket holds it).
  rcA.disconnect();
  await new Promise((r) => setTimeout(r, 350));
  const reopened = await gm.timeout(5000).emitWithAck("circle:open", { code });
  const echo = reopened.ok ? reopened.players.find((p) => p.id === rcId) : undefined;
  check(echo?.connected === true, "old socket dropping after a same-device rejoin keeps the player connected");
  // Clean up: remove the throwaway reconnect player.
  await gm.timeout(5000).emitWithAck("player:remove", { playerId: rcId });
  rcB.close();

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE M2: FAILED" : "\nSMOKE M2: PASSED");
process.exit(failed ? 1 : 0);
