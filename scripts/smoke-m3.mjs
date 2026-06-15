/**
 * M3 end-to-end smoke test — the player voice/text plane (the inverse path):
 * a joined player speaks back to the GM. The quill sends `channel:text`; the
 * crystal ball sends `channel:voice` (a recorded clip the server transcribes via
 * STT). Both surface to the GM as `channel:message`, and the GM replies with any
 * effect targeted at the sender — closing the loop. Requires Postgres up and the
 * server listening on :3001.
 *
 *   pnpm smoke:m3                                  (text round-trip + voice wiring)
 *   SMOKE_STT=1 SMOKE_STT_CLIP=/path/clip.webm \
 *     pnpm smoke:m3                                (also exercises live ElevenLabs Scribe)
 */
import { io } from "socket.io-client";
import { readFileSync } from "node:fs";

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
    .emitWithAck("circle:join", { code, name: "Bram", deviceId: "smoke-m3-dev" });
  check(join.ok === true, "player joined");
  const playerId = join.ok ? join.player.id : "";

  // === TEXT (the quill): player → GM ======================================
  const inbox = [];
  gm.on("channel:message", (m) => inbox.push(m));

  const textArrival = waitFor(gm, "channel:message", (m) => m.via === "text");
  const sent = await player
    .timeout(5000)
    .emitWithAck("channel:text", { text: "I search the door." });
  check(
    sent.ok === true &&
      sent.message.via === "text" &&
      sent.message.text === "I search the door." &&
      sent.message.from === playerId,
    "channel:text acked with the stored message (from, via, text)",
  );
  const got = await textArrival;
  check(
    got.from === playerId &&
      got.fromName === "Bram" &&
      got.text === "I search the door." &&
      got.via === "text" &&
      typeof got.createdAt === "string",
    "GM received the player's text as channel:message (from, fromName, text)",
  );

  // === GM REPLY closes the loop: any effect targeted at the sender =========
  const reply = waitFor(player, "effect:deliver", (e) => e.kind === "message");
  const replySend = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "players", playerIds: [got.from] },
    spec: { kind: "message", body: "The door is locked.", mode: "auto_dismiss", autoDismissMs: 6000 },
  });
  check(
    replySend.ok === true && replySend.deliveredTo === 1,
    "GM reply effect:send acked (delivered to the sender)",
  );
  const replyEff = await reply;
  check(
    replyEff.kind === "message" && replyEff.body === "The door is locked.",
    "player received the GM's reply effect (loop closed)",
  );

  // === GUARDS: only a joined player may speak back (GM/voice rejected) =====
  const gmTry = await gm
    .timeout(5000)
    .emitWithAck("channel:text", { text: "a GM is not a player" });
  check(gmTry.ok === false, "channel:text from a GM is rejected (player-only)");

  const emptyText = await player.timeout(5000).emitWithAck("channel:text", { text: "" });
  check(emptyText.ok === false, "channel:text with an empty body is rejected");

  // === VOICE wiring (offline): a malformed clip fails cleanly, no network ==
  const badVoice = await player
    .timeout(5000)
    .emitWithAck("channel:voice", { audio: "not-a-data-url" });
  check(
    badVoice.ok === false,
    "channel:voice with a malformed data URL is rejected cleanly (decoded before STT)",
  );

  const gmVoice = await gm
    .timeout(5000)
    .emitWithAck("channel:voice", { audio: "data:audio/webm;base64,AAAA" });
  check(gmVoice.ok === false, "channel:voice from a GM is rejected (player-only)");

  // === LIVE STT (opt-in): SMOKE_STT=1 + SMOKE_STT_CLIP=/path/to/clip =======
  const clipPath = process.env.SMOKE_STT_CLIP;
  if (process.env.SMOKE_STT === "1" && clipPath) {
    const bytes = readFileSync(clipPath);
    const mime = clipPath.endsWith(".mp3")
      ? "audio/mpeg"
      : clipPath.endsWith(".wav")
        ? "audio/wav"
        : clipPath.endsWith(".m4a") || clipPath.endsWith(".mp4")
          ? "audio/mp4"
          : "audio/webm";
    const dataUrl = `data:${mime};base64,` + bytes.toString("base64");
    const voiceArrival = waitFor(gm, "channel:message", (m) => m.via === "voice", 30000);
    const v = await player
      .timeout(30000)
      .emitWithAck("channel:voice", { audio: dataUrl, mimeType: mime });
    check(
      v.ok === true && typeof v.message.text === "string" && v.message.text.length > 0,
      `live STT transcribed a real clip → "${v.ok ? v.message.text : v.error}"`,
    );
    if (v.ok) {
      const vm = await voiceArrival;
      check(
        vm.via === "voice" && vm.from === playerId && typeof vm.audio === "string",
        "GM received the voice message (transcript + clip echoed for playback)",
      );
    }
  } else {
    console.log(
      "  skip — live STT path (set SMOKE_STT=1 and SMOKE_STT_CLIP=/path/to/clip to exercise ElevenLabs Scribe)",
    );
  }

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE M3: FAILED" : "\nSMOKE M3: PASSED");
process.exit(failed ? 1 : 0);
