/**
 * WhisperVoices — the GM's whisperscape control (Effects tab).
 *
 * A persisted library of phrases that, once started, ride a dissonant bed and
 * surface at random as real (TTS) speech — one player's ear at a time, like
 * thunderclaps in a storm. The fired phrases carry echo + distortion only (the
 * bed is already the ambience). The server caches each phrase's synthesis, so a
 * line is TTS'd at most once. Stop it from the Active effects panel ("Whispers").
 *
 * Broadcasts to the whole circle (the bed for everyone; each phrase whispers to
 * one random player). Phrases persist per browser in localStorage.
 */
import { useEffect, useState } from "react";
import type {
  EffectSpec,
  Player,
  SendEffectRequest,
  SendEffectResult,
  Target,
  WhisperscapeRequest,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";
import { usePersistentState } from "./usePersistentState";

const STORE_KEY = "mi.gm.whisper.phrases"; // the looping list (back-compat key)
const PARK_KEY = "mi.gm.whisper.parked"; // the storage (non-looping) list
const VOICE_KEY = "mi.gm.whisper.voice";

/** The two phrase lists: "loop" rides the whisperscape; "parked" is storage. */
type ListId = "loop" | "parked";
interface DragRef {
  list: ListId;
  /** Row index, or the list length to mean "drop at the end". */
  idx: number;
}

function loadList(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/**
 * The GM voice catalog — which ElevenLabs voice speaks. "Voice 1" carries no id
 * so the server resolves its default (the ELEVENLABS_VOICE_ID override, else the
 * built-in), keeping that override working; the rest pin an explicit voice id.
 * Add new voices here — the chosen id rides every spoken line (one-off + scape).
 */
interface VoiceOption {
  key: string;
  label: string;
  id?: string;
}
const VOICES: VoiceOption[] = [
  { key: "voice1", label: "Voice 1 (default)" },
  { key: "voice2", label: "Voice 2", id: "6sFKzaJr574YWVu4UuJF" },
];

function loadVoiceKey(): string {
  try {
    const raw = localStorage.getItem(VOICE_KEY);
    return VOICES.some((v) => v.key === raw) ? (raw as string) : VOICES[0]!.key;
  } catch {
    return VOICES[0]!.key;
  }
}

export function WhisperVoices({ players }: { players: Player[] }) {
  // Two lists: "loop" plays as the whisperscape ambience; "parked" is storage —
  // kept on hand but NOT looped (▶ still plays a parked line manually).
  const [loopPhrases, setLoopPhrases] = useState<string[]>(() => loadList(STORE_KEY));
  const [parkedPhrases, setParkedPhrases] = useState<string[]>(() => loadList(PARK_KEY));
  const [draft, setDraft] = useState("");
  // Settings persist across reloads so the GM doesn't re-dial them each session.
  const [order, setOrder] = usePersistentState<"random" | "sequential">("mi.gm.whisper.order", "random");
  const [loop, setLoop] = usePersistentState("mi.gm.whisper.loop", true);
  const [bedVol, setBedVol] = usePersistentState("mi.gm.whisper.bedVol", 0.5);
  const [voiceVol, setVoiceVol] = usePersistentState("mi.gm.whisper.voiceVol", 0.9);
  const [minSec, setMinSec] = usePersistentState("mi.gm.whisper.minSec", 8);
  const [maxSec, setMaxSec] = usePersistentState("mi.gm.whisper.maxSec", 20);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Voice FX (moved here from the Soundboard): the spoken-voice treatment that
  // colours both one-off speech (Play now / a phrase's ▶) and the whisperscape's
  // looping phrases. Independent toggles — e.g. echo + distortion without the bed.
  // The bed only wraps ONE-OFF speech; the whisperscape already rides its own bed.
  const [fxBed, setFxBed] = usePersistentState("mi.gm.whisper.fxBed", true);
  const [fxEcho, setFxEcho] = usePersistentState("mi.gm.whisper.fxEcho", true);
  const [echoAmt, setEchoAmt] = usePersistentState("mi.gm.whisper.echoAmt", 0.35); // moderate — keeps the voice legible
  const [fxDistortion, setFxDistortion] = usePersistentState("mi.gm.whisper.fxDistortion", true);
  const [fxPan, setFxPan] = usePersistentState("mi.gm.whisper.fxPan", true);
  // Which one-off speech is in flight ("draft" or `phrase:<i>`), to show feedback.
  const [playId, setPlayId] = useState<string | null>(null);

  // The chosen TTS voice (persisted). voice1 → undefined (server default).
  const [voiceKey, setVoiceKey] = useState<string>(() => loadVoiceKey());
  const selectedVoiceId = VOICES.find((v) => v.key === voiceKey)?.id;

  // Drag-and-drop within and between the two lists (native HTML5 DnD).
  const [drag, setDrag] = useState<DragRef | null>(null);
  const [over, setOver] = useState<DragRef | null>(null);

  // Target — like the storm, the whole whisperscape can aim at one player. The
  // mode persists; the specific player picks don't (their ids change per session).
  const [targetMode, setTargetMode] = usePersistentState<"broadcast" | "players">("mi.gm.whisper.targetMode", "broadcast");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(loopPhrases));
    } catch {
      /* storage unavailable */
    }
  }, [loopPhrases]);

  useEffect(() => {
    try {
      localStorage.setItem(PARK_KEY, JSON.stringify(parkedPhrases));
    } catch {
      /* storage unavailable */
    }
  }, [parkedPhrases]);

  useEffect(() => {
    try {
      localStorage.setItem(VOICE_KEY, voiceKey);
    } catch {
      /* storage unavailable */
    }
  }, [voiceKey]);

  const connectedPlayers = players.filter((p) => p.connected);
  const targetReady = targetMode === "broadcast" || selectedIds.size > 0;

  function togglePlayer(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // New lines join the looping list (the schema sends at most 50).
  function addPhrase() {
    const t = draft.trim();
    if (t.length === 0 || loopPhrases.length >= 50) return;
    setLoopPhrases((p) => [...p, t.slice(0, 300)]);
    setDraft("");
  }

  function removeFrom(list: ListId, i: number) {
    const setter = list === "loop" ? setLoopPhrases : setParkedPhrases;
    setter((cur) => cur.filter((_, idx) => idx !== i));
  }

  function endDrag() {
    setDrag(null);
    setOver(null);
  }

  /**
   * Move a phrase within or between the two lists. Reordering within a list and
   * dragging across lists share one path: splice out of the source, insert into
   * the destination (adjusting the index when removal shifts a same-list target).
   * Won't overflow the looping list past 50 (the schema's cap on what it sends).
   */
  function moveItem(from: DragRef, to: DragRef) {
    const loop = [...loopPhrases];
    const parked = [...parkedPhrases];
    const src = from.list === "loop" ? loop : parked;
    const moved = src[from.idx];
    if (moved === undefined) return;
    if (to.list === "loop" && from.list !== "loop" && loop.length >= 50) return;
    src.splice(from.idx, 1);
    const dest = to.list === "loop" ? loop : parked;
    let idx = to.idx;
    if (from.list === to.list && from.idx < to.idx) idx -= 1;
    dest.splice(Math.max(0, Math.min(dest.length, idx)), 0, moved);
    setLoopPhrases(loop);
    setParkedPhrases(parked);
  }

  function onDropAt(to: DragRef) {
    if (drag) moveItem(drag, to);
    endDrag();
  }

  function buildTarget(): Target {
    return targetMode === "broadcast"
      ? { kind: "broadcast" }
      : { kind: "players", playerIds: Array.from(selectedIds) };
  }

  /** The current Voice FX as audio-effect fields (the bed wraps one-off speech). */
  function voiceFx() {
    return {
      ...(fxBed ? { whispers: true, whisperGain: bedVol } : {}),
      ...(fxEcho ? { echo: true, echoAmount: echoAmt } : {}),
      ...(fxDistortion ? { distortion: true } : {}),
      ...(fxPan ? { pan: true } : {}),
    };
  }

  /** Speak one line immediately (one-off TTS) with the current Voice FX. */
  function fireSpeak(text: string, id: string) {
    const t = text.trim();
    if (t.length === 0) return;
    if (!targetReady) {
      setStatus("Choose at least one player.");
      return;
    }
    setPlayId(id);
    const spec: EffectSpec = {
      kind: "audio",
      source: {
        via: "tts",
        text: t.slice(0, 600),
        ...(selectedVoiceId ? { voice: selectedVoiceId } : {}),
      },
      gain: voiceVol,
      ...voiceFx(),
    };
    const req: SendEffectRequest = { target: buildTarget(), spec };
    socket.emit("effect:send", req, (r: SendEffectResult) => {
      setPlayId((cur) => (cur === id ? null : cur));
      setStatus(
        r.ok
          ? `Spoke → ${r.deliveredTo} ${r.deliveredTo === 1 ? "player" : "players"}`
          : `Error: ${r.error}`,
      );
    });
  }

  function start() {
    if (loopPhrases.length === 0) {
      setStatus("Add at least one looping phrase.");
      return;
    }
    if (!targetReady) {
      setStatus("Choose at least one player.");
      return;
    }
    setBusy(true);
    const req: WhisperscapeRequest = {
      target: buildTarget(),
      phrases: loopPhrases,
      order,
      loop,
      // The Whispers-bed toggle drives the looping ambience here too (off → only
      // the spoken phrases fire). Echo/distortion/pan colour the phrases.
      bed: fxBed,
      echo: fxEcho,
      ...(fxEcho ? { echoAmount: echoAmt } : {}),
      distortion: fxDistortion,
      pan: fxPan,
      bedGain: bedVol,
      voiceGain: voiceVol,
      minGapMs: Math.round(minSec * 1000),
      maxGapMs: Math.round(Math.max(minSec, maxSec) * 1000),
      ...(selectedVoiceId ? { voice: selectedVoiceId } : {}),
    };
    socket.emit("whisperscape:start", req, (r: SendEffectResult) => {
      setBusy(false);
      setStatus(
        r.ok
          ? `Whispers rising → bed to ${r.deliveredTo} ${r.deliveredTo === 1 ? "player" : "players"}`
          : `Error: ${r.error}`,
      );
    });
  }

  /** Render one phrase list (looping or storage) with cross-list drag-and-drop. */
  function renderSection(
    list: ListId,
    items: string[],
    label: string,
    hint: string,
    showOrdinals: boolean,
  ) {
    const endOver = drag !== null && over?.list === list && over.idx >= items.length;
    return (
      <div style={{ marginTop: space(3) }}>
        <label style={labelStyle}>{label}</label>
        <ul
          onDragOver={(e) => {
            e.preventDefault();
            if (drag) setOver({ list, idx: items.length });
          }}
          onDrop={(e) => {
            e.preventDefault();
            onDropAt({ list, idx: items.length });
          }}
          style={{
            listStyle: "none",
            margin: `${space(2)} 0 0`,
            padding: items.length === 0 ? space(3) : 0,
            display: "flex",
            flexDirection: "column",
            gap: space(1),
            minHeight: items.length === 0 ? 40 : undefined,
            border: items.length === 0 ? `1px dashed ${endOver ? palette.ember : palette.ash}` : undefined,
            borderRadius: radius.sm,
            background: endOver && items.length === 0 ? palette.emberDim : "transparent",
          }}
        >
          {items.length === 0 ? (
            <li style={emptyDropStyle}>{hint}</li>
          ) : (
            items.map((p, i) => {
              const id = `${list}:${i}`;
              const isDragging = drag?.list === list && drag.idx === i;
              const isOver = drag !== null && over?.list === list && over.idx === i && !isDragging;
              return (
                <li
                  key={`${list}-${i}-${p}`}
                  draggable
                  onDragStart={(e) => {
                    setDrag({ list, idx: i });
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    setOver({ list, idx: i });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onDropAt({ list, idx: i });
                  }}
                  onDragEnd={endDrag}
                  style={{
                    ...phraseRowStyle,
                    cursor: "grab",
                    opacity: isDragging ? 0.4 : 1,
                    boxShadow: isOver ? `inset 0 2px 0 ${palette.ember}` : "none",
                  }}
                >
                  <span aria-hidden="true" style={gripStyle} title="Drag to reorder or move between lists">
                    ⠿
                  </span>
                  {showOrdinals && <span style={ordinalStyle}>{i + 1}</span>}
                  <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {p}
                  </span>
                  <button
                    draggable={false}
                    onClick={() => fireSpeak(p, id)}
                    disabled={!targetReady || playId === id}
                    style={playButtonStyle(!targetReady || playId === id)}
                    aria-label="Play this phrase now"
                    title="Play now"
                  >
                    ▶
                  </button>
                  <button
                    draggable={false}
                    onClick={() => removeFrom(list, i)}
                    style={removeButtonStyle}
                    aria-label="Remove phrase"
                    title="Remove"
                  >
                    ×
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    );
  }

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Whisper voices</h2>
      <p style={hintStyle}>
        A dissonant bed with phrases that surface as echoing whispers — one ear at a
        time. Phrases <em>in the loop</em> play as the ambience; drag any to{" "}
        <em>storage</em> to keep it on hand without looping (▶ still plays it). Type
        to add or speak now; Voice FX colour every line. Stop it from Active effects.
      </p>

      {/* Target — aim the whole whisperscape at everyone or specific players. */}
      <div style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(3) }}>
        <label style={labelStyle}>Target</label>
        <div style={{ display: "flex", gap: space(3) }}>
          <ToggleButton active={targetMode === "broadcast"} onClick={() => setTargetMode("broadcast")}>
            Everyone
          </ToggleButton>
          <ToggleButton active={targetMode === "players"} onClick={() => setTargetMode("players")}>
            Specific players
          </ToggleButton>
        </div>
        {targetMode === "players" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: space(2), marginTop: space(1) }}>
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
      </div>

      {/* Type a line → Add it to the library, or Play now (one-off speech). */}
      <div style={{ display: "flex", gap: space(2), marginTop: space(3) }}>
        <input
          type="text"
          placeholder="Type a line — add it, or play it now…"
          value={draft}
          maxLength={300}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addPhrase();
          }}
          style={inputStyle}
        />
        <button onClick={addPhrase} disabled={draft.trim().length === 0} style={addButtonStyle(draft.trim().length === 0)}>
          Add
        </button>
        <button
          onClick={() => fireSpeak(draft, "draft")}
          disabled={draft.trim().length === 0 || !targetReady || playId === "draft"}
          style={playNowButtonStyle(draft.trim().length === 0 || !targetReady || playId === "draft")}
          title="Speak this line now"
        >
          {playId === "draft" ? "Speaking…" : "Play now"}
        </button>
      </div>

      {/* Two lists: the loop (whisperscape ambience) + storage (parked, ▶ only).
          Drag rows to reorder, or between the lists to include / park a phrase. */}
      {renderSection(
        "loop",
        loopPhrases,
        "In the loop",
        "Drop phrases here to weave them into the whisper loop.",
        true,
      )}
      {renderSection(
        "parked",
        parkedPhrases,
        "Storage — not looped",
        "Drag phrases here to keep them on hand without looping (▶ still plays them).",
        false,
      )}

      {/* Playback — phrase order + repeat (the looping list). Drag to set order. */}
      {loopPhrases.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: space(4), marginTop: space(3) }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space(2) }}>
            <label style={labelStyle}>Order</label>
            <div style={{ display: "flex", gap: space(2) }}>
              <ToggleButton active={order === "random"} onClick={() => setOrder("random")}>
                Shuffle
              </ToggleButton>
              <ToggleButton active={order === "sequential"} onClick={() => setOrder("sequential")}>
                In order
              </ToggleButton>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: space(2) }}>
            <label style={labelStyle}>Repeat</label>
            <div style={{ display: "flex", gap: space(2) }}>
              <ToggleButton active={loop} onClick={() => setLoop(true)}>
                Loop
              </ToggleButton>
              <ToggleButton active={!loop} onClick={() => setLoop(false)}>
                Play once
              </ToggleButton>
            </div>
          </div>
        </div>
      )}

      {/* Voice — which TTS voice speaks (one-off speech + the whisperscape). */}
      <label style={{ ...labelStyle, marginTop: space(4) }}>Voice</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: space(2), marginTop: space(2) }}>
        {VOICES.map((v) => (
          <ToggleButton key={v.key} active={voiceKey === v.key} onClick={() => setVoiceKey(v.key)}>
            {v.label}
          </ToggleButton>
        ))}
      </div>

      {/* Voice FX — colours every spoken line: Play now, a phrase's ▶, and the
          whisperscape's looping phrases. "Whispers bed" wraps one-off speech in
          the dissonant bed AND drives the whisperscape's ambience — off → just
          the spoken phrases, no bed. */}
      <label style={{ ...labelStyle, marginTop: space(4) }}>Voice FX</label>
      <div style={{ display: "flex", flexWrap: "wrap", gap: space(2), marginTop: space(2) }}>
        <ToggleButton active={fxBed} onClick={() => setFxBed((v) => !v)}>
          Whispers bed
        </ToggleButton>
        <ToggleButton active={fxEcho} onClick={() => setFxEcho((v) => !v)}>
          Echo
        </ToggleButton>
        <ToggleButton active={fxDistortion} onClick={() => setFxDistortion((v) => !v)}>
          Distortion
        </ToggleButton>
        <ToggleButton active={fxPan} onClick={() => setFxPan((v) => !v)}>
          Pan
        </ToggleButton>
      </div>

      {/* Echo intensity — lower keeps the words legible; only when Echo is on. */}
      {fxEcho && (
        <div style={{ marginTop: space(2) }}>
          <Slider label="Echo" value={echoAmt} onChange={setEchoAmt} />
        </div>
      )}

      {/* Levels */}
      <div style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(4) }}>
        <Slider label="Bed" value={bedVol} onChange={setBedVol} />
        <Slider label="Voices" value={voiceVol} onChange={setVoiceVol} />
      </div>

      {/* Gap */}
      <div style={{ display: "flex", alignItems: "center", gap: space(2), marginTop: space(3) }}>
        <label style={labelStyle}>Every</label>
        <NumberBox value={minSec} onChange={(v) => setMinSec(clampSec(v))} />
        <span style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>–</span>
        <NumberBox value={maxSec} onChange={(v) => setMaxSec(clampSec(v))} />
        <span style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>seconds</span>
      </div>

      <button
        onClick={start}
        disabled={busy || loopPhrases.length === 0 || !targetReady}
        style={startButtonStyle(busy || loopPhrases.length === 0 || !targetReady)}
      >
        {busy ? "Starting…" : "Start whispers"}
      </button>

      {status && (
        <p style={{ margin: `${space(3)} 0 0`, fontSize: "0.85rem", color: status.startsWith("Error") ? palette.ember : "var(--text-dim)" }}>
          {status}
        </p>
      )}
    </section>
  );
}

