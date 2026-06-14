/**
 * Soundboard — M2 GM atmosphere panel (control rework).
 * One-tap effect triggers, split into two labeled sections:
 *   • Loops — sustained effects that run until stopped (Rain, Storm, embers).
 *   • One-shots — transient effects that auto-close (Thunderclap, Chime,
 *     Buzz, Rumble, Heartbeat) plus a TTS "Speak" row.
 * Every button fires `effect:send` and surfaces a brief transient status from
 * the ack. Stopping a sustained effect is no longer done here — it moves to the
 * ActiveEffects panel, which reads the server's live registry.
 *
 * Sits below the MessageComposer inside the active-circle view. Carries its
 * own small target selector (Everyone vs specific connected players), mirroring
 * MessageComposer's UX without sharing its internals.
 */
import { useEffect, useRef, useState } from "react";
import type {
  CueStep,
  EffectSpec,
  Player,
  SendCueRequest,
  SendCueResult,
  SendEffectRequest,
  SendEffectResult,
  Target,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

// ---------------------------------------------------------------------------
// One-tap button definitions
// ---------------------------------------------------------------------------

/**
 * A one-tap button — fires either a single effect (`spec` → effect:send) or a
 * choreographed cue (`steps` → effect:cue, several effects with their own
 * offsets). Thunderclap is a cue: a single storm strike (flash, then the crack).
 */
interface EffectButton {
  id: string;
  label: string;
  spec?: EffectSpec;
  steps?: CueStep[];
}

/**
 * Loops — sustained effects that keep running until the GM stops them from the
 * Active panel. Rain is an audio cue set to loop; Storm and embers are ambiance
 * scenes (persistent by nature).
 */
const LOOP_BUTTONS: EffectButton[] = [
  // Rain and Storm are mutually-exclusive weather ambiances (one bed, never
  // layered); starting one replaces the other and the rain bed crossfades.
  { id: "rain", label: "Rain", spec: { kind: "ambiance", scene: "rain" } },
  { id: "storm", label: "Storm", spec: { kind: "ambiance", scene: "storm" } },
  { id: "embers", label: "Stir embers", spec: { kind: "ambiance", scene: "ember" } },
];

/**
 * One-shots — transient effects that play once and auto-close. (The "Speak"
 * TTS row is rendered separately below the grid.)
 */
const ONESHOT_BUTTONS: EffectButton[] = [
  {
    id: "thunderclap",
    label: "Thunderclap",
    // One storm strike: the lightning flash, then the crack ~150ms behind it.
    steps: [
      { spec: { kind: "flash" } },
      { spec: { kind: "audio", source: { via: "cue", cue: "thunder" } }, startDelayMs: 150 },
    ],
  },
  { id: "chime", label: "Chime", spec: { kind: "audio", source: { via: "cue", cue: "chime" } } },
  { id: "buzz", label: "Buzz", spec: { kind: "haptic", pattern: "buzz" } },
  { id: "rumble", label: "Rumble", spec: { kind: "haptic", pattern: "rumble" } },
  { id: "heartbeat", label: "Heartbeat", spec: { kind: "heartbeat", bpm: 72, beats: 8 } },
];

// ---------------------------------------------------------------------------
// Transient status
// ---------------------------------------------------------------------------

type Status = { kind: "ok" | "error"; text: string } | null;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface SoundboardProps {
  players: Player[];
}

export function Soundboard({ players }: SoundboardProps) {
  // --- Target selector state (mirrors MessageComposer) ---
  const [targetMode, setTargetMode] = useState<"broadcast" | "players">("broadcast");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // --- TTS row ---
  const [ttsText, setTtsText] = useState("");

  // --- Fade interval for looping weather beds (seconds) ---
  const [fadeSeconds, setFadeSeconds] = useState(5);

  // --- Transient status ---
  const [status, setStatus] = useState<Status>(null);
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- In-flight tracking (disable a button briefly while its emit lands) ---
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (statusTimer.current !== null) clearTimeout(statusTimer.current);
    };
  }, []);

  // --- Derived ---
  const connectedPlayers = players.filter((p) => p.connected);
  const targetReady = targetMode === "broadcast" || selectedIds.size > 0;

  // --- Helpers ---
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

  function showStatus(next: Status) {
    if (statusTimer.current !== null) clearTimeout(statusTimer.current);
    setStatus(next);
    if (next !== null) {
      statusTimer.current = setTimeout(() => setStatus(null), 4000);
    }
  }

  /** Fire a button — a single effect (effect:send) or a cue (effect:cue). */
  function fireButton(b: EffectButton) {
    if (!targetReady) return;
    setBusyId(b.id);
    const handle = (result: SendEffectResult | SendCueResult) => {
      setBusyId((cur) => (cur === b.id ? null : cur));
      if (result.ok) {
        showStatus({ kind: "ok", text: `${b.label} → ${result.deliveredTo} ${plural(result.deliveredTo)}` });
      } else {
        showStatus({ kind: "error", text: `${b.label}: ${result.error}` });
      }
    };
    if (b.steps !== undefined) {
      const req: SendCueRequest = { target: buildTarget(), steps: b.steps };
      socket.emit("effect:cue", req, handle);
    } else if (b.spec !== undefined) {
      // Weather ambiances carry the current fade interval (controls the bed's
      // fade-in/out, and so the crossfade when switching storm⇄rain).
      const spec =
        b.spec.kind === "ambiance" ? { ...b.spec, fadeMs: fadeSeconds * 1000 } : b.spec;
      const req: SendEffectRequest = { target: buildTarget(), spec };
      socket.emit("effect:send", req, handle);
    }
  }

  /** Fire TTS via the audio effect (server resolves it through ElevenLabs). */
  function fireSpeak() {
    const text = ttsText.trim();
    if (text.length === 0 || !targetReady) return;
    setBusyId("tts");
    const req: SendEffectRequest = {
      target: buildTarget(),
      spec: { kind: "audio", source: { via: "tts", text } },
    };
    socket.emit("effect:send", req, (result: SendEffectResult) => {
      setBusyId((cur) => (cur === "tts" ? null : cur));
      if (result.ok) {
        showStatus({ kind: "ok", text: `Speak → ${result.deliveredTo} ${plural(result.deliveredTo)}` });
        setTtsText("");
      } else {
        // Surface the adapter error inline (e.g. no ElevenLabs key configured).
        showStatus({ kind: "error", text: `Speak: ${result.error}` });
      }
    });
  }

  // --- Render ---
  return (
    <section style={cardStyle}>
      <h2 style={sectionHeadingStyle}>Soundboard</h2>

      {/* Target selector — same UX as the composer */}
      <div style={{ display: "flex", flexDirection: "column", gap: space(2) }}>
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
              <span style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>
                No connected players.
              </span>
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

      {/* Loops — sustained; stop them from the Active panel. */}
      <label style={{ ...labelStyle, marginTop: space(5) }}>Loops</label>
      <div style={effectGridStyle}>
        {LOOP_BUTTONS.map((b) => (
          <SoundButton
            key={b.id}
            label={b.label}
            onClick={() => fireButton(b)}
            disabled={!targetReady || busyId === b.id}
          />
        ))}
      </div>

      {/* Fade interval — how long weather beds fade in/out (and crossfade). */}
      <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(3) }}>
        <label style={{ ...labelStyle, whiteSpace: "nowrap" }} htmlFor="mi-fade">
          Fade {fadeSeconds}s
        </label>
        <input
          id="mi-fade"
          type="range"
          min={0}
          max={15}
          step={1}
          value={fadeSeconds}
          onChange={(e) => setFadeSeconds(Number(e.target.value))}
          style={{ flex: 1, accentColor: palette.ember, cursor: "pointer" }}
        />
      </div>

      {/* One-shots — transient; auto-close. */}
      <label style={{ ...labelStyle, marginTop: space(5) }}>One-shots</label>
      <div style={effectGridStyle}>
        {ONESHOT_BUTTONS.map((b) => (
          <SoundButton
            key={b.id}
            label={b.label}
            onClick={() => fireButton(b)}
            disabled={!targetReady || busyId === b.id}
          />
        ))}
      </div>

      {/* TTS "Speak" row */}
      <div style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(5) }}>
        <label style={labelStyle}>Speak (text-to-speech)</label>
        <div style={{ display: "flex", gap: space(2), alignItems: "stretch" }}>
          <input
            type="text"
            placeholder="Say something aloud…"
            value={ttsText}
            maxLength={600}
            onChange={(e) => setTtsText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") fireSpeak();
            }}
            style={{
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
            }}
          />
          <button
            onClick={fireSpeak}
            disabled={ttsText.trim().length === 0 || !targetReady || busyId === "tts"}
            style={sendButtonStyle(ttsText.trim().length === 0 || !targetReady || busyId === "tts")}
          >
            {busyId === "tts" ? "Speaking…" : "Speak"}
          </button>
        </div>
      </div>

      {/* Transient status line */}
      {status && (
        <p
          style={{
            margin: `${space(4)} 0 0`,
            fontSize: "0.85rem",
            color: status.kind === "error" ? palette.ember : "var(--text-dim)",
          }}
        >
          {status.text}
        </p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// SoundButton — one-tap atmosphere trigger
// ---------------------------------------------------------------------------

interface SoundButtonProps {
  label: string;
  onClick: () => void;
  disabled: boolean;
}

function SoundButton({ label, onClick, disabled }: SoundButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: `${space(3)} ${space(3)}`,
        background: disabled ? palette.ash : "var(--surface)",
        color: disabled ? palette.parchmentDim : palette.ember,
        border: `1px solid ${disabled ? palette.ash : palette.emberDim}`,
        borderRadius: radius.md,
        fontSize: "0.9rem",
        fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background 0.15s, color 0.15s, border-color 0.15s",
        textAlign: "center",
      }}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// PlayerChip (local copy — matches MessageComposer's chip)
// ---------------------------------------------------------------------------

interface PlayerChipProps {
  player: Player;
  selected: boolean;
  onClick: () => void;
}

function PlayerChip({ player, selected, onClick }: PlayerChipProps) {
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
// ToggleButton (local copy — matches MessageComposer's toggle)
// ---------------------------------------------------------------------------

interface ToggleButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ToggleButton({ active, onClick, children }: ToggleButtonProps) {
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

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

function plural(n: number): string {
  return n === 1 ? "player" : "players";
}

// ---------------------------------------------------------------------------
// Style constants (match MessageComposer's card look)
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: `${space(5)} ${space(5)}`,
  background: "var(--surface)",
  borderRadius: radius.md,
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: `0 0 ${space(4)}`,
  fontSize: "0.78rem",
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const labelStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 600,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const effectGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))",
  gap: space(2),
  marginTop: space(2),
};

function sendButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(3)} ${space(5)}`,
    background: disabled ? palette.ash : palette.ember,
    color: disabled ? palette.parchmentDim : palette.nearBlack,
    border: "none",
    borderRadius: radius.md,
    fontWeight: 700,
    fontSize: "0.95rem",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
    whiteSpace: "nowrap",
  };
}
