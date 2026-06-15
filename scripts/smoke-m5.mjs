/**
 * M5 end-to-end smoke test — the D&D layer: character sheets, GM-called rolls
 * resolved authoritatively on the server (correct modifiers, fanned to the GM +
 * the target player's die), and the initiative tracker. Requires Postgres up and
 * the server listening on :3001.
 *
 *   pnpm smoke:m5
 *
 * The roll die is random, so we assert the deterministic parts: the MODIFIER
 * derived from the sheet, total = kept + modifier, and the fan-out routing.
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
    .emitWithAck("circle:join", { code, name: "Bram", deviceId: "smoke-m5-dev" });
  check(join.ok === true, "player joined");
  const playerId = join.ok ? join.player.id : "";

  // === CHARACTER: manual save → characters:list push ======================
  const listPush = waitFor(gm, "characters:list", (l) => l.characters.some((c) => c.name === "Bram"));
  const save = await gm.timeout(5000).emitWithAck("character:save", {
    name: "Bram",
    level: 5, // proficiency bonus +3
    abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
    skillProficiencies: ["stealth"],
    saveProficiencies: ["dex", "con"],
    maxHp: 38,
    ac: 16,
  });
  check(save.ok === true && save.character.name === "Bram", "character:save acked with the stored sheet");
  const charId = save.ok ? save.character.id : "";
  await listPush;
  ok("GM received characters:list after the save");

  const listed = await gm.timeout(5000).emitWithAck("character:list");
  check(listed.characters.some((c) => c.id === charId), "character:list returns the saved character");

  // === ROLL: a proficient DEX save derives the CORRECT modifier (+5) =======
  // dex 14 → +2, proficient save + prof +3 = +5. Random die, deterministic mod.
  const rollAtPlayer = waitFor(player, "roll:result", (r) => r.targetPlayerId === playerId);
  const rollAtGm = waitFor(gm, "roll:result", (r) => r.modifier === 5);
  const roll = await gm.timeout(5000).emitWithAck("roll:call", {
    spec: { kind: "save", ability: "dex" },
    characterId: charId,
    mode: "normal",
    targetPlayerId: playerId,
    public: false,
  });
  check(roll.ok === true, "roll:call acked ok");
  if (roll.ok) {
    const r = roll.result;
    check(r.modifier === 5, "DEX save used the correct modifier (+5: dex +2, proficient +3)");
    check(r.total === r.kept + r.modifier, "total = kept die + modifier");
    check(r.sides === 20 && r.dice.length === 1, "a normal save is a single d20");
    check(r.label === "Dexterity Save" && r.characterName === "Bram", "roll carries the derived label + character");
  }
  const gmRoll = await rollAtGm;
  ok("GM received roll:result");
  const pRoll = await rollAtPlayer;
  check(pRoll.id === (roll.ok ? roll.result.id : ""), "target player received the SAME roll:result (its die visualizes it)");

  // A non-proficient INT save is just the ability mod (+0).
  const intRoll = await gm.timeout(5000).emitWithAck("roll:call", {
    spec: { kind: "save", ability: "int" },
    characterId: charId,
    mode: "normal",
    public: false,
  });
  check(intRoll.ok === true && intRoll.result.modifier === 0, "non-proficient INT save modifier is +0");

  // A public raw damage roll reaches the player too.
  const pubRoll = waitFor(player, "roll:result", (r) => r.label.includes("2d6"));
  const dmg = await gm.timeout(5000).emitWithAck("roll:call", {
    spec: { kind: "raw", count: 2, sides: 6, modifier: 3 },
    mode: "normal",
    public: true,
  });
  check(dmg.ok === true && dmg.result.sides === 6 && dmg.result.dice.length === 2, "raw 2d6+3 rolled two d6");
  await pubRoll;
  ok("a public roll reached the player");

  // === INITIATIVE: set (sorted) → advance (turn/round) → clear ============
  const initSet = await gm.timeout(5000).emitWithAck("initiative:set", {
    entries: [
      { name: "Goblin", initiative: 12 },
      { name: "Bram", initiative: 18, characterId: charId },
      { name: "Wolf", initiative: 15 },
    ],
  });
  check(
    initSet.entries.map((e) => e.name).join(",") === "Bram,Wolf,Goblin",
    "initiative:set sorts entries high→low (Bram 18, Wolf 15, Goblin 12)",
  );
  check(initSet.turnIndex === 0 && initSet.round >= 1, "initiative starts at turn 0, round 1");

  const adv1 = await gm.timeout(5000).emitWithAck("initiative:advance");
  check(adv1.turnIndex === 1, "advance moves to turn index 1 (Wolf)");
  await gm.timeout(5000).emitWithAck("initiative:advance"); // → Goblin (idx 2)
  const wrap = await gm.timeout(5000).emitWithAck("initiative:advance"); // wraps → Bram, round 2
  check(wrap.turnIndex === 0 && wrap.round === initSet.round + 1, "advancing past the end wraps to turn 0 and bumps the round");

  const cleared = await gm.timeout(5000).emitWithAck("initiative:clear");
  check(cleared.entries.length === 0 && cleared.turnIndex === -1, "initiative:clear empties the tracker");

  // === DDB import: a clearly-invalid link fails gracefully (no network dep) =
  const badImport = await gm.timeout(8000).emitWithAck("character:import", { url: "not-a-ddb-link" });
  check(badImport.ok === false, "character:import rejects an invalid link gracefully (best-effort, D6)");

  // === DELETE: the character leaves the roster ============================
  const del = await gm.timeout(5000).emitWithAck("character:delete", { characterId: charId });
  check(del.ok === true, "character:delete acked ok");
  const afterDel = await gm.timeout(5000).emitWithAck("character:list");
  check(!afterDel.characters.some((c) => c.id === charId), "deleted character is gone from the roster");

  gm.close();
  player.close();
} catch (e) {
  bad(`exception: ${e.message}`);
}

console.log(failed ? "\nSMOKE M5: FAILED" : "\nSMOKE M5: PASSED");
process.exit(failed ? 1 : 0);
