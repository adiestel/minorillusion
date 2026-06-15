# M5 — The D&D layer — progress tracker

> Working log for M5 (see `ROADMAP.md`): internal modifier model + sheet-provider
> adapter, manual entry (guaranteed) + DDB public-link import (best-effort),
> GM-called rolls with correct modifiers, and the owned realtime initiative
> tracker. We are the **system of record** (D6) — rolls resolve on the server.

## Definition of done (ROADMAP)
Internal modifier model + sheet-provider adapter. Manual entry (guaranteed) + DDB
public-link import (best-effort). GM-called rolls with correct modifiers. The
owned, realtime initiative tracker.

## Plan
### Commit 1 — M5 core (contract + roller) — ✓ DONE (`cb08169`)
- [x] Contract: ability/skill model + helpers (`abilityModifier`,
      `proficiencyForLevel`, `SKILL_ABILITY`), `Character`, `RollRequest`/`RollSpec`/
      `RollMode`/`RollResult`, initiative schemas; events character:save/list/delete/
      import, roll:call, initiative:set/advance/clear + server pushes. +7 tests.
- [x] `apps/server/src/rolls.ts` — authoritative `resolveRoll` (correct modifiers,
      adv/dis, crit/fumble, raw NdS). Pure + RNG-injected. +13 tests.

### Commit 2 — M5 server (persistence + handlers) — ✓ DONE (subagent)
- [x] `characters` Drizzle table + migration + `characters.ts` (`CharacterService`
      + a store seam) — manual upsert/list/delete + best-effort DDB public-link
      import (`parseDdbCharacterId`/`mapDdbCharacter`, fetch injected for tests,
      never throws). Pure `initiative.ts` reducer. +37 tests (124 server total).
- [x] Socket handlers (GM-only): character:save/list/delete/import, roll:call
      (resolveRoll → fan roll:result to GM + target player + public, de-duped),
      initiative:set/advance/clear (in-memory per-circle). circle:open re-pushes
      characters + initiative; disconnect clears the circle's initiative.

### Commit 3 — M5 clients (GM + player UI) — ✓ DONE (subagents)
- [x] GM `Party.tsx` + tab: character sheets (manual entry showing live derived
      modifiers + DDB import), a roll caller (character × check/save/skill/raw ×
      adv/dis × target × public) with a roll log (crit/fumble flair), and the
      initiative tracker (sorted, current-turn highlight, advance/clear).
- [x] Player `RollReveal.tsx`: on roll:result, the M4 d20 tumbles to `result.kept`
      + a diegetic parchment readout (crit gold / fumble ashen); GL-gated, cheap
      fallback = a big number. **The M4 dice is now wired into the app.**

### Verification
- `scripts/smoke-m5.mjs` (`smoke:m5`): character save→list, a proficient DEX save
  asserts the derived **modifier (+5)** + fan-out to the target player, a public
  raw roll, initiative set(sorted)/advance(wrap+round)/clear, graceful DDB-import
  failure, delete. (Die is random → assert the deterministic modifier + routing.)

## Verification log
- 2026-06-15 — Commit 1: contract 35 + server 87 tests; typecheck 5/5. Pushed `cb08169`.
- 2026-06-15 — Launched 3 subagents (server / gm-web / player) for commits 2–3; smoke-m5 written.
- 2026-06-15 — All 3 subagents landed + integrated: `pnpm typecheck` 5/5; `pnpm test` 180 (contract 35 + server 124 + player 21); `pnpm build` 3/3; `pnpm smoke:m5` → PASSED (correct modifiers, fan-out, initiative, graceful DDB fail). **M5 complete.**
