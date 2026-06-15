# M3 — Player voice/text plane — progress tracker — ✓ COMPLETE

> Working log for the M3 milestone (see `ROADMAP.md`). The inverse path: a player
> speaks back to the GM. **M3 is done** — canonical status now lives in
> `ROADMAP.md` (M3 ✓ DONE) + `DECISIONS.md` (**D16**); this file is the detailed
> build/verification history.

## Definition of done (from ROADMAP)
Tap → quill/ball. Quill text → GM. Ball PTT → record → STT → GM. Channels
(DM-only first; multi-contact + agents later). GM can reply with any effect
(closes the loop).

## Shape (how M3 maps onto the existing engine)
The effect engine already routes GM → player. M3 adds the **return leg**:
- Player taps the resting canvas → two sigils bloom: **quill** (text) + **crystal
  ball** (voice, press-and-hold PTT). (DESIGN.md "input grammar".)
- Quill → `channel:text`; crystal ball → records a clip → `channel:voice`.
- Server stamps a **`ChannelMessage`** (voice clips run through an **STT adapter**,
  ElevenLabs Scribe per D11) and pushes it to the circle's GM(s) as
  `channel:message`.
- GM sees an **inbox**; **replies with any effect** by targeting the sender with
  the existing router (quick parchment reply built in; soundboard/whispers already
  target a player). Loop closed.

**DM-only for M3** — every message goes to the GM (recipient implicit). The wire
leaves room for multi-contact/agent channels later without overbuilding now.

**Inviolable (D10):** the mic is ALWAYS player-initiated — the server only ever
receives an already-recorded clip; never asks a device to capture. Voice is
recorded + transcribed → disclosed at consent + a visible recording indicator.

## Plan — two verifiable commits
### Commit 1 — M3 core (contract + server) — headlessly verifiable ✓ DONE
- [x] **Contract:** `ChannelMessage`, `sendTextRequest`, `sendVoiceRequest`,
      `sendMessageResult`; events `channel:text`/`channel:voice` (client→server),
      `channel:message` (server→GM). +4 contract tests (28 total green).
- [x] **STT adapter** (`apps/server/src/stt.ts` + `stt.test.ts`): `SttProvider`
      interface, `ElevenLabsStt` (Scribe, `scribe_v1`), `NullStt` fallback,
      `getSttProvider()`, `dataUrlToParts()` helper. Mirrors `tts.ts`; key never
      logged. +6 server tests (74 total green).
- [x] **Server handlers:** `channel:text` + `channel:voice` (player-only) →
      build `ChannelMessage` (voice: decode → STT → transcript, empty/garbage
      rejected) → emit `channel:message` to GM sockets via `deliverChannelMessage`.
      Player name cached on the binding at join. Socket `maxHttpBufferSize` → 5MB.
- [x] **Smoke** (`scripts/smoke-m3.mjs` + `smoke:m3` script): text round-trip +
      GM reply effect (loop closed); player-only + empty-body + malformed-clip
      guards; live STT path behind `SMOKE_STT=1`/`SMOKE_STT_CLIP`. → PASSED.

### Commit 2 — M3 clients (player + GM UI) — typecheck + builds ✓ DONE
- [x] **Mic capability** (`apps/player/src/capabilities/mic.ts`): web
      MediaRecorder, feature-detected (D10 graceful degradation), releases EVERY
      track on stop/cancel/error (OS mic indicator off). Native seam noted, no dep.
- [x] **Player input grammar** (`PlayerInput.tsx` + wired into `main.tsx`): tap →
      quill/ball sigils bloom from the touch point; quill compose → `channel:text`;
      ball **press-and-hold PTT** (required visible "● recording" indicator,
      `role="status"`) → `channel:voice`. Skeuomorphic (idle = bare ember +
      transparent catcher); sub-350ms taps dropped; release-during-permission and
      double-send guarded; unmount/dismiss always release the mic.
- [x] **Consent copy** update: discloses PTT voice is recorded + transcribed, only
      while held, with a visible indicator.
- [x] **GM inbox** (`Channel.tsx` + a "Channel" tab w/ unread badge): incoming
      messages (text + voice transcript + `<audio>` clip playback); inline reply
      targeting the sender via `effect:send` (mode selector, persisted) —
      reply-with-effect closes the loop.

## Verification log
- 2026-06-15 — Contract additions + tests: `pnpm --filter @minorillusion/contract test` → 28 passed.
- 2026-06-15 — Commit 1 (M3 core): `pnpm typecheck` 5/5; `pnpm test` 102 (contract 28 + server 74); `pnpm smoke:m3` → PASSED. STT adapter built by subagent to the `tts.ts` pattern.
- 2026-06-15 — Commit 2 (M3 clients): player input grammar + mic capability + GM Channel inbox built by two parallel subagents (disjoint apps). `pnpm typecheck` 5/5; `pnpm build` 3/3 (server + both frontends); `pnpm test` 102; `pnpm smoke:m3` → PASSED. Mic-release / recording-indicator / overlay-layering reviewed by hand. **M3 complete.**

## Open follow-ups (not blocking M3)
- **Physical-device pass** (long-standing): verify mic/PTT on a real iPhone/Android — the recording indicator, the OS mic indicator going dark on release, and getUserMedia in the Capacitor WebView. The browser/PWA path is verified.
- **Live STT** is socket-smoke-skippable; exercise once with `SMOKE_STT=1 SMOKE_STT_CLIP=/path/to/clip pnpm smoke:m3` against a real key to confirm Scribe's response shape end-to-end.
</content>
</invoke>
