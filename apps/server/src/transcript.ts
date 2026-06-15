import { randomUUID } from "node:crypto";
import type {
  SummarizeRequest,
  TranscriptEntry,
  TranscriptState,
} from "@minorillusion/contract";

/**
 * The room transcript/log as PURE helpers (M6 — the intelligence layer). The
 * transcript is TRANSIENT session state: the socket layer holds a
 * `Map<circleId, TranscriptState>` in memory (like the initiative tracker, not
 * persisted — only the produced summaries are durable) and feeds it through these
 * helpers, so the add/edit/delete rules are unit-testable in isolation. Every
 * helper returns a NEW state (no mutation of the input). See src/transcript.test.ts.
 *
 * Room capture is GM-initiated, disclosed, and shows a recording indicator
 * (INVIOLABLE D10): the server never captures on its own — it only ever appends
 * a chunk the GM laptop already recorded, a hand-typed line, or an agent line.
 */

/** An empty (not-recording, no entries) transcript for a circle. */
export function emptyTranscript(circleId: string): TranscriptState {
  return { circleId, recording: false, entries: [] };
}

/** How an entry's text/speaker is sourced when appended. */
export interface NewEntry {
  text: string;
  speaker?: string;
  source: TranscriptEntry["source"];
}

/**
 * Append a log line, stamping a fresh uuid + ISO timestamp and carrying the
 * circle id from the state. `speaker` rides only when provided (so the wire shape
 * matches the contract's optional field — never an explicit undefined). Returns
 * the next state plus the minted entry (the handler acks the entry).
 */
export function addEntry(
  state: TranscriptState,
  input: NewEntry,
): { state: TranscriptState; entry: TranscriptEntry } {
  const entry: TranscriptEntry = {
    id: randomUUID(),
    circleId: state.circleId,
    at: new Date().toISOString(),
    text: input.text,
    ...(input.speaker !== undefined && input.speaker !== ""
      ? { speaker: input.speaker }
      : {}),
    source: input.source,
  };
  return {
    state: { ...state, entries: [...state.entries, entry] },
    entry,
  };
}

/**
 * Edit a line's text by id. Returns the next state and whether a line changed
 * (false → no such id). The entry keeps its id/at/speaker/source; only `text` is
 * replaced.
 */
export function editEntry(
  state: TranscriptState,
  entryId: string,
  text: string,
): { state: TranscriptState; changed: boolean } {
  let changed = false;
  const entries = state.entries.map((e) => {
    if (e.id !== entryId) return e;
    changed = true;
    return { ...e, text };
  });
  return { state: changed ? { ...state, entries } : state, changed };
}

/**
 * Remove a line by id. Returns the next state and whether a line was removed
 * (false → no such id).
 */
export function deleteEntry(
  state: TranscriptState,
  entryId: string,
): { state: TranscriptState; removed: boolean } {
  const entries = state.entries.filter((e) => e.id !== entryId);
  const removed = entries.length !== state.entries.length;
  return { state: removed ? { ...state, entries } : state, removed };
}

/** Set the recording flag, returning a new state (drives the D10 indicator). */
export function setRecording(
  state: TranscriptState,
  recording: boolean,
): TranscriptState {
  return { ...state, recording };
}

/**
 * The lines a summarize request covers: the selected `entryIds` (in transcript
 * order) when given, else the whole transcript. Unknown ids are simply absent
 * from the result (no error) — a stale selection summarizes what still exists.
 */
export function selectEntries(
  state: TranscriptState,
  entryIds?: string[],
): TranscriptEntry[] {
  if (entryIds === undefined) return state.entries;
  const wanted = new Set(entryIds);
  return state.entries.filter((e) => wanted.has(e.id));
}

/**
 * Render the selected transcript lines into the plain-text body the LLM
 * summarizes — one line per entry, prefixed with its speaker when tagged. Pure
 * (no I/O) so it's covered directly. Empty when there are no lines.
 */
export function renderTranscript(entries: TranscriptEntry[]): string {
  return entries
    .map((e) => (e.speaker ? `${e.speaker}: ${e.text}` : e.text))
    .join("\n");
}

/** The per-style instruction Claude follows when writing a summary. */
const STYLE_DIRECTIVE: Record<SummarizeRequest["style"], string> = {
  recap:
    "Write a concise prose recap of what happened — the key story beats, " +
    "decisions, and outcomes — in past tense, a few short paragraphs.",
  bullets:
    "Write a tight bulleted list of the key events, decisions, and outcomes. " +
    "One short bullet per beat; no preamble.",
  dramatic:
    "Narrate the events as in-world, dramatic storyteller's prose — evocative " +
    "and atmospheric, as a chronicle of the tale — while staying faithful to " +
    "what actually happened.",
};

/**
 * Build the system prompt for a summary in the requested style. The standing
 * instruction tells Claude to FILTER OUT-OF-CHARACTER cross-talk and table
 * chatter (rules questions, snack runs, side conversations, meta jokes) and keep
 * only what advances the story, then write in the chosen voice. Pure so the
 * handler stays thin and the prompt is testable.
 */
export function summarySystemPrompt(style: SummarizeRequest["style"]): string {
  return (
    "You are the chronicler for a tabletop RPG session. You are given a raw " +
    "room transcript that mixes in-character play with out-of-character table " +
    "chatter. FILTER OUT the cross-talk — rules lookups, scheduling, snack and " +
    "bathroom breaks, side conversations, real-world tangents, and meta jokes " +
    "— and summarize ONLY the in-story events. Do not invent anything that is " +
    "not supported by the transcript. " +
    STYLE_DIRECTIVE[style]
  );
}
