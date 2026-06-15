# Pre-submission checklist (M7)

> The audit before a store build. Part A verifies the **inviolable rules** are met
> in code (with pointers). Part B is the ROADMAP's pre-submission list. Part C is
> the **user-gated** work (accounts / signing / hardware / deploy) that can't be
> done autonomously. Re-run the smokes + `pnpm typecheck && pnpm test && pnpm build`
> before any build.

## A. Inviolable rules — audit

1. **No silent mic/camera; input always player-initiated with a visible indicator.**
   - ✅ Player voice is **press-and-hold** only; a "● recording" indicator is on
     screen the whole capture (`apps/player/src/PlayerInput.tsx` PttSurface) and
     the mic capability **stops every track** on release/cancel/unmount
     (`apps/player/src/capabilities/mic.ts`).
   - ✅ Room capture (M6) is **GM-laptop, GM-initiated**; the server emits
     `capture:state` and players show a `RecordingIndicator` (`apps/player/src/main.tsx`).
     The server NEVER initiates capture — it only ever receives an already-recorded
     clip (`channel:voice`, `transcript:chunk` handlers in `apps/server/src/socket.ts`).
   - ✅ No camera use anywhere.

2. **Consent at join.** ✅ `apps/player/src/Consent.tsx` discloses sound/vibration/
   screen control, that mic/camera are never used unless the player starts them,
   PTT voice recording+transcription, and (M6) room audio capture+transcription;
   "Not now" / leaving is one tap.

3. **Recording disclosure.** ✅ Covered by the PTT indicator, the room-capture
   `RecordingIndicator`, the `capture:state` push, and the consent copy (above).

4. **Photosensitivity safety.** ✅ Flashes are **safe by design** — the storm
   runner paces strikes **seconds apart** (server-timed, not a strobe;
   `apps/server/src/socket.ts` `startStorm`) and `flash` duration is bounded
   (`flashEffectSchema` ≤ 5s; `apps/player/src/Flash.tsx`). An explicit
   **photosensitivity warning** is now shown at consent (`apps/player/src/Consent.tsx`).

5. **Graceful capability degradation.** ✅ Capability seams with web+native impls
   (`apps/player/src/capabilities/*`), feature-detection throughout, GL **fidelity
   tiering + budget** with a cheap fallback per island (`apps/player/src/gl/*`), and
   Null providers for STT/TTS/LLM when no key (`apps/server/src/{stt,tts,llm}.ts`).

## B. Pre-submission list (ROADMAP M7)

- [x] **Consent-at-join** — `Consent.tsx` (A2).
- [x] **No-silent-input** — PTT + GM-initiated capture (A1).
- [x] **Recording disclosure** — indicators + consent (A3).
- [x] **Photosensitivity warning** — flashes are safe (A4) and an explicit warning
      is shown at consent (`Consent.tsx`).
- [x] **Locally-bundled assets** — audio cues in `apps/player/public/audio/`; three/
      R3F bundled (no CDN HDR — GL islands use explicit lights). Runtime TTS/STT
      audio is dynamic content, not an asset dependency.
- [x] **Feature-rich first build** — saturated with native capability (haptics,
      audio, mic, GL, the full effect engine + D&D + intelligence layers) per D1.
- [ ] **Privacy policy** — see `docs/PRIVACY.md` (a stub to finalize + host; needed
      for the App Store / Play data-safety forms).

## C. User-gated — cannot be done autonomously (needs you)

- **Native binaries:** `cap sync` then build in Xcode / Android Studio with your
  signing certs/keystores. A physical iPhone + Android are required to validate
  haptics, iOS audio unlock, mic/PTT, the GL islands, and the join transports.
- **Join transports on-device:** BLE-proximity tap + Android NFC (HCE) are
  scaffolded behind the capability seam (`apps/player/src/capabilities/join.ts`) and
  degrade to the **QR/6-digit code** path (which works now). Wiring the native
  plugins + testing on hardware is yours; never hard-depend on NFC (DESIGN).
- **Sign in with Apple** for iOS social login (required by review; STACK).
- **OTA update pipeline** (Capacitor live-update / Appflow or self-hosted) — a
  deploy concern; not wired.
- **Store listings + submission:** Apple Developer + Google Play accounts,
  screenshots, age rating, the data-safety/privacy questionnaires (point them at
  the hosted privacy policy), and the actual review submission.
- **Keys for prod:** `ELEVENLABS_API_KEY` (TTS + Scribe STT) and `ANTHROPIC_API_KEY`
  (Claude) in the deployment environment (never committed; `.env.example` documents
  the names).
