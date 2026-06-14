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
  Player,
  SendEffectResult,
  Target,
  WhisperscapeRequest,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

const STORE_KEY = "mi.gm.whisper.phrases";

function loadPhrases(): string[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function WhisperVoices({ players }: { players: Player[] }) {
  const [phrases, setPhrases] = useState<string[]>(() => loadPhrases());
  const [draft, setDraft] = useState("");
  const [bedVol, setBedVol] = useState(0.5);
  const [voiceVol, setVoiceVol] = useState(0.9);
  const [minSec, setMinSec] = useState(8);
  const [maxSec, setMaxSec] = useState(20);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

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
    const target: Target =
      targetMode === "broadcast"
        ? { kind: "broadcast" }
        : { kind: "players", playerIds: Array.from(selectedIds) };
    const req: WhisperscapeRequest = {
      target,
      phrases,
      bedGain: bedVol,
      voiceGain: voiceVol,
      minGapMs: Math.round(minSec * 1000),
      maxGapMs: Math.round(Math.max(minSec, maxSec) * 1000),
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
        A dissonant bed with phrases that surface at random — one ear at a time, with
        echo + distortion. Stop it from Active effects.
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

      {/* Phrase library */}
      <div style={{ display: "flex", gap: space(2), marginTop: space(3) }}>
        <input
          type="text"
          placeholder="Add a phrase the voices will speak…"
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
      </div>

      {phrases.length === 0 ? (
        <p style={{ ...hintStyle, fontStyle: "italic", marginTop: space(2) }}>No phrases yet.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: `${space(3)} 0 0`, padding: 0, display: "flex", flexDirection: "column", gap: space(1) }}>
          {phrases.map((p, i) => (
            <li key={`${i}-${p}`} style={phraseRowStyle}>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {p}
              </span>
              <button
                onClick={() => setPhrases((cur) => cur.filter((_, idx) => idx !== i))}
                style={removeButtonStyle}
                aria-label="Remove phrase"
                title="Remove"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
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
