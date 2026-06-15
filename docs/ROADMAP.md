# Roadmap

## Philosophy
Sequenced to de-risk: a thin slice runs end-to-end early (tracer bullet), the cheap-path "wow" lands before the GPU complexity, native/device testing starts as soon as a native capability appears, and the hardest external dependencies come last. **Claude implements, user reviews — working code, milestone by milestone.**

## Current status
**M3 complete.** ✓ The effect engine now has its **return leg**: a joined player speaks back to the GM. A player taps the resting canvas and two sigils bloom — the **quill** (text) and the **crystal ball** (press-and-hold PTT voice). The quill sends `channel:text`; the ball records a clip the server transcribes via an **ElevenLabs Scribe STT adapter** (behind an interface, like TTS — D11) and surfaces both as a **`ChannelMessage`** to the GM's new **Channel inbox** (text + voice transcript + clip playback, unread badge). The GM **replies with any effect** targeted at the sender — the existing router, loop closed. **DM-only** for M3 (the recipient is the GM); the wire leaves room for multi-contact/agent channels later. The **mic stays player-initiated** (D10): the server only ever receives an already-recorded clip, a visible "● recording" indicator shows the whole time the mic is live, tracks release on every exit path, and consent now discloses voice recording + transcription. STT degrades gracefully (no key → clean error; unsupported/denied → "use the quill"). 102 unit tests pass (contract 28, server 74 incl. the STT adapter); `smoke-m3.mjs` drives the text round-trip + GM reply + the player-only/empty/malformed guards (live STT behind `SMOKE_STT=1`); `smoke-m0/m1/m2` still green. See DECISIONS **D16**.

**M2 complete.** ✓ The single `message` effect is now a full **effect engine**: the contract carries an `EffectSpec` union (`message | audio | haptic | ambiance | heartbeat`); the server router stamps each into a `DeliveredEffect` (resolving TTS to inline `data:` audio) and routes it; effects carry `startDelayMs` and `effect:cue` fires choreographed bundles across the device set. Cheap-path renderers ship for all of them — bundled mp3 SFX + an audio seam unlocked on join, native+web **haptics**, a persistent **AmbianceLayer** (clear / storm = CSS lightning+vignette+rain bed / stirred ember), a **heartbeat** pulse, and **TTS** via an ElevenLabs adapter. **Effects are GM-managed & stateful** (control rework, DECISIONS **D15**): a per-circle active-effects registry split into **sustained** (loops/ambiance/storm — run until stopped) and **transient** (one-shots with a countdown); pushed to the GM as `effects:active`, stopped via `effect:stop` → `effect:end`. The GM **soundboard** is split into **Loops** vs **One-shots** with an **Active Effects** panel (Stop / countdown). **Storm** is now server-driven: the `storm` ambiance + a runner that fires synced strikes — a room-wide **`flash`** + a **thunderclap on one random player's device**. **Consent-at-join** is enforced (discloses sound/vibration/screen, mic/camera never silent; the accept tap unlocks audio). See DECISIONS **D14/D15**. (Storm is cheap CSS, not Veo video.)

**Next action: M4 — showpiece GL islands (crystal-ball refraction; 3D dice with drag/throw + physics; fidelity tiering + the GL budget guardrails).**

**Needs the user (physical-device pass):** haptic feel, iOS audio unlock, and now **mic capture / PTT** (the recording indicator + track-release behaviour) can't be validated in a browser alone — run the player on a real iPhone/Android to confirm. The web/PWA path is verified.

## Milestones

### M0 — Scaffold + spine — ✓ DONE
Monorepo, `contract` + `design-system`, the three app shells (Capacitor included), Postgres via Drizzle.
**Definition of done:** `docker compose up` + `pnpm dev` → server `/health`, both apps open in the browser, a player enters a 6-digit code → the server creates/looks up the circle in Postgres → player and GM see **live presence** over Socket.IO. Plus one early **run-on-a-real-phone smoke test** to flush out the native build/signing setup while stakes are trivial.

### M1 — Tracer bullet — ✓ DONE
The GM pushes a **parchment message** to a target or broadcast, with **acknowledge / auto-dismiss / silent**.
**Proves:** the entire actor→router→target pipeline + the design language + the message-type system, in one minimal slice.

### M2 — Effect engine + cheap-path core — ✓ DONE
Generalized effect definitions (`EffectSpec`/`DeliveredEffect` unions) + the choreography timeline (`startDelayMs` + `effect:cue`) across the device set. Core effects via the cheap path: audio/TTS (audio-unlock-on-join; SFX as bundled mp3 cues, TTS as inline `data:` audio via an ElevenLabs adapter), **haptics** (web + `@capacitor/haptics` native seam), the breathing ember, **storm as cheap CSS** (lightning+vignette+rain bed — not Veo video; see D14), heartbeat. The GM **soundboard**. **Consent-at-join + overt-output rules enforced.** Native capability seam wired (haptics native impl, audio unlock); on-device haptic/audio *feel* is a user verification step.

### M3 — Player voice/text plane — ✓ DONE
Tap → quill/ball. Quill text → GM. Ball PTT → record → STT → GM. Channels (DM-only first; multi-contact + agents later). GM can reply with any effect (closes the loop).
**Shipped:** the `ChannelMessage` contract + `channel:text`/`channel:voice` (player→server) + `channel:message` (server→GM); an ElevenLabs **Scribe** STT adapter behind an interface (D11); player **input grammar** (tap → quill/ball, PTT with a required visible recording indicator + mic-release-on-stop, D10); GM **Channel inbox** with voice playback + reply-with-effect to the sender. DM-only; multi-contact + agent channels deferred to M6. See DECISIONS **D16**.

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