function clampSec(v: number): number {
  return Math.min(180, Math.max(2, Math.round(v) || 2));
}

// ---------------------------------------------------------------------------
// Small controls
// ---------------------------------------------------------------------------

function Slider({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space(3) }}>
      <label style={{ ...labelStyle, whiteSpace: "nowrap", minWidth: 80 }}>
        {label} {Math.round(value * 100)}%
      </label>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ flex: 1, accentColor: palette.ember, cursor: "pointer" }}
      />
    </div>
  );
}

function ToggleButton({
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
        padding: `${space(2)} ${space(4)}`,
        background: active ? palette.emberDim : "var(--surface)",
        color: active ? palette.ember : "var(--text-dim)",
        border: `1px solid ${active ? palette.ember : palette.ash}`,
        borderRadius: radius.md,
        fontSize: "0.85rem",
        fontWeight: active ? 700 : 400,
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
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

function NumberBox({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <input
      type="number"
      min={2}
      max={180}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        width: 56,
        background: "var(--bg)",
        color: "var(--text)",
        border: `1px solid ${palette.ash}`,
        borderRadius: radius.sm,
        padding: `${space(2)} ${space(2)}`,
        fontSize: "0.9rem",
        textAlign: "center",
        fontVariantNumeric: "tabular-nums",
        outline: "none",
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Styles (match the other GM cards)
// ---------------------------------------------------------------------------

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

const hintStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.82rem",
  lineHeight: 1.45,
  color: "var(--text-dim)",
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--bg)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(3)} ${space(4)}`,
  fontSize: "0.95rem",
  outline: "none",
  fontFamily: "var(--font)",
  caretColor: palette.ember,
};

const phraseRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: space(2),
  padding: `${space(2)} ${space(3)}`,
  background: "var(--bg)",
  borderRadius: radius.sm,
  fontSize: "0.88rem",
  color: "var(--text)",
};

const removeButtonStyle: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--text-dim)",
  fontSize: "1.1rem",
  lineHeight: 1,
  cursor: "pointer",
  padding: `0 ${space(1)}`,
  flexShrink: 0,
};

const emptyDropStyle: React.CSSProperties = {
  listStyle: "none",
  fontSize: "0.8rem",
  color: "var(--text-dim)",
  fontStyle: "italic",
  textAlign: "center",
};

const gripStyle: React.CSSProperties = {
  flexShrink: 0,
  color: "var(--text-dim)",
  fontSize: "0.9rem",
  lineHeight: 1,
  cursor: "grab",
  userSelect: "none",
};

const ordinalStyle: React.CSSProperties = {
  flexShrink: 0,
  minWidth: "1.2em",
  textAlign: "right",
  color: palette.parchmentDim,
  fontSize: "0.78rem",
  fontVariantNumeric: "tabular-nums",
};

function addButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(3)} ${space(4)}`,
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

function playNowButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(3)} ${space(4)}`,
    background: disabled ? palette.ash : palette.emberDim,
    color: disabled ? palette.parchmentDim : palette.bone,
    border: `1px solid ${disabled ? palette.ash : palette.ember}`,
    borderRadius: radius.md,
    fontWeight: 600,
    fontSize: "0.9rem",
    cursor: disabled ? "not-allowed" : "pointer",
    whiteSpace: "nowrap",
  };
}

function playButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    flexShrink: 0,
    background: "transparent",
    border: "none",
    color: disabled ? "var(--text-dim)" : palette.ember,
    fontSize: "0.8rem",
    lineHeight: 1,
    cursor: disabled ? "not-allowed" : "pointer",
    padding: `0 ${space(1)}`,
  };
}

function startButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: space(4),
    padding: `${space(3)} ${space(5)}`,
    background: disabled ? palette.ash : palette.ember,
    color: disabled ? palette.parchmentDim : palette.nearBlack,
    border: "none",
    borderRadius: radius.md,
    fontWeight: 700,
    fontSize: "0.95rem",
    cursor: disabled ? "not-allowed" : "pointer",
    alignSelf: "flex-start",
  };
}
