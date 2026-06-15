/**
 * M7 end-to-end smoke test — session-end chronicle delivery + player log history
 * (D9: players own a persistent history of session logs). Requires Postgres up
 * and the server on :3001.
 *
 *   pnpm smoke:m7
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
  const code = (await gm.timeout(5000).emitWithAck("circle:create", {})).circle.code;
  ok(`circle created (${code})`);

  const player = conn();
  await onConnect(player, "player");
  const join = await player
    .timeout(5000)
    .emitWithAck("circle:join", { code, name: "Bram", deviceId: "smoke-m7-dev" });
  check(join.ok === true, "player joined");
  const playerId = join.ok ? join.player.id : "";

  // === DELIVER a chronicle → the player receives + keeps it ================
  const receive = waitFor(player, "log:receive", (l) => l.title === "Session One");
  const deliver = await gm.timeout(5000).emitWithAck("log:deliver", {
    title: "Session One",
    text: "The party cleared the crypt and recovered the Sunstone.",
    target: { kind: "broadcast" },
  });
  check(deliver.ok === true && deliver.deliveredTo === 1, "log:deliver acked (delivered to 1 present player)");
  const got = await receive;
  check(
    got.playerId === playerId && got.text.includes("Sunstone") && typeof got.createdAt === "string",
    "player received log:receive (their own chronicle, persisted)",
  );

  // === player:logs returns the history (newest-first after a 2nd delivery) ==
  let logs = await player.timeout(5000).emitWithAck("player:logs");
  check(logs.playerId === playerId && logs.logs.some((l) => l.id === got.id), "player:logs returns the delivered chronicle");

  // A second, targeted delivery.
  const receive2 = waitFor(player, "log:receive", (l) => l.title === "Session Two");
  const deliver2 = await gm.timeout(5000).emitWithAck("log:deliver", {
    title: "Session Two",
    text: "They descended into the Underdark.",
    target: { kind: "players", playerIds: [playerId] },
  });
  check(deliver2.ok === true && deliver2.deliveredTo === 1, "targeted log:deliver reached the player");
  await receive2;

  logs = await player.timeout(5000).emitWithAck("player:logs");
  check(logs.logs.length >= 2, "player:logs now holds the full history (≥2 chronicles)");
  check(
    logs.logs[0].createdAt >= logs.logs[logs.logs.length - 1].createdAt,
    "player:logs is ordered newest-first",
  );

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE M7: FAILED" : "\nSMOKE M7: PASSED");
process.exit(failed ? 1 : 0);
