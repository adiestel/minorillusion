# Decision Log

Settled decisions and *why*. Don't re-open these without a new reason. (ADR-style; append new decisions as `D11`, `D12`, …)

## D1 — Player client is a native app via Capacitor (not pure PWA, not a native rewrite)
**Why:** iOS Safari has hard walls the experience needs — no vibration/haptics, no torch, no NFC, limited background audio/mic, push only if home-screened, no true fullscreen. A native app clears all of them. Capacitor wraps the *web* codebase into a real App Store/Play Store binary, so "native app" costs one codebase, not a Swift/Kotlin or React Native rebuild — and the same code still runs as a PWA.
**Rejected:** pure PWA (iOS too degraded; install friction), React Native / full native (rebuild cost; loses the URL/PWA path and GM-app synergy).
**Note:** Capacitor apps pass App Store review when not a thin wrapper; this app is saturated with native capability. Bundle assets locally; make the first submission feature-rich.

## D2 — GM is a web app; room audio capture lives on the GM's laptop
**Why:** the GM surface is a dense config/control dashboard (web's strength). Continuous mic capture / wake-word fights the mobile-browser sandbox, but an open laptop tab is foreground + awake + powered, so capture belongs there — not on players' pocketed phones.

## D3 — Realtime core with an actor→router→target model
**Why:** indirection (GM → server → devices) is what makes targeting, broadcast, choreography, channels, agents, and whispers all one mechanism instead of many special cases.

## D4 — Self-host everything, run locally first (no SaaS platform; Vercel rejected)
**Why:** a persistent WebSocket server is unavoidable, which voids the "no server to run" benefit of serverless/BaaS. Given one always-on box is required anyway, co-locating API/DB/auth is marginal and buys simplicity, flat cost, no lock-in, and local==prod. Vercel can't host a WS server (would force a realtime SaaS). Carve-outs even in a self-host world: use an auth *library* (not hand-rolled), and object storage + CDN (R2) for serving media.
**Rejected:** Supabase-centric / serverless (velocity pitch nullified by the WS requirement), Vercel.

## D5 — TypeScript stack: pnpm/Turbo · React+Vite · Fastify+Socket.IO · Postgres+Drizzle
**Why:** one language end-to-end lets `packages/contract` be the shared typed wire contract binding both planes. Socket.IO rooms map 1:1 to circles. React enables React-Three-Fiber for the GL islands. All swappable, but chosen for velocity + fit.

## D6 — D&D Beyond: best-effort import + manual fallback; own rolls/initiative; no writeback
**Why (verified June 2026):** DDB has no official API and none on the roadmap; its own Sigil VTT is shutting down (retrenchment signal). Reading character data works only via a fragile undocumented endpoint (public characters only); writeback into DDB is impossible. So we make our app the **system of record** for rolls + initiative, model only the roll-relevant modifiers internally behind a **sheet-provider adapter**, ship **manual entry as the guaranteed path**, and add DDB public-link import as a pluggable best-effort convenience. Never depend on DDB. (Chosen option: "(a)".)

## D7 — Rendering: DOM/CSS + pre-rendered media by default; WebGL only as on-demand islands
**Why:** a phone lies face-up on a table for hours — a continuous hot GPU loop cooks and drains it. Most visual "quality" is art assets + hardware video decode, not real-time compute. Escalate to a transient WebGL island only when an effect must refract / be interactive / react live / vary endlessly. Cap concurrent GL; every effect ships a cheap fallback (= low-end tier). Decided case-by-case via that rule.

## D8 — PWA as a no-install fallback + dev target (native-first)
**Why:** the capability-adapter seam (native + web impls), built anyway for graceful degradation, yields a PWA target for ~free. Native stays the flagship (iOS PWA is degraded; Android nearly full); PWA is the "QR falls back to web so no one's blocked from joining" escape hatch.

## D9 — Identity: persistent GM accounts; pinned per-campaign player identities
**Why:** GMs own durable campaigns/agents/knowledge (real accounts). Players need just enough persistence to be recognized on reconnect and to own a history of session logs — name-on-first-join, no heavy auth.

## D10 — Inviolable safety/ethics rules
Overt-output-only (no silent mic/camera; input always player-initiated with a visible indicator), consent-at-join, recording disclosure, photosensitivity safety. **Why:** the overt-vs-covert line separates a consensual party game from surveillance — required both by App Store review and by ethics. Non-negotiable.

## D11 — AI providers: Anthropic (Claude) + ElevenLabs (Scribe STT + TTS)
**Why:** consolidating audio AI onto one vendor — ElevenLabs **Scribe** for STT and ElevenLabs for TTS — plus Claude for the LLM means two vendors and two keys, both already provisioned in `.env.local`. This replaces the earlier Deepgram-for-STT placeholder. All three stay behind adapter interfaces, so a future swap (e.g. a dedicated streaming STT) is a localized change.
**Nuance:** Scribe is ideal for the **batch** STT case (push-to-talk clips at M3, and transcript/summary work). For **continuous live room transcription** (M6), confirm Scribe's realtime/streaming endpoint or segment the audio into short chunks — decide at M6. Not needed before then.
