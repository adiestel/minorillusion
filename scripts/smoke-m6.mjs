/**
 * M6 end-to-end smoke test — the intelligence layer: room-capture disclosure +
 * transcript (manual + chunk), Claude summaries, and LLM agents-as-actors.
 * Requires Postgres up and the server on :3001.
 *
 *   pnpm smoke:m6                  (wiring; LLM/STT paths assert graceful behavior)
 *   SMOKE_LLM=1 pnpm smoke:m6      (also asserts a live Claude summary + agent reply)
 *
 * The LLM/STT calls need keys, so by default we assert the WIRING is sound (acks
 * are well-formed, capture disclosure reaches players, transcript edits apply);
 * the live content assertions are gated behind SMOKE_LLM=1.
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
    .emitWithAck("circle:join", { code, name: "Bram", deviceId: "smoke-m6-dev" });
  check(join.ok === true, "player joined");

  // === CAPTURE disclosure: recording state reaches the player (D10) =========
  const recOn = waitFor(player, "capture:state", (s) => s.recording === true);
  const trUpdate = waitFor(gm, "transcript:update", (t) => t.recording === true);
  gm.emit("capture:set", { recording: true });
  await recOn;
  ok("player received capture:state recording=true (recording disclosure)");
  await trUpdate;
  ok("GM transcript:update reflects recording=true");

  // === TRANSCRIPT: manual add → edit → delete ==============================
  const add = await gm.timeout(5000).emitWithAck("transcript:add", {
    text: "The party enters the crypt.",
    speaker: "GM",
  });
  check(add.ok === true && add.entry.source === "manual", "transcript:add appended a manual line");
  const entryId = add.ok ? add.entry.id : "";

  let list = await gm.timeout(5000).emitWithAck("transcript:list");
  check(list.entries.some((e) => e.id === entryId), "transcript:list returns the added line");

  const edit = await gm.timeout(5000).emitWithAck("transcript:edit", {
    entryId,
    text: "The party enters the crypt, torches guttering.",
  });
  check(edit.ok === true, "transcript:edit acked ok");
  list = await gm.timeout(5000).emitWithAck("transcript:list");
  check(
    list.entries.find((e) => e.id === entryId)?.text.includes("torches guttering"),
    "the edited line shows the new text",
  );

  await gm.timeout(5000).emitWithAck("transcript:edit", { entryId, delete: true });
  list = await gm.timeout(5000).emitWithAck("transcript:list");
  check(!list.entries.some((e) => e.id === entryId), "transcript:edit delete removed the line");

  // A malformed audio chunk fails cleanly (offline; decoded before STT).
  const badChunk = await gm.timeout(5000).emitWithAck("transcript:chunk", { audio: "not-a-data-url" });
  check(badChunk.ok === false, "transcript:chunk with a malformed clip is rejected gracefully");

  // === SUMMARY: wiring sound; live content gated by SMOKE_LLM ==============
  await gm.timeout(5000).emitWithAck("transcript:add", { text: "Bram disarms a trap; Mira finds a hidden door." });
  const sum = await gm.timeout(30000).emitWithAck("summarize", { style: "recap" });
  check(typeof sum.ok === "boolean", "summarize returns a well-formed result (wiring sound)");
  if (process.env.SMOKE_LLM === "1") {
    check(sum.ok === true && typeof sum.summary.text === "string" && sum.summary.text.length > 0, "live Claude summary produced text");
  } else if (!sum.ok) {
    ok(`summarize degraded gracefully without a key (${sum.error})`);
  }

  // === AGENTS: save → list → prompt → delete ==============================
  const agentSave = await gm.timeout(5000).emitWithAck("agent:save", {
    name: "The Oracle",
    knowledge: "An ancient seer who speaks in short, ominous riddles.",
  });
  check(agentSave.ok === true && agentSave.agent.name === "The Oracle", "agent:save acked with the agent");
  const agentId = agentSave.ok ? agentSave.agent.id : "";
  const agents = await gm.timeout(5000).emitWithAck("agent:list");
  check(agents.agents.some((a) => a.id === agentId), "agent:list returns the saved agent");

  const playerEffect = waitFor(player, "effect:deliver", (e) => e.kind === "message" || e.kind === "audio", 30000);
  const prompt = await gm.timeout(30000).emitWithAck("agent:prompt", {
    agentId,
    prompt: "What awaits the party in the crypt?",
    deliverAs: "message",
    target: { kind: "broadcast" },
  });
  check(typeof prompt.ok === "boolean", "agent:prompt returns a well-formed result (wiring sound)");
  if (process.env.SMOKE_LLM === "1") {
    check(prompt.ok === true && typeof prompt.reply === "string" && prompt.reply.length > 0, "live agent reply produced text");
    if (prompt.ok) {
      await playerEffect;
      ok("the agent's reply was delivered to the player as an effect");
    }
  } else if (!prompt.ok) {
    ok(`agent:prompt degraded gracefully without a key (${prompt.error})`);
  }

  await gm.timeout(5000).emitWithAck("agent:delete", { agentId });
  const afterDel = await gm.timeout(5000).emitWithAck("agent:list");
  check(!afterDel.agents.some((a) => a.id === agentId), "agent:delete removed the agent");

  // === stop recording → the player is told ================================
  const recOff = waitFor(player, "capture:state", (s) => s.recording === false);
  gm.emit("capture:set", { recording: false });
  await recOff;
  ok("player received capture:state recording=false");

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE M6: FAILED" : "\nSMOKE M6: PASSED");
process.exit(failed ? 1 : 0);
