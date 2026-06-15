# M7 — Join ritual + ship — plan

> Final phase (see `ROADMAP.md`). Split into what's **implementable now** in
> software vs. what's genuinely **user-gated** (hardware / accounts / deploy).
> Drafted while M6's UI subagents run.

## Definition of done (ROADMAP)
BLE-tap + hearth mode, QR, Android-NFC. Onboarding gesture-teach. Guided Access
coaching. Pre-submission checklist (consent-at-join, no-silent-input, recording
disclosure, photosensitivity warning, locally-bundled assets, feature-rich first
build, privacy policy). OTA update pipeline. Store submission. Session-end summary
delivery + player log history.

## Implementable now (software — build + test)
1. **QR join + hearth mode (GM):** the GM console shows a **QR** encoding the join
   URL (`?code=NNNNNN`), and a **Hearth** display mode — the crackling-fire visual
   + the code + QR, doubling as a tap-to-join point + an output target (a
   player-class device in the hearth role, falls out of the actor/target model).
   Player join screen reads `?code=` from the URL to prefill. QR drawn inline (a
   tiny dependency-free QR encoder, or a vetted lib).
2. **Onboarding gesture-teach (player):** a first-run (per-device) overlay that
   teaches tap → quill/ball + press-and-hold PTT, dismissable, shown once.
3. **Session-end summary delivery + player log history:** the GM ends the session
   → the M6 summary is delivered to players (the existing message/parchment path)
   and **persisted per player** (D9 — players own a history of session logs). A
   player-side **log history** view (a liminal/menu surface, not the immersive
   canvas) lists past summaries. Contract: `session:end`/summary-delivery +
   per-player log persistence (Drizzle) + a `player:logs` fetch.
4. **Pre-submission checklist (doc + verification):** a `docs/SHIP-CHECKLIST.md`
   that verifies each inviolable item is met in code — consent-at-join, no-silent-
   input, recording disclosure, photosensitivity (no rapid strobes), locally-
   bundled assets, a privacy policy stub — with file/line pointers. Mostly audit.
5. **Join-transport capability seam:** a `join` capability (like haptics/audio):
   QR/code has a web impl that works now; **BLE proximity** + **Android NFC (HCE)**
   are native impls behind `Capacitor.isNativePlatform()` guards, scaffolded + a
   feature-detect that degrades to the QR/code path (never hard-depend on NFC, D
   DESIGN). The native paths are stubbed pending on-device wiring.

## User-gated (cannot complete autonomously — needs you)
- **BLE-tap / Android-NFC on real devices:** the native plugins + a physical
  iPhone + Android. Seam is scaffolded; on-device wiring + testing is yours.
- **OTA update pipeline:** a deploy concern (Capacitor live-update / self-hosted).
  Documented; not wired.
- **Store submission:** Apple Developer + Google Play accounts, signing, the
  built binary, screenshots, the privacy policy, review. The checklist preps it;
  the actual submission is yours.

## Decomposition
1. Contract (me): session-end/summary delivery, player log persistence + fetch,
   onboarding-seen (client-local). + tests.
2. Server (subagent): persist per-player session logs; `session:end` →
   deliver+store the summary; `player:logs` fetch.
3. GM UI (subagent): the Hearth mode + QR + an "End session" action.
4. Player (subagent): URL `?code=` prefill, the onboarding overlay, the log-history
   view, summary receipt.
5. Docs (me): `SHIP-CHECKLIST.md` (the audit) + a privacy-policy stub; ROADMAP/
   CLAUDE.md finalization. Flag the user-gated remainder clearly.
6. Smoke (me): session:end delivers + persists a summary; player:logs returns it.
