/**
 * M1 end-to-end smoke test — the parchment-message pipeline over the wire:
 * GM sends an effect → player receives effect:deliver → player acks →
 * GM receives effect:acked. Covers broadcast + targeted. Requires Postgres up
 * and the server listening on :3001.
 *
 *   pnpm smoke:m1   (after: pnpm db:up and the server running)
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
    .emitWithAck("circle:join", { code, name: "Aria", deviceId: "smoke-m1-dev" });
  check(join.ok === true, "player joined");
  const playerId = join.ok ? join.player.id : "";

  // Broadcast, acknowledge mode.
  const gotDeliver = waitFor(player, "effect:deliver", (e) => e.kind === "message");
  const send1 = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "broadcast" },
    spec: { kind: "message", body: "The torches gutter.", mode: "acknowledge" },
  });
  check(send1.ok === true && send1.deliveredTo >= 1, "broadcast effect:send acked (deliveredTo >= 1)");
  const eff = await gotDeliver;
  check(
    eff.body === "The torches gutter." && eff.mode === "acknowledge",
    "player received the broadcast message via effect:deliver",
  );

  // Player acks → GM gets effect:acked.
  const gotAcked = waitFor(gm, "effect:acked", (a) => a.effectId === eff.id);
  player.emit("effect:ack", { effectId: eff.id });
  const acked = await gotAcked;
  check(acked.playerId === playerId, "GM received effect:acked with the player id");

  // Targeted to the specific player, silent mode.
  const gotTargeted = waitFor(player, "effect:deliver", (e) => e.body === "A whisper, for you alone.");
  const send2 = await gm.timeout(5000).emitWithAck("effect:send", {
    target: { kind: "players", playerIds: [playerId] },
    spec: { kind: "message", body: "A whisper, for you alone.", mode: "silent" },
  });
  check(send2.ok === true && send2.deliveredTo === 1, "targeted effect:send delivered to exactly 1");
  const eff2 = await gotTargeted;
  check(eff2.mode === "silent", "player received the targeted silent message");

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE M1: FAILED" : "\nSMOKE M1: PASSED");
process.exit(failed ? 1 : 0);
