/**
 * Lore — M6 GM intelligence layer (the Lore tab).
 *
 * Three stacked cards, matching the other console panels (card surface, uppercase
 * ember section headings, the select / toggle / chip idioms):
 *
 *   1. Room capture + transcript — a Start/Stop recording button that captures the
 *      GM laptop's mic (getUserMedia + MediaRecorder, ~7s timeslice). Each chunk is
 *      turned into a data: URL and sent to the server (`transcript:chunk`) to be
 *      transcribed + appended. INVIOLABLE (D10): capture is GM-initiated, shows a
 *      clearly visible "● recording" indicator, and toggling also tells the server
 *      (`capture:set`) so it can disclose to players. We feature-detect the mic and
 *      degrade gracefully (a note; the manual add-line path always works). Below:
 *      the live transcript (newest-first), a manual "add line" input
 *      (`transcript:add`), and edit/delete per line (`transcript:edit`).
 *   2. Summary — a style selector (recap / bullets / dramatic), an optional source
 *      selection (whole session vs a checked subset → `entryIds`), and a Summarize
 *      button (`summarize`). The LLM is optional (like TTS): on ok:false we show the
 *      returned error inline (e.g. "set ANTHROPIC_API_KEY"). A few recent summaries
 *      are kept locally.
 *   3. Agents — CRUD for LLM agents (name, knowledge/persona, an optional ElevenLabs
 *      voice id) via `agent:save` / `agent:delete`; the roster comes from
 *      `agents:list`. A "Prompt agent" form picks an agent + a prompt, a deliver-as
 *      (voice / message), a target (broadcast or specific players), and optional
 *      whisper/echo treatment for spoken replies → `agent:prompt`. The reply text +
 *      deliveredTo are shown.
 *
 * App (CirclePanel) owns the live `transcript` + `agents` state and the socket
 * listeners (`transcript:update`, `agents:list`) and passes them down; this panel
 * renders + emits. The transcript/agent rosters are AUTHORITATIVE on the server —
 * we only ask; the pushed state drives the UI (we don't optimistically mutate).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Agent,
  Player,
  PromptAgentRequest,
  PromptAgentResult,
  SaveAgentRequest,
  SaveAgentResult,
  SummarizeRequest,
  SummarizeResult,
  Summary,
  Target,
  TranscriptEntry,
  TranscriptState,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";
import { usePersistentState } from "./usePersistentState";

/** Danger red (the palette has no red; matches Party.tsx's literal). */
const DANGER_RED = "#e5484d";

/** How often MediaRecorder emits a chunk (ms). Short clips are STT-friendly (D11). */
const CHUNK_MS = 7000;

/** Recent summaries kept in the panel (newest-first). */
const SUMMARY_CAP = 5;

type SummaryStyle = Summary["style"];

// ===========================================================================
// Main panel
// ===========================================================================

interface LoreProps {
  players: Player[];
  transcript: TranscriptState | null;
  agents: Agent[];
}

export function Lore({ players, transcript, agents }: LoreProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(6) }}>
      <CaptureCard transcript={transcript} />
      <SummaryCard transcript={transcript} />
      <AgentsCard players={players} agents={agents} />
    </div>
  );
}

// ===========================================================================
// 1. Room capture + live transcript
// ===========================================================================

/** Feature-detect the bits we need to record room audio. */
function captureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    navigator.mediaDevices !== undefined &&
    typeof navigator.mediaDevices.getUserMedia === "function" &&
    typeof window !== "undefined" &&
    typeof window.MediaRecorder === "function"
  );
}

