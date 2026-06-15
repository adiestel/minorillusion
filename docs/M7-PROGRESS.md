# M7 — Join ritual + ship — progress tracker

> Working log for M7 (see `ROADMAP.md` / `M7-PLAN.md`). The final phase: the
> implementable software (QR/hearth join, onboarding, session-end summary delivery
> + player log history, the ship checklist) plus a clear hand-off of the
> genuinely user-gated work (on-device BLE/NFC, OTA, the actual store submission).

## Plan
### Commit 1 — M7 core (contract) — ✓ DONE (`f3b790e`)
- [x] `PlayerLog` + `deliverLogRequest` + `PlayerLogs`; events `log:deliver` (GM),
      `player:logs` (player), `log:receive` (server→player). +1 test (39 contract).

### Commit 2 — M7 software (server + GM + player) — ✓ DONE (subagents)
- [x] **Server:** `player_logs` table + migration + `playerLogs.ts` service;
      `log:deliver` (GM-only, persist per present recipient + `log:receive`),
      `player:logs` (player-only, fetch newest-first). +5 tests (158 server).
- [x] **GM:** `Hearth.tsx` (CSS crackling fire + join code + **QR** of
      `${VITE_PLAYER_URL}?code=…` via `qrcode`) + a **deliver-chronicle** control
      in the Lore summary panel (session-end summary → players).
- [x] **Player:** `?code=` URL prefill (scan-to-join, name autofocused), an
      `Onboarding.tsx` gesture-teach (once per device, post-consent), and a
      `LogHistory.tsx` chronicle menu surface reacting to `log:receive` (unread glow).

### Commit 3 — ship hardening (me, post-integration) — ✓ DONE
- [x] `capabilities/join.ts` — the join-transport seam: QR/code works now; BLE +
      Android NFC scaffolded behind native guards (`isSupported()` false on web),
      degrading to QR/code. Exported from `capabilities/index.ts`.
- [x] Photosensitivity **warning** line added to `Consent.tsx` (the last open
      checklist item; the safety was already enforced).
- [x] `docs/SHIP-CHECKLIST.md` (inviolable-rules audit + the pre-submission list +
      the user-gated hand-off) + `docs/PRIVACY.md` (data-flow stub).

### Verification
- `scripts/smoke-m7.mjs` (`smoke:m7`): a GM chronicle delivery reaches the player
  (`log:receive`), is persisted, and `player:logs` returns the newest-first history.

## User-gated remainder (see SHIP-CHECKLIST.md Part C)
On-device BLE/NFC wiring + testing, Sign in with Apple, the OTA pipeline, store
accounts/signing/listings, and the actual submission — these need your hardware,
accounts, and deploy environment.

## Verification log
- 2026-06-15 — Commit 1: contract 39 tests; typecheck 5/5. Pushed `f3b790e`.
- 2026-06-15 — Launched 3 subagents (server / gm-web / player); smoke-m7 + SHIP-CHECKLIST + PRIVACY written.
- 2026-06-15 — All 3 subagents landed + integrated + hardened (join seam, photosensitivity warning): `pnpm typecheck` 5/5; `pnpm test` 218 (contract 39 + server 158 + player 21); `pnpm build` 3/3; `pnpm smoke:m7` → PASSED (chronicle delivery + persisted history). Applied the pending `player_logs` migration. **M7 software complete; the user-gated remainder is documented in SHIP-CHECKLIST.md Part C.**
