# M6 — Intelligence layer — progress tracker

> Working log for M6 (see `ROADMAP.md` / `M6-PLAN.md`): room capture → STT
> transcript; Claude for filtering / summaries / log editing; LLM agents as
> actors; smart whispers. Claude behind an adapter (D11); capture GM-initiated +
> disclosed (D10).

## Plan
### Commit 1 — M6 core (contract + LLM adapter) — ✓ DONE (`a928836`)
- [x] Contract: transcript entry/state, captured-audio chunk + manual add + edit,
      summary (style + source selection), Agent (knowledge + voice) + save/list/
      delete + prompt-as-effect; events both ways incl. `capture:state`
      disclosure. +3 tests.
- [x] `apps/server/src/llm.ts` — `LlmProvider` behind an adapter: `AnthropicLlm`
      (Claude Messages API, key from env only, status-only errors), `NullLlm`,
      `getLlmProvider()`. +2 tests (126 server).

### Commit 2 — M6 server (transcript/summary/agents) — ✓ DONE (subagent)
- [x] `agents` + `summaries` Drizzle tables + migration; `agents.ts`/`summaries.ts`
      services (DB-persisted) + pure `transcript.ts` helpers (in-memory per-circle
      transcript). Handlers: capture:set (+ capture:state to players),
      transcript:chunk (STT)/add/edit/list, summarize (LLM, cross-talk filtered,
      persisted), agent:save/list/delete, agent:prompt (LLM grounded in knowledge
      → delivered as an effect via buildEffect, logged as an agent entry).
      circle:open re-push; disconnect clears transcript. +27 tests (153 server).

### Commit 3 — M6 clients (GM Lore tab + player disclosure) — ✓ DONE (subagents)
- [x] GM `Lore.tsx` + tab: room-capture record button (GM-laptop getUserMedia +
      MediaRecorder 7s chunking → transcript:chunk, visible ● Recording indicator,
      mic released on stop) + live transcript (add/edit/delete) + summary panel
      (style + source selection) + agents CRUD + prompt-an-agent (voice/message,
      target, whispers/echo).
- [x] Player: a `RecordingIndicator` on `capture:state` (D10 disclosure, z 46) +
      a consent-copy line disclosing room capture/transcription.

### Verification
- `scripts/smoke-m6.mjs` (`smoke:m6`): capture disclosure to the player, transcript
  add/edit/delete, chunk graceful-fail, summary + agent wiring (live content gated
  by `SMOKE_LLM=1`), agent delete.

## Verification log
- 2026-06-15 — Commit 1: contract 38 + server 126 tests; typecheck 5/5. Pushed `a928836`.
- 2026-06-15 — Launched 3 subagents (server / gm-web / player) for commits 2–3; smoke-m6 written.
- 2026-06-15 — All 3 subagents landed + integrated: `pnpm typecheck` 5/5; `pnpm test` 212 (contract 38 + server 153 + player 21); `pnpm build` 3/3; `pnpm smoke:m6` → PASSED (capture disclosure, transcript CRUD, graceful chunk-fail, live Claude summary + agent reply both succeeded with the key present). **M6 complete.**
