/**
 * ActiveEffects — M2 GM live registry panel (control rework).
 *
 * Subscribes to the server's authoritative `effects:active` push and shows what
 * is currently running in this circle (and for whom). Two row shapes:
 *   • sustained (a loop / ambiance / storm) → a Stop button that emits
 *     `effect:stop`; the server removing it from the registry clears the row.
 *   • transient (a one-shot cue / heartbeat) → a live countdown bar that ticks
 *     down to its auto-close. The bar is display-only: the row disappears when
 *     the server drops the effect from the next `effects:active` snapshot.
 *
 * A "Stop all" control stops every active effect at once. Sits in the
 * active-circle view alongside the Soundboard.
 */
import { useEffect, useState } from "react";
import type {
  ActiveEffect,
  ActiveEffects as ActiveEffectsPayload,
  Circle,
  Player,
  Target,
  WhisperProgress,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ActiveEffectsProps {
  circle: Circle;
  players: Player[];
}

export function ActiveEffects({ circle, players }: ActiveEffectsProps) {
  const [active, setActive] = useState<ActiveEffect[]>([]);

  // Subscribe to the circle's live active-effects registry. Filter by circle id
  // so a stale push from a previous circle can't bleed in.
  useEffect(() => {
    function onActive(payload: ActiveEffectsPayload) {
      if (payload.circleId === circle.id) setActive(payload.effects);
    }
    socket.on("effects:active", onActive);
    return () => {
      socket.off("effects:active", onActive);
    };
  }, [circle.id]);

  function stop(effectId: string) {
    socket.emit("effect:stop", { effectId }, () => {});
  }

  function stopAll() {
    for (const e of active) {
      socket.emit("effect:stop", { effectId: e.id }, () => {});
    }
  }

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: space(4) }}>
        <h2 style={{ ...sectionHeadingStyle, margin: 0 }}>Active effects</h2>
        {active.length > 0 && (
          <button onClick={stopAll} style={stopAllButtonStyle}>
            Stop all
          </button>
        )}
      </div>

      {active.length === 0 ? (
        <p style={{ margin: 0, fontSize: "0.88rem", color: "var(--text-dim)" }}>
          No active effects.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: space(2) }}>
          {active.map((e) => (
            <ActiveRow key={e.id} effect={e} players={players} onStop={() => stop(e.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ActiveRow — one running effect
// ---------------------------------------------------------------------------

interface ActiveRowProps {
  effect: ActiveEffect;
  players: Player[];
  onStop: () => void;
}

function ActiveRow({ effect, players, onStop }: ActiveRowProps) {
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: space(3),
        padding: `${space(3)} ${space(4)}`,
        background: "var(--surface)",
        borderRadius: radius.md,
        borderLeft: `3px solid ${palette.emberDim}`,
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: space(1), minWidth: 0, flex: 1 }}>
        <span style={{ fontWeight: 600, fontSize: "0.92rem", color: "var(--text)" }}>
          {effect.label}
        </span>
        <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
          {targetLabel(effect.target, players)}
        </span>
        {effect.whisper && <WhisperNow progress={effect.whisper} />}
      </div>

      {effect.sustained ? (
        <button onClick={onStop} style={stopButtonStyle}>
          Stop
        </button>
      ) : (
        <Countdown startedAt={effect.startedAt} durationMs={effect.durationMs} />
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// WhisperNow — the whisperscape's live phrase readout: the line sounding now
// (highlighted) plus where it sits in the pass and how many remain. Driven by
// the authoritative `whisper` progress the server stamps on the active record.
// ---------------------------------------------------------------------------

function WhisperNow({ progress }: { progress: WhisperProgress }) {
  const { phrase, index, total, remaining, order, loop } = progress;
  const meta =
    `${order === "random" ? "shuffled" : "in order"} · ` +
    `${index + 1}/${total} · ${remaining} left` +
    (loop ? " · loops" : "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 2, minWidth: 0 }}>
      <span
        style={{
          fontSize: "0.82rem",
          fontStyle: "italic",
          color: palette.ember,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={phrase}
      >
        “{phrase}”
      </span>
      <span style={{ fontSize: "0.72rem", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
        {meta}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Countdown — display-only shrinking bar + "Ns left" for transient effects.
// The server clears the row when the effect actually expires.
// ---------------------------------------------------------------------------

function Countdown({ startedAt, durationMs }: { startedAt: string; durationMs?: number }) {
  const total = durationMs ?? 0;
  const [remaining, setRemaining] = useState(() => computeRemaining(startedAt, total));

  useEffect(() => {
    setRemaining(computeRemaining(startedAt, total));
    if (total <= 0) return;
    const id = setInterval(() => {
      setRemaining(computeRemaining(startedAt, total));
    }, 200);
    return () => clearInterval(id);
  }, [startedAt, total]);

  // No usable duration — show a neutral marker rather than a 0s bar.
  if (total <= 0) {
    return <span style={{ fontSize: "0.78rem", color: "var(--text-dim)", whiteSpace: "nowrap" }}>running</span>;
  }

  const pct = Math.max(0, Math.min(100, (remaining / total) * 100));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space(2), minWidth: "96px" }}>
      <div
        style={{
          flex: 1,
          height: "6px",
          background: palette.ash,
          borderRadius: radius.pill,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            background: palette.ember,
            transition: "width 0.2s linear",
          }}
        />
      </div>
      <span style={{ fontSize: "0.78rem", color: "var(--text-dim)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
        {Math.ceil(remaining / 1000)}s left
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ms left until a transient effect auto-closes, clamped at 0. */
function computeRemaining(startedAt: string, durationMs: number): number {
  const elapsed = Date.now() - Date.parse(startedAt);
  return Math.max(0, durationMs - elapsed);
}

/** Resolve a target to display text: "Everyone" or comma-joined player names. */
function targetLabel(target: Target, players: Player[]): string {
  if (target.kind === "broadcast") return "Everyone";
  const byId = new Map(players.map((p) => [p.id, p.name]));
  return target.playerIds.map((id) => byId.get(id) ?? id).join(", ");
}

// ---------------------------------------------------------------------------
// Style constants (match the Soundboard / MessageComposer cards)
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  padding: `${space(5)} ${space(5)}`,
  background: "var(--surface)",
  borderRadius: radius.md,
};

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const stopButtonStyle: React.CSSProperties = {
  padding: `${space(2)} ${space(4)}`,
  background: "transparent",
  color: palette.ember,
  border: `1px solid ${palette.emberDim}`,
  borderRadius: radius.md,
  fontWeight: 600,
  fontSize: "0.85rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.15s, color 0.15s, border-color 0.15s",
};

const stopAllButtonStyle: React.CSSProperties = {
  padding: `${space(2)} ${space(4)}`,
  background: palette.emberDim,
  color: palette.bone,
  border: `1px solid ${palette.ember}`,
  borderRadius: radius.md,
  fontWeight: 700,
  fontSize: "0.8rem",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background 0.15s",
};