/** Read a Blob as a data: URL (so the chunk rides the JSON wire like an M3 clip). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(blob);
  });
}

function CaptureCard({ transcript }: { transcript: TranscriptState | null }) {
  const supported = useMemo(captureSupported, []);

  const [recording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A small status line for the most recent chunk send (server transcribes async).
  const [chunkStatus, setChunkStatus] = useState<string | null>(null);

  // Live recorder handles — kept in refs so they survive re-renders and we can
  // stop every track on stop / unmount (D10: stopping must release the mic).
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  /** Tear down the recorder + release every mic track. Safe to call repeatedly. */
  function teardown() {
    const rec = recorderRef.current;
    if (rec !== null && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
    recorderRef.current = null;
    const stream = streamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
    }
    streamRef.current = null;
  }

  // Always release the mic if the panel unmounts mid-recording.
  useEffect(() => {
    return () => {
      teardown();
      // Best-effort: tell the server capture ended so the player disclosure clears.
      if (recorderRef.current !== null) socket.emit("capture:set", { recording: false });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Send one captured chunk to the server to transcribe + append. */
  function sendChunk(blob: Blob, mimeType: string) {
    if (blob.size === 0) return;
    blobToDataUrl(blob)
      .then((audio) => {
        socket.emit(
          "transcript:chunk",
          { audio, ...(mimeType ? { mimeType } : {}) },
          (result) => {
            // The server pushes transcript:update to App on success — that single
            // path drives the list. Here we only surface a transient status / error.
            if (result.ok) {
              setChunkStatus(
                result.entry !== null ? "transcribed a clip" : "clip sent (no speech detected)",
              );
            } else {
              setChunkStatus(`chunk error: ${result.error}`);
            }
          },
        );
      })
      .catch(() => setChunkStatus("could not encode the audio chunk"));
  }

  async function start() {
    if (!supported || recording) return;
    setError(null);
    setChunkStatus(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;
      const mimeType = recorder.mimeType || "audio/webm";

      recorder.ondataavailable = (e: BlobEvent) => {
        if (e.data && e.data.size > 0) sendChunk(e.data, mimeType);
      };

      // Timeslice → a fresh chunk every CHUNK_MS while recording.
      recorder.start(CHUNK_MS);
      setRecording(true);
      socket.emit("capture:set", { recording: true });
    } catch (err) {
      teardown();
      setRecording(false);
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone permission denied."
          : "Could not start the microphone.";
      setError(message);
    }
  }

  function stop() {
    teardown();
    setRecording(false);
    socket.emit("capture:set", { recording: false });
  }

  // Newest-first transcript view.
  const entries = transcript?.entries ?? [];
  const ordered = useMemo(
    () => [...entries].sort((a, b) => b.at.localeCompare(a.at)),
    [entries],
  );

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Room capture &amp; transcript</h2>

      {/* Disclosure — capture is GM-initiated + announced to players (D10). */}
      <p style={hintStyle}>
        Records this laptop's microphone and transcribes the table in short clips.
        Players are shown a recording indicator while it runs. Stop any time — the
        mic is released immediately.
      </p>

      {/* Start / stop + the visible recording indicator. */}
      <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(3), flexWrap: "wrap" }}>
        {!supported ? (
          <button disabled style={primaryButtonStyle(true)} title="This browser can't capture audio">
            Recording unavailable
          </button>
        ) : recording ? (
          <button onClick={stop} style={stopButtonStyle}>
            Stop recording
          </button>
        ) : (
          <button onClick={start} style={primaryButtonStyle(false)}>
            Start recording
          </button>
        )}

        {recording && <RecordingIndicator />}
      </div>

      {!supported && (
        <p style={{ ...hintStyle, marginTop: space(2), color: DANGER_RED }}>
          This browser can't capture audio — add lines by hand below instead.
        </p>
      )}
      {error && (
        <p style={{ margin: `${space(2)} 0 0`, fontSize: "0.82rem", color: DANGER_RED }}>
          {error}
        </p>
      )}
      {chunkStatus && (
        <p style={{ margin: `${space(2)} 0 0`, fontSize: "0.8rem", color: "var(--text-dim)" }}>
          {chunkStatus}
        </p>
      )}

      {/* Manual add-line — the guaranteed path (works with no STT key). */}
      <AddLineRow />

      {/* The live transcript / log — newest first. */}
      <label style={{ ...labelStyle, marginTop: space(5) }}>Transcript</label>
      {ordered.length === 0 ? (
        <p style={{ ...emptyStyle, marginTop: space(2) }}>
          No lines yet — start recording, or add a line by hand.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(2) }}>
          {ordered.map((entry) => (
            <TranscriptRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// RecordingIndicator — the clearly-visible "● recording" badge (D10)
// ---------------------------------------------------------------------------

function RecordingIndicator() {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="recording in progress"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: space(2),
        padding: `${space(1)} ${space(3)}`,
        background: palette.emberDim,
        border: `1px solid ${DANGER_RED}`,
        borderRadius: radius.pill,
        color: palette.bone,
        fontSize: "0.78rem",
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 9,
          height: 9,
          borderRadius: radius.pill,
          background: DANGER_RED,
          boxShadow: `0 0 6px ${DANGER_RED}`,
          animation: "mi-rec-pulse 1.1s ease-in-out infinite",
        }}
      />
      Recording
      {/* Keyframes inlined so the panel is self-contained (no global CSS edit). */}
      <style>{"@keyframes mi-rec-pulse{0%,100%{opacity:1}50%{opacity:0.25}}"}</style>
    </span>
  );
}

// ---------------------------------------------------------------------------
// AddLineRow — hand-typed log line (the guaranteed path)
// ---------------------------------------------------------------------------

function AddLineRow() {
  const [speaker, setSpeaker] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  function handleAdd() {
    const body = text.trim();
    if (body.length === 0 || busy) return;
    setBusy(true);
    const sp = speaker.trim();
    socket.emit(
      "transcript:add",
      { text: body.slice(0, 4000), ...(sp ? { speaker: sp.slice(0, 60) } : {}) },
      () => {
        // The server pushes transcript:update; just clear the input.
        setBusy(false);
        setText("");
      },
    );
  }

  return (
    <div style={{ display: "flex", gap: space(2), marginTop: space(4), flexWrap: "wrap", alignItems: "flex-end" }}>
      <div style={{ flex: "0 1 130px", display: "flex", flexDirection: "column", gap: space(1) }}>
        <label style={labelStyle}>Speaker</label>
        <input
          type="text"
          placeholder="Optional"
          value={speaker}
          maxLength={60}
          onChange={(e) => setSpeaker(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          style={textInputStyle}
        />
      </div>
      <div style={{ flex: "1 1 200px", display: "flex", flexDirection: "column", gap: space(1) }}>
        <label style={labelStyle}>Add a line</label>
        <input
          type="text"
          placeholder="What was said…"
          value={text}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
          style={textInputStyle}
        />
      </div>
      <button onClick={handleAdd} disabled={text.trim().length === 0 || busy} style={secondaryButtonStyle(text.trim().length === 0 || busy)}>
        Add
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TranscriptRow — one log line + inline edit / delete
// ---------------------------------------------------------------------------

function TranscriptRow({ entry }: { entry: TranscriptEntry }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(entry.text);
  const [busy, setBusy] = useState(false);

  // Keep the edit draft in sync if the line changes underneath us (server push).
  useEffect(() => {
    if (!editing) setDraft(entry.text);
  }, [entry.text, editing]);

  function commit() {
    const next = draft.trim();
    if (next.length === 0 || next === entry.text) {
      setEditing(false);
      setDraft(entry.text);
      return;
    }
    setBusy(true);
    socket.emit("transcript:edit", { entryId: entry.id, text: next.slice(0, 4000) }, () => {
      setBusy(false);
      setEditing(false);
    });
  }

  function handleDelete() {
    if (busy) return;
    setBusy(true);
    socket.emit("transcript:edit", { entryId: entry.id, delete: true }, () => {
      // The line vanishes from props when the server re-pushes the transcript.
      setBusy(false);
    });
  }

  return (
    <div style={transcriptRowStyle}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space(3) }}>
        <span style={{ display: "flex", alignItems: "baseline", gap: space(2), minWidth: 0 }}>
          <SourceTag source={entry.source} />
          {entry.speaker && (
            <span style={{ fontWeight: 700, color: "var(--text)", fontSize: "0.84rem" }}>
              {entry.speaker}
            </span>
          )}
          <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
            {formatTime(entry.at)}
          </span>
        </span>
        <span style={{ display: "flex", gap: space(1), flexShrink: 0 }}>
          {!editing && (
            <button style={miniButtonStyle} onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          <button style={miniDangerButtonStyle} onClick={handleDelete} disabled={busy}>
            {busy ? "…" : "Delete"}
          </button>
        </span>
      </div>

      {editing ? (
        <div style={{ display: "flex", gap: space(2), marginTop: space(2), alignItems: "stretch" }}>
          <input
            type="text"
            value={draft}
            maxLength={4000}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setEditing(false);
                setDraft(entry.text);
              }
            }}
            style={{ ...textInputStyle, flex: 1, minWidth: 0 }}
          />
          <button onClick={commit} disabled={busy} style={secondaryButtonStyle(busy)}>
            Save
          </button>
        </div>
      ) : (
        <p style={transcriptTextStyle}>{entry.text}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SourceTag — how a line entered the log (capture / manual / agent)
// ---------------------------------------------------------------------------

function SourceTag({ source }: { source: TranscriptEntry["source"] }) {
  const label = source === "capture" ? "heard" : source === "agent" ? "agent" : "added";
  return (
    <span
      title={`source: ${source}`}
      style={{
        flexShrink: 0,
        padding: `0 ${space(2)}`,
        fontSize: "0.62rem",
        fontWeight: 700,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: palette.parchmentDim,
        background: palette.ash,
        borderRadius: radius.pill,
      }}
    >
      {label}
    </span>
  );
}

// ===========================================================================
// 2. Summary
// ===========================================================================

function SummaryCard({ transcript }: { transcript: TranscriptState | null }) {
  const [style, setStyle] = usePersistentState<SummaryStyle>("mi.gm.lore.summaryStyle", "recap");
  // Source: the whole session, or a checked subset of lines.
  const [scope, setScope] = useState<"all" | "selection">("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summaries, setSummaries] = useState<Summary[]>([]);

  const entries = transcript?.entries ?? [];
  // Newest-first for the picker, mirroring the transcript view.
  const ordered = useMemo(
    () => [...entries].sort((a, b) => b.at.localeCompare(a.at)),
    [entries],
  );

  // Drop any selected ids that no longer exist (a line was deleted).
  useEffect(() => {
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(entries.map((e) => e.id));
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (live.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [entries]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const usingSelection = scope === "selection" && selected.size > 0;
  const canSummarize = !busy && entries.length > 0 && (scope === "all" || selected.size > 0);

  function handleSummarize() {
    if (!canSummarize) return;
    setError(null);
    setBusy(true);
    const req: SummarizeRequest = {
      style,
      ...(usingSelection ? { entryIds: Array.from(selected) } : {}),
    };
    socket.emit("summarize", req, (res: SummarizeResult) => {
      setBusy(false);
      if (res.ok) {
        setSummaries((prev) => [res.summary, ...prev].slice(0, SUMMARY_CAP));
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Summary</h2>
      <p style={hintStyle}>
        Claude reads the transcript (filtering cross-talk) and writes a session
        summary. Optional — needs a configured LLM key; otherwise it'll say so.
      </p>

      {/* Style */}
      <label style={{ ...labelStyle, marginTop: space(3) }}>Style</label>
      <div style={{ display: "flex", gap: space(2), marginTop: space(1) }}>
        {(["recap", "bullets", "dramatic"] as const).map((s) => (
          <SmallToggle key={s} active={style === s} onClick={() => setStyle(s)}>
            {summaryStyleLabel(s)}
          </SmallToggle>
        ))}
      </div>

      {/* Source */}
      <label style={{ ...labelStyle, marginTop: space(4) }}>Source</label>
      <div style={{ display: "flex", gap: space(2), marginTop: space(1) }}>
        <SmallToggle active={scope === "all"} onClick={() => setScope("all")}>
          Whole session
        </SmallToggle>
        <SmallToggle active={scope === "selection"} onClick={() => setScope("selection")}>
          Pick lines{selected.size > 0 ? ` (${selected.size})` : ""}
        </SmallToggle>
      </div>

      {scope === "selection" && (
        <div style={{ display: "flex", flexDirection: "column", gap: space(1), marginTop: space(2), maxHeight: 220, overflowY: "auto" }}>
          {ordered.length === 0 ? (
            <p style={emptyStyle}>No lines to pick from yet.</p>
          ) : (
            ordered.map((entry) => (
              <label key={entry.id} style={pickRowStyle}>
                <input
                  type="checkbox"
                  checked={selected.has(entry.id)}
                  onChange={() => toggle(entry.id)}
                  style={{ accentColor: palette.ember, cursor: "pointer", flexShrink: 0 }}
                />
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "0.82rem", color: "var(--text-dim)" }}>
                  {entry.speaker ? <strong style={{ color: "var(--text)" }}>{entry.speaker}: </strong> : null}
                  {entry.text}
                </span>
              </label>
            ))
          )}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(4) }}>
        <button onClick={handleSummarize} disabled={!canSummarize} style={primaryButtonStyle(!canSummarize)}>
          {busy ? "Summarizing…" : "Summarize"}
        </button>
        {entries.length === 0 && (
          <span style={{ fontSize: "0.78rem", color: palette.parchmentDim }}>
            Nothing to summarize yet.
          </span>
        )}
        {error && <span style={{ color: DANGER_RED, fontSize: "0.82rem" }}>{error}</span>}
      </div>

      {/* Recent summaries — newest first. */}
      {summaries.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: space(3), marginTop: space(4) }}>
          {summaries.map((s) => (
            <SummaryBlock key={s.id} summary={s} />
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SummaryBlock — one returned summary
// ---------------------------------------------------------------------------

function SummaryBlock({ summary }: { summary: Summary }) {
  return (
    <div
      style={{
        padding: `${space(3)} ${space(4)}`,
        background: "var(--bg)",
        borderRadius: radius.md,
        borderLeft: `3px solid ${palette.ember}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space(3), marginBottom: space(2) }}>
        <span style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: palette.ember }}>
          {summaryStyleLabel(summary.style)}
        </span>
        <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
          {formatTime(summary.createdAt)}
        </span>
      </div>
      <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
        {summary.text}
      </p>
    </div>
  );
}

// ===========================================================================
// 3. Agents — roster + CRUD + the prompt form
// ===========================================================================

function AgentsCard({ players, agents }: { players: Player[]; agents: Agent[] }) {
  // The id of the agent being edited (null = the add form is fresh).
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = useMemo(
    () => agents.find((a) => a.id === editingId) ?? null,
    [agents, editingId],
  );

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Agents</h2>
      <p style={hintStyle}>
        Configure LLM characters — a persona/knowledge brief and an optional voice.
        Prompt one and its reply is delivered to your players as a spoken line or a
        parchment message.
      </p>

      {agents.length === 0 ? (
        <p style={{ ...emptyStyle, marginTop: space(3) }}>
          No agents yet — define one below.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(3) }}>
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              editing={a.id === editingId}
              onEdit={() => setEditingId(a.id)}
            />
          ))}
        </div>
      )}

      {/* The add / edit form — a fresh key per target resets its internal state. */}
      <AgentForm
        key={editing?.id ?? "new"}
        editing={editing}
        onDone={() => setEditingId(null)}
      />

      {/* Prompt an agent → its reply is delivered as an effect. */}
      <PromptAgentForm players={players} agents={agents} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// AgentRow — one roster entry + edit / delete
// ---------------------------------------------------------------------------

function AgentRow({
  agent,
  editing,
  onEdit,
}: {
  agent: Agent;
  editing: boolean;
  onEdit: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  function handleDelete() {
    if (deleting) return;
    setDeleting(true);
    socket.emit("agent:delete", { agentId: agent.id }, () => {
      // The server re-pushes agents:list; the row vanishes from props.
      setDeleting(false);
    });
  }

  return (
    <div style={{ ...rowStyle, borderLeftColor: editing ? palette.ember : palette.emberDim }}>
      <div style={rowHeaderStyle}>
        <span style={{ display: "flex", alignItems: "baseline", gap: space(2), minWidth: 0 }}>
          <span style={{ fontWeight: 700, color: "var(--text)", fontSize: "0.95rem" }}>
            {agent.name}
          </span>
          {agent.voice && (
            <span style={{ fontSize: "0.74rem", color: "var(--text-dim)" }} title={`Voice id: ${agent.voice}`}>
              voiced
            </span>
          )}
        </span>
        <span style={{ display: "flex", gap: space(1), flexShrink: 0 }}>
          <button style={miniButtonStyle} onClick={onEdit}>
            {editing ? "Editing" : "Edit"}
          </button>
          <button style={miniDangerButtonStyle} onClick={handleDelete} disabled={deleting}>
            {deleting ? "…" : "Delete"}
          </button>
        </span>
      </div>
      {agent.knowledge.trim().length > 0 && (
        <p
          style={{
            margin: `${space(1)} 0 0`,
            fontSize: "0.82rem",
            color: "var(--text-dim)",
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {agent.knowledge}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AgentForm — create / edit an agent
// ---------------------------------------------------------------------------

function AgentForm({
  editing,
  onDone,
}: {
  editing: Agent | null;
  onDone: () => void;
}) {
  const isEdit = editing !== null;
  const [name, setName] = useState(editing?.name ?? "");
  const [knowledge, setKnowledge] = useState(editing?.knowledge ?? "");
  const [voice, setVoice] = useState(editing?.voice ?? "");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setSaving(true);

    const v = voice.trim();
    const req: SaveAgentRequest = {
      ...(isEdit ? { id: editing.id } : {}),
      name: trimmed.slice(0, 60),
      knowledge: knowledge.slice(0, 4000),
      ...(v ? { voice: v.slice(0, 80) } : {}),
    };

    socket.emit("agent:save", req, (res: SaveAgentResult) => {
      setSaving(false);
      if (res.ok) {
        if (isEdit) {
          onDone();
        } else {
          setName("");
          setKnowledge("");
          setVoice("");
        }
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div style={formWrapStyle}>
      <div style={formTitleRowStyle}>
        <span style={subHeadingStyle}>{isEdit ? `Edit ${editing.name}` : "New agent"}</span>
        {isEdit && (
          <button style={miniButtonStyle} onClick={onDone}>
            Cancel
          </button>
        )}
      </div>

      <div style={{ display: "flex", gap: space(2), flexWrap: "wrap" }}>
        <div style={{ flex: "2 1 180px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Name</label>
          <input
            type="text"
            value={name}
            maxLength={60}
            placeholder="The Oracle, a goblin, a narrator…"
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            style={textInputStyle}
          />
        </div>
        <div style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle} title="Optional ElevenLabs voice id for spoken replies">
            Voice id (optional)
          </label>
          <input
            type="text"
            value={voice}
            maxLength={80}
            placeholder="ElevenLabs voice id"
            onChange={(e) => setVoice(e.target.value)}
            style={textInputStyle}
          />
        </div>
      </div>

      <label style={{ ...labelStyle, marginTop: space(3) }}>Knowledge / persona</label>
      <textarea
        value={knowledge}
        maxLength={4000}
        placeholder="Who is this character? What do they know? How do they speak?"
        onChange={(e) => setKnowledge(e.target.value)}
        rows={4}
        style={textareaStyle}
      />

      <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(4) }}>
        <button onClick={handleSave} disabled={saving} style={primaryButtonStyle(saving)}>
          {saving ? "Saving…" : isEdit ? "Save changes" : "Add agent"}
        </button>
        {error && <span style={{ color: DANGER_RED, fontSize: "0.82rem" }}>{error}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PromptAgentForm — prompt an agent; the reply is delivered as an effect
// ---------------------------------------------------------------------------

function PromptAgentForm({ players, agents }: { players: Player[]; agents: Agent[] }) {
  const [agentId, setAgentId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [deliverAs, setDeliverAs] = usePersistentState<"voice" | "message">("mi.gm.lore.deliverAs", "voice");

  // Target — broadcast or specific players (mirrors the Soundboard idiom).
  const [targetMode, setTargetMode] = usePersistentState<"broadcast" | "players">("mi.gm.lore.targetMode", "broadcast");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Spoken-reply FX (only meaningful when delivering as voice).
  const [whispers, setWhispers] = usePersistentState("mi.gm.lore.whispers", false);
  const [echo, setEcho] = usePersistentState("mi.gm.lore.echo", false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<{ agentName: string; text: string; deliveredTo: number } | null>(null);

  // Keep the picked agent valid as the roster changes (it may be deleted).
  useEffect(() => {
    if (agentId !== "" && !agents.some((a) => a.id === agentId)) setAgentId("");
  }, [agents, agentId]);

  const connectedPlayers = players.filter((p) => p.connected);
  const targetReady = targetMode === "broadcast" || selectedIds.size > 0;
  const canPrompt = !busy && agentId !== "" && prompt.trim().length > 0 && targetReady;

  function togglePlayer(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function buildTarget(): Target {
    return targetMode === "broadcast"
      ? { kind: "broadcast" }
      : { kind: "players", playerIds: Array.from(selectedIds) };
  }

  function handlePrompt() {
    if (!canPrompt) return;
    setError(null);
    setReply(null);
    setBusy(true);

    const req: PromptAgentRequest = {
      agentId,
      prompt: prompt.trim().slice(0, 2000),
      deliverAs,
      target: buildTarget(),
      // Whisper/echo treatment only applies to a spoken reply.
      ...(deliverAs === "voice" && whispers ? { whispers: true } : {}),
      ...(deliverAs === "voice" && echo ? { echo: true } : {}),
    };

    socket.emit("agent:prompt", req, (res: PromptAgentResult) => {
      setBusy(false);
      if (res.ok) {
        setReply({ agentName: res.agentName, text: res.reply, deliveredTo: res.deliveredTo });
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div style={formWrapStyle}>
      <span style={subHeadingStyle}>Prompt an agent</span>

      {/* Agent + delivery */}
      <div style={{ display: "flex", gap: space(3), flexWrap: "wrap", marginTop: space(3) }}>
        <div style={{ flex: "1 1 180px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Agent</label>
          <select value={agentId} onChange={(e) => setAgentId(e.target.value)} style={selectStyle}>
            <option value="">Choose an agent…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: "1 1 160px", display: "flex", flexDirection: "column", gap: space(1) }}>
          <label style={labelStyle}>Deliver as</label>
          <div style={{ display: "flex", gap: space(2) }}>
            <SmallToggle active={deliverAs === "voice"} onClick={() => setDeliverAs("voice")}>
              Voice
            </SmallToggle>
            <SmallToggle active={deliverAs === "message"} onClick={() => setDeliverAs("message")}>
              Message
            </SmallToggle>
          </div>
        </div>
      </div>

      {/* The prompt */}
      <label style={{ ...labelStyle, marginTop: space(3) }}>Prompt</label>
      <textarea
        value={prompt}
        maxLength={2000}
        placeholder="What should the agent respond to? (e.g. the player asks the Oracle about the sealed door)"
        onChange={(e) => {
          setPrompt(e.target.value);
          if (error) setError(null);
        }}
        rows={3}
        style={textareaStyle}
      />

      {/* Target */}
      <label style={{ ...labelStyle, marginTop: space(3) }}>Target</label>
      <div style={{ display: "flex", gap: space(3), marginTop: space(1) }}>
        <SmallToggle active={targetMode === "broadcast"} onClick={() => setTargetMode("broadcast")}>
          Everyone
        </SmallToggle>
        <SmallToggle active={targetMode === "players"} onClick={() => setTargetMode("players")}>
          Specific players
        </SmallToggle>
      </div>
      {targetMode === "players" && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: space(2), marginTop: space(2) }}>
          {connectedPlayers.length === 0 ? (
            <span style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>No connected players.</span>
          ) : (
            connectedPlayers.map((p) => (
              <PlayerChip
                key={p.id}
                player={p}
                selected={selectedIds.has(p.id)}
                onClick={() => togglePlayer(p.id)}
              />
            ))
          )}
        </div>
      )}

      {/* Voice FX — only when the reply is spoken. */}
      {deliverAs === "voice" && (
        <>
          <label style={{ ...labelStyle, marginTop: space(3) }}>Voice FX</label>
          <div style={{ display: "flex", gap: space(2), marginTop: space(1) }}>
            <SmallToggle active={whispers} onClick={() => setWhispers((v) => !v)}>
              Whispers
            </SmallToggle>
            <SmallToggle active={echo} onClick={() => setEcho((v) => !v)}>
              Echo
            </SmallToggle>
          </div>
        </>
      )}

      <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(4) }}>
        <button onClick={handlePrompt} disabled={!canPrompt} style={primaryButtonStyle(!canPrompt)}>
          {busy ? "Asking…" : "Prompt agent"}
        </button>
        {error && <span style={{ color: DANGER_RED, fontSize: "0.82rem" }}>{error}</span>}
      </div>

      {/* The reply text + how many it reached. */}
      {reply && (
        <div
          style={{
            marginTop: space(4),
            padding: `${space(3)} ${space(4)}`,
            background: "var(--bg)",
            borderRadius: radius.md,
            borderLeft: `3px solid ${palette.ember}`,
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: space(3), marginBottom: space(2) }}>
            <span style={{ fontWeight: 700, color: "var(--text)", fontSize: "0.9rem" }}>{reply.agentName}</span>
            <span style={{ fontSize: "0.74rem", color: reply.deliveredTo > 0 ? palette.ember : "var(--text-dim)" }}>
              {reply.deliveredTo > 0
                ? `delivered to ${reply.deliveredTo} ${reply.deliveredTo === 1 ? "player" : "players"}`
                : "reached 0 players"}
            </span>
          </div>
          <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text)", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
            {reply.text}
          </p>
        </div>
      )}
    </div>
  );
}

// ===========================================================================
// Shared small controls
// ===========================================================================

function SmallToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${space(2)} ${space(3)}`,
        background: active ? palette.emberDim : "var(--surface)",
        color: active ? palette.ember : "var(--text-dim)",
        border: `1px solid ${active ? palette.ember : palette.ash}`,
        borderRadius: radius.md,
        fontSize: "0.82rem",
        fontWeight: active ? 700 : 400,
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

function PlayerChip({
  player,
  selected,
  onClick,
}: {
  player: Player;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${space(2)} ${space(3)}`,
        background: selected ? palette.emberDim : "var(--surface)",
        color: selected ? palette.ember : "var(--text-dim)",
        border: `1px solid ${selected ? palette.ember : palette.ash}`,
        borderRadius: radius.pill,
        fontSize: "0.85rem",
        fontWeight: selected ? 700 : 400,
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
      }}
    >
      {player.name}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Label helpers
// ---------------------------------------------------------------------------

function summaryStyleLabel(s: SummaryStyle): string {
  switch (s) {
    case "recap": return "Recap";
    case "bullets": return "Bullets";
    case "dramatic": return "Dramatic";
  }
}

/** Compact local HH:MM from an ISO timestamp. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ===========================================================================
// Styles (match the other GM cards: Channel / Soundboard / Party)
// ===========================================================================

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: `${space(5)} ${space(5)}`,
  background: "var(--surface)",
  borderRadius: radius.md,
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: `0 0 ${space(1)}`,
  fontSize: "0.78rem",
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const subHeadingStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  fontWeight: 700,
  letterSpacing: "0.1em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.74rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const hintStyle: React.CSSProperties = {
  margin: `${space(1)} 0 0`,
  fontSize: "0.82rem",
  lineHeight: 1.45,
  color: "var(--text-dim)",
};

const emptyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.9rem",
  color: "var(--text-dim)",
  fontStyle: "italic",
};

const rowStyle: React.CSSProperties = {
  padding: `${space(3)} ${space(4)}`,
  background: "var(--bg)",
  borderRadius: radius.md,
  display: "flex",
  flexDirection: "column",
  gap: space(1),
  borderLeft: `3px solid ${palette.emberDim}`,
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: space(3),
};

const transcriptRowStyle: React.CSSProperties = {
  padding: `${space(2)} ${space(3)}`,
  background: "var(--bg)",
  borderRadius: radius.sm,
  display: "flex",
  flexDirection: "column",
};

const transcriptTextStyle: React.CSSProperties = {
  margin: `${space(1)} 0 0`,
  fontSize: "0.88rem",
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  lineHeight: 1.45,
};

const pickRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(1)} ${space(2)}`,
  background: "var(--bg)",
  borderRadius: radius.sm,
  cursor: "pointer",
};

const textInputStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(2)} ${space(3)}`,
  fontSize: "0.9rem",
  outline: "none",
  fontFamily: "var(--font)",
  caretColor: palette.ember,
  boxSizing: "border-box",
  width: "100%",
};

const textareaStyle: React.CSSProperties = {
  marginTop: space(1),
  background: "var(--bg)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(2)} ${space(3)}`,
  fontSize: "0.9rem",
  outline: "none",
  fontFamily: "var(--font)",
  caretColor: palette.ember,
  boxSizing: "border-box",
  width: "100%",
  resize: "vertical",
  lineHeight: 1.45,
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(2)} ${space(3)}`,
  fontSize: "0.9rem",
  fontFamily: "var(--font)",
  outline: "none",
  cursor: "pointer",
  boxSizing: "border-box",
  width: "100%",
};

const formWrapStyle: React.CSSProperties = {
  marginTop: space(5),
  paddingTop: space(4),
  borderTop: `1px solid ${palette.ash}`,
  display: "flex",
  flexDirection: "column",
};

const formTitleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: space(3),
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(3)} ${space(5)}`,
    background: disabled ? palette.ash : palette.ember,
    color: disabled ? palette.parchmentDim : palette.nearBlack,
    border: "none",
    borderRadius: radius.md,
    fontWeight: 700,
    fontSize: "0.92rem",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
    alignSelf: "flex-start",
    whiteSpace: "nowrap",
  };
}

function secondaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(2)} ${space(4)}`,
    background: disabled ? palette.ash : "var(--surface)",
    color: disabled ? palette.parchmentDim : palette.ember,
    border: `1px solid ${disabled ? palette.ash : palette.emberDim}`,
    borderRadius: radius.md,
    fontWeight: 600,
    fontSize: "0.9rem",
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

const stopButtonStyle: React.CSSProperties = {
  padding: `${space(3)} ${space(5)}`,
  background: "transparent",
  color: DANGER_RED,
  border: `1px solid ${DANGER_RED}`,
  borderRadius: radius.md,
  fontWeight: 700,
  fontSize: "0.92rem",
  cursor: "pointer",
  alignSelf: "flex-start",
  whiteSpace: "nowrap",
};

const miniButtonStyle: React.CSSProperties = {
  padding: `${space(1)} ${space(2)}`,
  background: "transparent",
  color: "var(--text-dim)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.sm,
  fontSize: "0.74rem",
  fontWeight: 600,
  cursor: "pointer",
};

const miniDangerButtonStyle: React.CSSProperties = {
  padding: `${space(1)} ${space(2)}`,
  background: "transparent",
  color: DANGER_RED,
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.sm,
  fontSize: "0.74rem",
  fontWeight: 600,
  cursor: "pointer",
};
