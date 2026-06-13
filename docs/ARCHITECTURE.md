# Architecture

## Overview
Minor Illusion is **two client planes communicating through a realtime core.** The clients are thin; the core is authoritative and holds all shared state.

```
        ┌──────────────────────────┐
        │   GM control surface     │   web · laptop/tablet · plain DOM
        │  config · target · live  │   also: owns room-audio capture
        └────────────┬─────────────┘
                     │  commands + state sync (Socket.IO)
            ┌────────▼─────────┐
            │   Realtime core  │   authoritative state
            │   effect router  │   actors → targets
            │   LLM agents     │
            │   TTS / STT      │
            │   transcript/log │
            └────────┬─────────┘
                     │  targeted / broadcast / choreographed effects
   ┌─────────────────┼──────────────────┐
   ▼                 ▼                  ▼
 player            player             player    Capacitor app (iOS/Android) · PWA fallback
 screen·audio·     ...                ...
 haptics·torch·
 PTT input
```

## The three planes

### GM control surface
- Web app, desktop-first, responsive to tablet. Plain DOM (dense 2D dashboard).
- Responsibilities: campaign/channel/agent config, knowledge bases, targeting, the live effect "soundboard," log editing.
- **Owns room-audio capture** for transcription and wake-word detection. This lives here (not on player phones) because an open laptop tab is foreground + awake + powered, sidestepping the mobile-browser background-mic sandbox.

### Player client
- A real **App Store / Play Store app**, built as a React web app wrapped in **Capacitor**. Also runnable as a degraded **PWA** (no-install fallback + dev target) via the capability-adapter seam.
- Personality: immersive, mostly-black, output-first. The phone is a remote-controlled *output surface* (screen, speaker, haptics, torch) plus *gesture-gated input* (push-to-talk, QR, gyro).
- Renders with DOM/CSS + pre-rendered media by default; WebGL only as on-demand islands (see `DESIGN.md`).

### Realtime core (the spine)
- Authoritative server (Fastify + Socket.IO). Holds circles (sessions), presence, configs, the effect library, channels, characters, transcripts, logs.
- The GM **never** addresses a player device directly — the GM tells the core, the core commands devices.

## The core abstraction: actor → router → target
Every feature is one mechanism:
- **Actors** emit messages/effects: the GM, configured **LLM agents**, and **players** (in player-to-player or player-to-entity channels).
- The **router** delivers each effect to its **target(s)**: one device, a subset, or all (broadcast). The hearth device is just another target.
- Delivery can be **choreographed across the target set** in time and space — e.g. lightning that fires on phones at staggered offsets, whispers that hop device-to-device around the physical table. The phones are one instrument, not N independent screens.

Because targeting (one/some/all) and choreography are properties of the router, broadcast vs. private vs. distributed effects are not special cases — they're parameters.

## Effect system
An **effect** is a typed payload (defined in `packages/contract`) the router sends to targets.
- **Output effects:** play sound / TTS, screen visuals, haptics, torch, vibration patterns.
- **Messages:** text on parchment, with a delivery mode — **acknowledge** (player must dismiss), **auto-dismiss** (fades after an interval), or **silent** (ambient cue only).
- **Polls:** a message that demands a choice, optionally timed (the burning-parchment countdown auto-locks on expiry). Public-tally or GM-only. The general-purpose "the party decides" primitive.
- **Mechanics:** roll requests, the initiative tracker, dice results.

Effects compose: a GM (or agent) reply to a player message can be *any* effect or stack of effects.

## Identity
- **GM accounts:** persistent (own campaigns, agents, knowledge, configs). Real auth (Lucia/better-auth; Sign in with Apple on iOS).
- **Players:** pinned per-campaign identities — choose a name on first join, recognized on every reconnect to that circle. Lightweight device-stored identity, no heavy auth. Persistent enough to own a history of session logs/summaries.

## Hard rules (also in CLAUDE.md — never violate)
Overt-output-only (no silent mic/camera; input always player-initiated with a visible indicator), consent-at-join, recording disclosure, photosensitivity safety, graceful capability degradation. The overt-vs-covert line is what keeps "remote control of another person's device" a consensual party game rather than surveillance — both an App Store requirement and an ethical one.

## Integrations (see DECISIONS.md / STACK.md)
- **D&D Beyond:** no official API. We own rolls + initiative as the system of record; DDB is a best-effort *import* of character data (public share link) behind a sheet-provider adapter, with manual entry as the guaranteed fallback. No writeback (impossible).
- **AI:** Claude (agents, smart triggers, transcript filtering, summaries) and **ElevenLabs** — **Scribe** for STT, ElevenLabs TTS for voices — all behind adapter interfaces, introduced at M3/M6. (Two vendors; keys in `.env.local`.)

## Capability-adapter seam
Each device capability (haptics, torch, audio, mic, wake-lock, NFC, BLE) is an interface with two implementations: **Capacitor-native** and **web**. This is what lets the same codebase run as the native app *and* as a PWA, and degrade gracefully per device. Never call a Capacitor plugin unguarded (`Capacitor.isNativePlatform()` is the branch).
