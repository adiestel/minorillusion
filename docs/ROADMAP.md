# Roadmap

## Philosophy
Sequenced to de-risk: a thin slice runs end-to-end early (tracer bullet), the cheap-path "wow" lands before the GPU complexity, native/device testing starts as soon as a native capability appears, and the hardest external dependencies come last. **Claude implements, user reviews — working code, milestone by milestone.**

## Current status
**M1 complete.** ✓ The full actor→router→target effect pipeline works: the GM sends a parchment message (acknowledge / auto_dismiss / silent) to a target or broadcast; the player renders it as ink-on-parchment (burn-to-ash acknowledge, refold auto-dismiss, silent ember-glow) and acks back to the GM. 30 unit tests pass (contract 7, server 23); `scripts/smoke-m1.mjs` + `smoke-m0.mjs` pass end-to-end. **Post-M1 design-review polish (done):** parchment rebuilt as clean **DOM/CSS** — IM Fell English, a torn/deckled edge (SVG displacement filter), restrained fade-and-rise + ink fade-in (the 3D attempt was tried and reverted — see DECISIONS D13); the **skeuomorphic rule** enforced (the joined/resting state is now just the breathing ember — no name/roster text); and **session reconnect** added (player auto-rejoin + GM circle restore + a Leave control).

**Next action: M2 — effect engine + cheap-path core effects (audio/TTS, haptics, ember, storm-via-video, heartbeat) + GM soundboard. ← native capabilities + physical-device testing begin here.**

## Milestones

### M0 — Scaffold + spine — ✓ DONE
Monorepo, `contract` + `design-system`, the three app shells (Capacitor included), Postgres via Drizzle.
**Definition of done:** `docker compose up` + `pnpm dev` → server `/health`, both apps open in the browser, a player enters a 6-digit code → the server creates/looks up the circle in Postgres → player and GM see **live presence** over Socket.IO. Plus one early **run-on-a-real-phone smoke test** to flush out the native build/signing setup while stakes are trivial.

### M1 — Tracer bullet — ✓ DONE
The GM pushes a **parchment message** to a target or broadcast, with **acknowledge / auto-dismiss / silent**.
**Proves:** the entire actor→router→target pipeline + the design language + the message-type system, in one minimal slice.

### M2 — Effect engine + cheap-path core
Generalized effect definitions + the choreography timeline across the device set. Core effects via the cheap path: audio/TTS (with audio-unlock-on-join), **haptics**, the breathing ember, storm-via-pre-rendered-video, heartbeat. The GM "soundboard." Consent-at-join + overt-output rules enforced.
**← Native capabilities and physical-device testing begin in earnest here** (haptics/audio can't be validated in a browser).

### M3 — Player voice/text plane
Tap → quill/ball. Quill text → GM. Ball PTT → record → STT → GM. Channels (DM-only first; multi-contact + agents later). GM can reply with any effect (closes the loop).

### M4 — Showpiece GL islands
Crystal-ball refraction; 3D dice (drag/throw + physics). Fidelity tiering + the GL budget guardrails.

### M5 — D&D layer
Internal modifier model + sheet-provider adapter. Manual entry (guaranteed) + DDB public-link import (best-effort). GM-called rolls with correct modifiers. The **owned, realtime initiative tracker**.

### M6 — Intelligence layer
GM-laptop room capture → STT transcript. LLM: transcript filtering (ignore cross-talk), configurable session summaries (with source selection), ad-hoc log editing. LLM **agents as actors** (configured knowledge + TTS voices). **Dissonant Whispers** (wake-word / smart triggers / smart TTS).

### M7 — Join ritual + ship
BLE-tap + hearth mode, QR, Android-NFC. Onboarding gesture-teach. Guided Access coaching. **Pre-submission checklist** (consent-at-join, no-silent-input, recording disclosure, photosensitivity warning, locally-bundled assets, feature-rich first build, privacy policy). OTA update pipeline. Store submission. Session-end summary delivery + player log history.

## Native / mobile enablement timeline
Capacitor shell exists from M0; native capabilities are wired as features need them (haptics/audio at M2); on-device testing is continuous from M2; native-only showpieces (tap-to-join, push, kiosk) land at M7. A physical iPhone + Android phone are needed from M2.

## How to update this file
When a milestone completes, move it under a "Done" heading with a one-line note, and update **Current status**. This is the canonical place a fresh session learns where the build stands.
