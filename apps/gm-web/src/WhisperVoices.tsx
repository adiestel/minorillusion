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

const STORE_KEY = "mi.gm.whisper.phrases";
const VOICE_KEY = "mi.gm.whisper.voice";

function loadPhrases(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
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
  { key: "voice2", label: "Voice 2", id: "17JdVkQHD6PE3HPohzr2" },
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
  const [phrases, setPhrases] = useState<string[]>(() => loadPhrases());
  const [draft, setDraft] = useState("");
  const [order, setOrder] = useState<"random" | "sequential">("random");
  const [loop, setLoop] = useState(true);
  const [bedVol, setBedVol] = useState(0.5);
  const [voiceVol, setVoiceVol] = useState(0.9);
  const [minSec, setMinSec] = useState(8);
  const [maxSec, setMaxSec] = useState(20);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // Voice FX (moved here from the Soundboard): the spoken-voice treatment that
  // colours both one-off speech (Play now / a phrase's ▶) and the whisperscape's
  // looping phrases. Independent toggles — e.g. echo + distortion without the bed.
  // The bed only wraps ONE-OFF speech; the whisperscape already rides its own bed.
  const [fxBed, setFxBed] = useState(true);
  const [fxEcho, setFxEcho] = useState(true);
  const [fxDistortion, setFxDistortion] = useState(true);
  const [fxPan, setFxPan] = useState(true);
  // Which one-off speech is in flight ("draft" or `phrase:<i>`), to show feedback.
  const [playId, setPlayId] = useState<string | null>(null);

  // The chosen TTS voice (persisted). voice1 → undefined (server default).
  const [voiceKey, setVoiceKey] = useState<string>(() => loadVoiceKey());
  const selectedVoiceId = VOICES.find((v) => v.key === voiceKey)?.id;

  // Drag-and-drop reordering of the phrase library (native HTML5 DnD).
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [overIdx, setOverIdx] = useState<number | null>(null);

  // Target — like the storm, the whole whisperscape can aim at one player.
  const [targetMode, setTargetMode] = useState<"broadcast" | "players">("broadcast");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(phrases));
    } catch {
      /* storage unavailable */
    }
  }, [phrases]);

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

  function addPhrase() {
    const t = draft.trim();
    if (t.length === 0 || phrases.length >= 50) return;
    setPhrases((p) => [...p, t.slice(0, 300)]);
    setDraft("");
  }

  /** Move a phrase from one position to another (drag-and-drop reorder). */
  function reorder(from: number, to: number) {
    setPhrases((cur) => {
      if (from === to || from < 0 || to < 0 || from >= cur.length || to >= cur.length) {
        return cur;
      }
      const next = [...cur];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved as string);
      return next;
    });
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
      ...(fxEcho ? { echo: true } : {}),
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
    if (phrases.length === 0) {
      setStatus("Add at least one phrase.");
      return;
    }
    if (!targetReady) {
      setStatus("Choose at least one player.");
      return;
    }
    setBusy(true);
    const req: WhisperscapeRequest = {
      target: buildTarget(),
      phrases,
      order,
      loop,
      // The whisperscape rides its own bed, so only echo/distortion/pan apply.
      echo: fxEcho,
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

  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Whisper voices</h2>
      <p style={hintStyle}>
        A dissonant bed with phrases that surface as echoing whispers — one ear at a
        time. Type a line to add it or speak it now; drag to reorder; ▶ plays any
        phrase at once. Voice FX colour every spoken line. Stop it from Active effects.
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

      {phrases.length === 0 ? (
        <p style={{ ...hintStyle, fontStyle: "italic", marginTop: space(2) }}>No phrases yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: `${space(3)} 0 0`, padding: 0, display: "flex", flexDirection: "column", gap: space(1) }}>
          {phrases.map((p, i) => {
            const isDragging = dragIdx === i;
            const isOver = overIdx === i && dragIdx !== null && dragIdx !== i;
            return (
              <li
                key={`${i}-${p}`}
                draggable
                onDragStart={(e) => {
                  setDragIdx(i);
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  if (overIdx !== i) setOverIdx(i);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragIdx !== null) reorder(dragIdx, i);
                  setDragIdx(null);
                  setOverIdx(null);
                }}
                onDragEnd={() => {
                  setDragIdx(null);
                  setOverIdx(null);
                }}
                style={{
                  ...phraseRowStyle,
                  cursor: "grab",
                  opacity: isDragging ? 0.4 : 1,
                  boxShadow: isOver ? `inset 0 2px 0 ${palette.ember}` : "none",
                }}
              >
                <span aria-hidden="true" style={gripStyle} title="Drag to reorder">
                  ⠿
                </span>
                <span style={ordinalStyle}>{i + 1}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {p}
                </span>
                <button
                  draggable={false}
                  onClick={() => fireSpeak(p, `phrase:${i}`)}
                  disabled={!targetReady || playId === `phrase:${i}`}
                  style={playButtonStyle(!targetReady || playId === `phrase:${i}`)}
                  aria-label="Play this phrase now"
                  title="Play now"
                >
                  ▶
                </button>
                <button
                  draggable={false}
                  onClick={() => setPhrases((cur) => cur.filter((_, idx) => idx !== i))}
                  style={removeButtonStyle}
                  aria-label="Remove phrase"
                  title="Remove"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {/* Playback — phrase order + repeat. Drag the rows above to set the order. */}
      {phrases.length > 0 && (
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
          whisperscape's looping phrases. The bed wraps one-off speech only (the
          whisperscape already rides its own dissonant bed). */}
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
        disabled={busy || phrases.length === 0 || !targetReady}
        style={startButtonStyle(busy || phrases.length === 0 || !targetReady)}
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
