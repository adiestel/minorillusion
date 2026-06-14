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

## D12 — Parchment (and rich effects) are WebGL islands, not DOM/CSS — refines D7
**Why (M1 design review):** the CSS parchment looked unnatural — CSS can only scale/skew a flat rectangle, so an "unfurl" degraded into a rectangle expanding/contracting. Realistic paper needs real geometry (a mesh that folds/unrolls with lighting + self-shadow) and particles (burn-to-ash embers), which CSS cannot fake. So we **add a 5th GL-island trigger to D7: "material/physics realism CSS can't fake" (paper fold, fire, particles),** and the parchment message moves from the cheap DOM tier to a **transient WebGL island** (React-Three-Fiber, lazy-loaded). This pulls the GL-island foundation forward from M4 — it's the basis for every rich effect. Islands stay transient (mount on message, unmount when idle), so battery/thermals are unaffected. Varied natural entrances (unfold / lay-in / unroll) avoid the mechanical feel.

## D13 — Reverted: the parchment is DOM/CSS, not a WebGL island (supersedes D12)
**Why (M1 design review, take 2):** the WebGL parchment from D12 was built and rejected — the fold read hokey, the lighting was wrong (an orange color-space bug), the ink looked fake, and the burn had a state bug. Two lessons: (a) *process* — it was built **blind**, with no rendered frame reviewed; for hero visuals we now iterate with a **screenshot feedback loop**; (b) *fit* — realistic paper *fold* isn't worth a GL island when a restrained DOM/CSS treatment looks better. The shipped parchment is **DOM/CSS done well**: the real texture, **IM Fell English**, a **torn/deckled edge via an SVG feTurbulence + feDisplacementMap filter** (the drop-shadow follows the torn silhouette; ink stays crisp on a layer above), a restrained fade-and-rise entrance + ink fade-in. **3D stays reserved for genuinely-3D/interactive effects (crystal ball, dice); fire/burn will use a pre-rendered Veo clip, not a real-time shader.** So D7's "material realism" island trigger applies only to true-3D/interactive cases — not to anything a tasteful 2D treatment nails.

## D14 — Effect engine generalization + storm is cheap-path (CSS + audio), not video — refines D3/D7
**Why (M2):** M1 proved the spine with a single `message` effect. M2 generalizes it into a real **effect engine** without over-building: the contract now carries a discriminated **EffectSpec** union (`message | audio | haptic | ambiance | heartbeat`), the server *router* stamps each spec into a **DeliveredEffect** (minting id/createdAt, resolving TTS to an inline `data:` audio URL), and a light **choreography** primitive — every effect can carry a `startDelayMs`, and `effect:cue` fires a *bundle* of specs at one target each with its own offset, which each player schedules locally (so a "thunderclap + screen-flash + buzz" moment lands in time across the set regardless of per-step network jitter). This is the whole "choreographed canvas" idea in two small contract additions, not a heavyweight sequencer.
**Audio/TTS:** sound effects are **bundled mp3 cues** (`apps/player/public/audio/<cue>.mp3`, generated via ElevenLabs sound-generation) played on the cheap path; **TTS** goes through a `TtsProvider` adapter (ElevenLabs, behind the D11 interface) and is delivered as an **inline `data:` URL** on an `audio` effect — no object storage needed yet (deferred per STACK). Audio is **unlocked on the consent/join tap** (iOS autoplay).
**Storm = cheap path, not Veo video (refines the ROADMAP's "storm-via-pre-rendered-video"):** the rendering memory already lists "storm/rain/lightning ambiance" under the cheap path, and D7 says ship the cheap version first. So the storm `ambiance` scene is **DOM/CSS**: a cold blue-grey vignette wash + JS-timed lightning (brief, randomized 4–9s apart, fixed brightness — **photosensitivity-safe per D10**, never a strobe) + faint CSS rain streaks + a looping rain audio bed. A pre-rendered Veo loop stays a possible *later* enhancement, not a dependency. Heartbeat is likewise cheap (a red edge-vignette pulse + a haptic train).
**Consent (D10) is enforced here:** joining now shows a disclosure of what the GM can do this session (sound / vibration / screen) and that mic/camera are never silently used; the accept tap is what unlocks audio and emits `circle:join`.
**Note (bug fixed in passing):** the player applied its theme CSS vars to `#root`, but `body { font-family: var(--font) }` reads them from `body` (the parent) — custom properties inherit downward, so the UI silently fell back to serif. Vars now go on `:root` (documentElement). Caught by the screenshot feedback loop (D13), which also confirmed the storm visual.
