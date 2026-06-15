# Minor Illusion — Project Guide

> Immersive companion app for tabletop RPGs. A Game Master conducts atmosphere, messages, voice, and game mechanics onto players' phones, which act as one choreographed canvas around the table.

**This file is the always-loaded anchor. Before substantive work, read the relevant docs in `docs/` — they are the source of truth and survive context clearing.**

## Status
- **Phase:** **M6 complete** — M0–M3 shipped (scaffold/presence, parchment tracer, effect engine + soundboard + consent, player voice/text plane); **M4** GL-island foundation + 3D dice (crystal ball deferred); **M5** the D&D layer (server-authoritative rolls, character sheets manual + DDB import, initiative tracker, GM Party + player dice reveal); **M6** the intelligence layer (GM room capture → STT transcript, Claude summaries/log editing behind an adapter, LLM agents-as-actors, GM Lore tab + player recording disclosure). All shipped & tested. See `docs/ROADMAP.md`.
- **Next action:** **M7** — join ritual + ship (QR/hearth + onboarding + session-end summary delivery + player log history + the pre-submission checklist; on-device BLE/NFC, OTA, store submission are user-gated). See `docs/M7-PLAN.md`.
- **Open user step:** physical-device pass (haptic feel + iOS audio unlock + mic/PTT recording-indicator & track-release) — verify the player on a real iPhone/Android.
- **Build mode:** Claude implements, user reviews — working code, milestone by milestone.

## Read first (the durable spec)
- `docs/ARCHITECTURE.md` — system shape: two client planes + realtime core, the actor→router→target model, identity, the effect system.
- `docs/DESIGN.md` — design language (the circle/hearth, parchment, quill + crystal ball) and the rendering strategy.
- `docs/STACK.md` — tech stack, local dev, deferred decisions.
- `docs/ROADMAP.md` — milestones M0–M7, definitions of done, current status.
- `docs/DECISIONS.md` — the *why* behind settled forks. **Don't re-litigate these without a new reason.**

## Architecture in one breath
Two clients + a spine. **GM** = web control surface (laptop/tablet) that also captures room audio. **Player** = a real App Store / Play Store app built as a web app wrapped in **Capacitor** (also runnable as a degraded PWA). **Realtime core** = an authoritative server where *actors* (GM, LLM agents, players-in-channels) emit effects that a *router* delivers to *targets* (one / several / all devices), choreographed across the set. Every feature is a variation of this one mechanism.

## Stack in one breath
Self-hosted TypeScript monorepo, **run locally first**. pnpm + Turborepo · React + Vite (both planes) · Capacitor (player) · Fastify + Socket.IO + Postgres + Drizzle (server) · Lucia/better-auth · storage + AI behind adapters (Claude / Deepgram / ElevenLabs, deferred to M3/M6). No SaaS platform in the critical path.

## Inviolable rules (safety / ethics / store-compliance — never violate)
1. **No silent mic or camera.** The GM may remote-trigger *output* (audio, haptics, screen, torch) but **never** silently activate a player's microphone or camera. Mic/camera are always player-initiated, with a visible active indicator.
2. **Consent at join.** Joining shows a clear disclosure of what the GM can do to the device during the session; leaving is always one tap.
3. **Recording disclosure.** Session audio capture/transcription requires upfront disclosure + a visible recording indicator.
4. **Photosensitivity safety.** Guard strobe/flash effects; ship a photosensitivity warning.
5. **Graceful capability degradation.** Always feature-detect; never assume a native capability exists (keeps the PWA + low-end devices working).

## Conventions
- TypeScript everywhere. **`packages/contract`** (zod schemas + types) is the single source of truth for the wire protocol, effects, and targets — both planes import it; never hand-define a message shape in an app.
- Monorepo: `apps/{server,gm-web,player}` + `packages/{contract,design-system}`.
- Storage and AI providers live behind interfaces — swap implementations, don't inline a vendor.
- Player device capabilities go through the capability-adapter seam (Capacitor-native impl + web impl) so the same code runs native or as a PWA. Never call a Capacitor plugin unguarded.

## Project memory
Key facts also live in Claude Code memory (auto-loaded via `MEMORY.md`): DDB API status, rendering strategy, tech stack, and a pointer back to this spec. This repo's `CLAUDE.md` + `docs/` is the fuller source of truth.
