# Tech Stack & Local Development

## Philosophy
**Self-hosted, run locally first, deploy later.** No SaaS platform in the critical path. The reason: a persistent WebSocket server is unavoidable for the realtime core, which defeats the "no server to run" pitch of serverless/BaaS. Once one always-on server is required anyway, co-locating the API, DB, and auth on it is marginal cost — and it buys one mental model, predictable flat cost, no vendor lock-in, and **local == prod** (deployment later is "run the same Docker Compose on the box," likely the user's own Linux server, optionally via Kamal).

(Vercel is specifically ruled out: serverless can't host a WebSocket server; it would force a managed realtime SaaS — the opposite of the goal.)

## Monorepo
pnpm workspaces + Turborepo.

```
apps/
  server/        Fastify (REST) + Socket.IO (realtime) + Drizzle
  gm-web/        React + Vite — GM control surface
  player/        React + Vite + Capacitor — player client
packages/
  contract/      zod schemas + TS types: the wire protocol, effects, targets  (SOURCE OF TRUTH)
  design-system/ shared UI primitives + per-plane theme tokens
docker-compose.yml   Postgres (local)
```

## Components
- **Language:** TypeScript everywhere.
- **Server:** Node + Fastify (REST) + Socket.IO (rooms = circles). Self-hosted realtime; scale later via a Redis adapter + sticky sessions.
- **DB:** Postgres + Drizzle ORM.
- **Frontends:** React + Vite (both planes). Player wrapped in Capacitor (iOS + Android); plugins: Haptics, Torch, NFC, BLE, Push, Background Audio, Wake Lock, Motion, Camera.
- **Auth:** Lucia/better-auth (a library — never hand-rolled). GM accounts persistent; players lightweight. Sign in with Apple required for iOS social login.
- **Storage:** behind a `Storage` interface — local filesystem in dev, Cloudflare R2 + CDN later (for serving effect video to phones). No code change to swap.
- **AI (behind adapters; deferred until their milestone):** Claude (LLM — agents, triggers, summaries) + **ElevenLabs** for both **Scribe** (STT) and **TTS** — consolidated to two vendors. Keys for both live in gitignored `.env.local` (variable names in `.env.example`). Not needed until M3 (PTT STT) / M6 (intelligence). *Scribe covers batch STT (PTT clips, transcripts) well; confirm its realtime/streaming path for continuous room capture at M6, or chunk the audio.*

## Capability seam & PWA
Player device capabilities go through interfaces with Capacitor-native + web implementations. This yields the PWA target for free (native-first; iOS PWA degraded, Android nearly full). A manifest + service worker add installability when wanted.

## Secrets & environment
API keys live in **`.env.local`** at the repo root (gitignored — never committed). **`.env.example`** documents the required variable names with placeholder values. Current keys: **Anthropic** (Claude) and **ElevenLabs** (Scribe STT + TTS). Code reads them from `process.env`; never inline a key or pull `.env.local` contents into a tool/transcript.

## Local development
- `docker compose up` — Postgres.
- `pnpm dev` — server + both Vite apps.
- Develop the player in the browser for speed; `cap run ios|android` (with live-reload to the dev server) only when testing native capabilities. **A physical phone is required from M2** (the iOS Simulator can't do haptics / torch / real camera).
- (Exact scripts/versions land with the M0 scaffold; target Node 20+, pnpm, Docker.)

## Deferred decisions (not needed to start)
- **Deployment target** — local first; likely the user's Linux server later (Kamal or `docker compose`).
- **Managed vs. self-hosted Postgres** — irrelevant locally; revisit at deploy.
- **AI provider keys/budget** — deferred to M3/M6; providers are swappable behind adapters.
