# M6 — Intelligence layer — plan

> Forward plan for M6 (see `ROADMAP.md`). Drafted while M5's UI subagents run;
> refine once M5 lands. M6 introduces **Claude** (behind an adapter, D11) and
> continuous room capture.

## Definition of done (ROADMAP)
GM-laptop room capture → STT transcript. LLM: transcript filtering (ignore
cross-talk), configurable session summaries (with source selection), ad-hoc log
editing. LLM **agents as actors** (configured knowledge + TTS voices). **Dissonant
Whispers** (wake-word / smart triggers / smart TTS).

## Shape (reuses the existing spine)
- **Room capture** lives on the GM laptop (D2): the GM page captures mic audio,
  chunks it (Scribe is batch-friendly — D11 nuance: segment into short chunks for
  "live" transcription), and streams `transcript:chunk` to the server → STT (the
  existing `stt.ts` adapter) → a growing per-circle **transcript** pushed to GMs.
  Recording disclosure + a visible indicator are required (D10) — GM-initiated.
- **LLM behind an adapter** (`apps/server/src/llm.ts`, mirrors `tts.ts`/`stt.ts`):
  `LlmProvider.complete(messages)` → Anthropic (`ANTHROPIC_API_KEY`, already in
  `.env.example`); `NullLlm` when no key. Key never logged.
- **Transcript filtering + summaries + log editing**: server endpoints/handlers
  that run the transcript (or a GM-selected slice) through the LLM → a filtered
  log / a summary; the GM can hand-edit. Persist logs/summaries (Drizzle) — this
  also seeds M7's "player log history".
- **Agents as actors** (D3): an agent is a configured actor (name, a knowledge
  blurb, a TTS voice) that the GM (or a trigger) prompts; the LLM reply becomes
  **any effect** (a parchment message, a spoken TTS line) routed by the existing
  router. No new delivery plumbing — agents emit through the effect engine.
- **Dissonant Whispers (smart)**: extend the M2 whisperscape — wake-word / smart
  triggers off the transcript pick the phrase + voice via the LLM, instead of a
  fixed GM library. Builds on the committed whisperscape runner.

## Decomposition (subagents)
1. **Contract (me):** transcript chunk/entry, transcript state, summary request/
   result, log entry + edit, agent definition + `agent:prompt`/reply, smart-whisper
   trigger config. Events both ways. + tests.
2. **LLM adapter (subagent):** `llm.ts` (Anthropic + Null) + tests, mirroring the
   TTS/STT pattern. Key-safe.
3. **Server (subagent):** transcript ingest + STT chunking, transcript/summary/log
   persistence + handlers, agent-as-actor prompt→effect, smart-whisper trigger.
4. **GM UI (subagent):** capture toggle + recording indicator, live transcript,
   summary/log panel (source selection + edit), agent config + "speak as agent".
5. **Player (subagent):** nothing new structurally — agent effects arrive through
   the existing effect:deliver path (parchment / TTS). Maybe a capture-consent note.
6. **Smoke (me):** transcript chunk → STT → GM; summary (LLM gated like SMOKE_TTS);
   agent prompt → effect delivered; smart-whisper trigger.

## Guards (carry forward)
Recording disclosure + visible indicator + GM-initiated capture (D10); no silent
mic; LLM/STT/TTS keys read from env only, never logged; providers behind adapters
so a swap stays localized (D11).
