/**
 * M0 end-to-end smoke test — exercises the REAL server + Postgres + Socket.IO
 * over the wire (the same protocol the apps use). Requires Postgres up and the
 * server listening on :3001.
 *
 * Run via a workspace that has socket.io-client installed, e.g.:
 *   pnpm --filter @minorillusion/gm-web exec node scripts/smoke-m0.mjs
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
    s.on("connect_error", (e) => rej(new Error(`${who} connect_error: ${e.message}`)));
    setTimeout(() => rej(new Error(`${who} connect timeout`)), 5000);
  });

try {
  // GM connects and creates a circle.
  const gm = conn();
  await onConnect(gm, "GM");
  ok("GM connected");

  const create = await gm.timeout(5000).emitWithAck("circle:create", {});
  check(
    typeof create?.circle?.code === "string" && /^\d{6}$/.test(create.circle.code),
    "circle:create returns a 6-digit code",
  );
  const code = create.circle.code;
  console.log("  code:", code);

  // GM watches presence.
  let presence = null;
  gm.on("presence:update", (u) => {
    presence = u;
  });

  // Player joins with that code.
  const player = conn();
  await onConnect(player, "player");
  const join = await player
    .timeout(5000)
    .emitWithAck("circle:join", { code, name: "Aria", deviceId: "smoke-device-1" });
  check(join?.ok === true, "circle:join acked ok");
  check(join?.ok && join.player.name === "Aria", "joined player name matches");
  check(join?.ok && join.circle.code === code, "joined circle code matches");

  // Presence broadcast should reach the GM.
  await new Promise((r) => setTimeout(r, 400));
  check(
    presence?.players?.some((p) => p.name === "Aria"),
    "GM received presence:update including the player",
  );

  // Pinned identity: the same device re-joining maps to the same player.
  const rejoin = await player
    .timeout(5000)
    .emitWithAck("circle:join", { code, name: "Aria", deviceId: "smoke-device-1" });
  check(
    rejoin?.ok === true && join?.ok && rejoin.player.id === join.player.id,
    "re-join from same device → same player id (pinned identity)",
  );

  // Unknown code is rejected.
  const miss = await gm.timeout(5000).emitWithAck("circle:open", { code: "000000" });
  check(miss?.ok === false, "circle:open with an unknown code → ok:false");

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE: FAILED" : "\nSMOKE: PASSED");
process.exit(failed ? 1 : 0);
