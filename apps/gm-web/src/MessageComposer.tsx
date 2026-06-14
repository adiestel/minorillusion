/**
 * MessageComposer — M1 GM compose panel.
 * Emits `effect:send` and surfaces the ack result.
 * Sits alongside the presence list inside the active-circle view.
 */
import { useState } from "react";
import type {
  MessageMode,
  Player,
  SendEffectRequest,
  SendEffectResult,
  Target,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

// ---------------------------------------------------------------------------
// Types for the sent-log
// ---------------------------------------------------------------------------

interface SentEntry {
  effectId: string;
  body: string;
  mode: MessageMode;
  target: Target;
  deliveredTo: number;
  sentAt: number;
  /** Map from playerId → true once the player has acked. */
  ackedBy: Record<string, true>;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface MessageComposerProps {
  players: Player[];
}

export function MessageComposer({ players }: MessageComposerProps) {
  // --- Composer state ---
  const [body, setBody] = useState("");
  const [targetMode, setTargetMode] = useState<"broadcast" | "players">("broadcast");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<MessageMode>("acknowledge");
  const [autoDismissSecs, setAutoDismissSecs] = useState(5);

  // --- Send state ---
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // --- Sent log (keyed by effectId) ---
  const [log, setLog] = useState<SentEntry[]>([]);

  // Register the acked listener once. Because this component mounts only
  // inside the active-circle view, lifetime is bounded to that session.
  // We use a ref-free approach: the handler closes over `setLog`.
  // eslint-disable-next-line react-hooks/exhaustive-deps

  // Attach / detach effect:acked listener whenever the component mounts.
  // (No dependency array needed — the handler is stable via the setter form.)
  useState(() => {
    function onAcked({ effectId, playerId }: { effectId: string; playerId: string }) {
      setLog((prev) =>
        prev.map((entry) =>
          entry.effectId === effectId
            ? { ...entry, ackedBy: { ...entry.ackedBy, [playerId]: true } }
            : entry,
        ),
      );
    }
    socket.on("effect:acked", onAcked);
    return () => {
      socket.off("effect:acked", onAcked);
    };
  });

  // --- Derived ---
  const connectedPlayers = players.filter((p) => p.connected);
  const canSend =
    body.trim().length > 0 &&
    !sending &&
    (targetMode === "broadcast" || selectedIds.size > 0);

  // --- Handlers ---
  function togglePlayer(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSend() {
    if (!canSend) return;
    setSendError(null);
    setSending(true);

    const target: Target =
      targetMode === "broadcast"
        ? { kind: "broadcast" }
        : { kind: "players", playerIds: Array.from(selectedIds) };

    const req: SendEffectRequest = {
      target,
      spec: {
        kind: "message",
        body: body.trim(),
        mode,
        ...(mode === "auto_dismiss" ? { autoDismissMs: autoDismissSecs * 1000 } : {}),
      },
    };

    socket.emit("effect:send", req, (result: SendEffectResult) => {
      setSending(false);
      if (result.ok) {
        setLog((prev) => [
          {
            effectId: result.effectId,
            body: req.spec.kind === "message" ? req.spec.body : "",
            mode,
            target: req.target,
            deliveredTo: result.deliveredTo,
            sentAt: Date.now(),
            ackedBy: {},
          },
          ...prev,
        ]);
        setBody("");
      } else {
        setSendError(result.error);
      }
    });
  }

  // --- Render ---
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(6) }}>
      {/* ---- Composer card ---- */}
      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Send message</h2>

        {/* Body */}
        <textarea
          placeholder="Write something for your players…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={4}
          maxLength={1000}
          style={{
            width: "100%",
            boxSizing: "border-box",
            background: "var(--bg)",
            color: "var(--text)",
            border: `1px solid ${palette.ash}`,
            borderRadius: radius.md,
            padding: `${space(3)} ${space(4)}`,
            fontSize: "0.95rem",
            lineHeight: 1.55,
            resize: "vertical",
            outline: "none",
            fontFamily: "var(--font)",
            caretColor: palette.ember,
          }}
        />

        {/* Target selector */}
        <div style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(4) }}>
          <label style={labelStyle}>Target</label>
          <div style={{ display: "flex", gap: space(3) }}>
            <ToggleButton
              active={targetMode === "broadcast"}
              onClick={() => setTargetMode("broadcast")}
            >
              Everyone
            </ToggleButton>
            <ToggleButton
              active={targetMode === "players"}
              onClick={() => setTargetMode("players")}
            >
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

        {/* Mode selector */}
        <div style={{ display: "flex", flexDirection: "column", gap: space(2), marginTop: space(4) }}>
          <label style={labelStyle}>Mode</label>
          <div style={{ display: "flex", gap: space(3), flexWrap: "wrap" }}>
            {(["acknowledge", "auto_dismiss", "silent"] as const).map((m) => (
              <ToggleButton key={m} active={mode === m} onClick={() => setMode(m)}>
                {modeLabel(m)}
              </ToggleButton>
            ))}
          </div>

          {mode === "auto_dismiss" && (
            <div style={{ display: "flex", alignItems: "center", gap: space(3), marginTop: space(2) }}>
              <label style={{ ...labelStyle, margin: 0 }}>Dismiss after</label>
              <input
                type="number"
                min={1}
                max={120}
                value={autoDismissSecs}
                onChange={(e) => {
                  const v = Math.max(1, Math.min(120, Number(e.target.value)));
                  setAutoDismissSecs(v);
                }}
                style={{
                  width: "64px",
                  background: "var(--bg)",
                  color: "var(--text)",
                  border: `1px solid ${palette.ash}`,
                  borderRadius: radius.sm,
                  padding: `${space(2)} ${space(3)}`,
                  fontSize: "0.95rem",
                  textAlign: "center",
                  fontVariantNumeric: "tabular-nums",
                  outline: "none",
                }}
              />
              <span style={{ fontSize: "0.88rem", color: "var(--text-dim)" }}>seconds</span>
            </div>
          )}
        </div>

        {/* Send */}
        <div style={{ marginTop: space(5), display: "flex", alignItems: "center", gap: space(4) }}>
          <button
            onClick={handleSend}
            disabled={!canSend}
            style={sendButtonStyle(!canSend)}
          >
            {sending ? "Sending…" : "Send"}
          </button>
          {sendError && (
            <span style={{ fontSize: "0.85rem", color: palette.ember }}>{sendError}</span>
          )}
        </div>
      </section>

      {/* ---- Sent log ---- */}
      {log.length > 0 && (
        <section style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
          <h2 style={sectionHeadingStyle}>Sent log</h2>
          <div style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
            {log.map((entry) => (
              <SentEntryRow
                key={entry.effectId}
                entry={entry}
                players={players}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SentEntryRow
// ---------------------------------------------------------------------------

interface SentEntryRowProps {
  entry: SentEntry;
  players: Player[];
}

function SentEntryRow({ entry, players }: SentEntryRowProps) {
  const playerMap = new Map(players.map((p) => [p.id, p.name]));
  const ackedNames = Object.keys(entry.ackedBy).map(
    (id) => playerMap.get(id) ?? id,
  );

  const targetLabel =
    entry.target.kind === "broadcast"
      ? "Everyone"
      : entry.target.playerIds
          .map((id) => playerMap.get(id) ?? id)
          .join(", ");

  return (
    <div
      style={{
        padding: `${space(3)} ${space(4)}`,
        background: "var(--surface)",
        borderRadius: radius.md,
        display: "flex",
        flexDirection: "column",
        gap: space(2),
        borderLeft: `3px solid ${palette.emberDim}`,
      }}
    >
      {/* Body preview */}
      <p style={{
        margin: 0,
        fontSize: "0.92rem",
        color: "var(--text)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}>
        {entry.body}
      </p>

      {/* Meta row */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: space(4), fontSize: "0.78rem", color: "var(--text-dim)" }}>
        <span>
          <MetaLabel>To:</MetaLabel> {targetLabel}
        </span>
        <span>
          <MetaLabel>Mode:</MetaLabel> {modeLabel(entry.mode)}
        </span>
        <span>
          <MetaLabel>Delivered:</MetaLabel> {entry.deliveredTo}
        </span>
        <span>
          <MetaLabel>Time:</MetaLabel> {new Date(entry.sentAt).toLocaleTimeString()}
        </span>
      </div>

      {/* Ack row — only for acknowledge mode */}
      {entry.mode === "acknowledge" && (
        <div style={{ fontSize: "0.78rem", color: "var(--text-dim)", display: "flex", flexWrap: "wrap", gap: space(2) }}>
          <MetaLabel>Acked:</MetaLabel>
          {ackedNames.length === 0 ? (
            <span style={{ fontStyle: "italic" }}>none yet</span>
          ) : (
            ackedNames.map((name, i) => (
              <span
                key={i}
                style={{
                  padding: `1px ${space(2)}`,
                  background: palette.ash,
                  borderRadius: radius.pill,
                  color: palette.ember,
                  fontWeight: 600,
                }}
              >
                {name}
              </span>
            ))
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlayerChip
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
// ToggleButton
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

function MetaLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontWeight: 700, color: palette.parchmentDim }}>{children}</span>
  );
}

function modeLabel(m: MessageMode): string {
  switch (m) {
    case "acknowledge": return "Acknowledge";
    case "auto_dismiss": return "Auto-dismiss";
    case "silent": return "Silent";
  }
}

// ---------------------------------------------------------------------------
// Style constants
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

function sendButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(3)} ${space(6)}`,
    background: disabled ? palette.ash : palette.ember,
    color: disabled ? palette.parchmentDim : palette.nearBlack,
    border: "none",
    borderRadius: radius.md,
    fontWeight: 700,
    fontSize: "0.95rem",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
  };
}
