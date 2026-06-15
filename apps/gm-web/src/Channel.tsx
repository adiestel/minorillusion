/**
 * Channel — M3 GM inbox + reply panel (players speaking back).
 *
 * Players tap their resting canvas and either write (the quill → text) or
 * hold-to-talk (the crystal ball → a recorded clip the server transcribes via
 * STT). Both arrive here as a `ChannelMessage`. The GM reads the inbox and
 * replies with a message effect targeted at the *sender* — reusing the existing
 * effect router — to close the loop.
 *
 * App owns the live message list + the `channel:message` listener and passes
 * the array down; this panel only renders + replies. Matches the look of the
 * MessageComposer / Soundboard panels (card surface, ember accents, uppercase
 * section headings). Normal dense console UI text — this is the GM side.
 */
import { useState } from "react";
import type {
  ChannelMessage,
  MessageMode,
  Player,
  SendEffectRequest,
  SendEffectResult,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";
import { usePersistentState } from "./usePersistentState";

// Auto-dismiss duration for GM replies in auto_dismiss mode (ms).
const REPLY_AUTO_DISMISS_MS = 8000;

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

interface ChannelProps {
  players: Player[];
  messages: ChannelMessage[];
}

export function Channel({ players, messages }: ChannelProps) {
  // The reply delivery mode persists across reloads; it's a GM preference.
  const [replyMode, setReplyMode] = usePersistentState<MessageMode>(
    "mi.gm.channel.replyMode",
    "auto_dismiss",
  );

  // Newest-first. The contract stamps createdAt; App already prepends, but sort
  // defensively so order is correct regardless of arrival order.
  const ordered = [...messages].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(6) }}>
      <section style={cardStyle}>
        <h2 style={sectionHeadingStyle}>Channel — player messages</h2>

        {ordered.length === 0 ? (
          <p style={emptyStyle}>
            No messages yet — players' quill/voice notes will appear here.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
            {ordered.map((message) => (
              <MessageRow
                key={message.id}
                message={message}
                replyMode={replyMode}
                onReplyModeChange={setReplyMode}
                players={players}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// MessageRow — one inbound message + its inline reply affordance
// ---------------------------------------------------------------------------

interface MessageRowProps {
  message: ChannelMessage;
  replyMode: MessageMode;
  onReplyModeChange: (mode: MessageMode) => void;
  players: Player[];
}

type ReplyStatus =
  | { kind: "sent"; deliveredTo: number }
  | { kind: "error"; text: string }
  | null;

function MessageRow({
  message,
  replyMode,
  onReplyModeChange,
  players,
}: MessageRowProps) {
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<ReplyStatus>(null);

  // Whether the sender is currently connected — a quiet hint if they're offline,
  // since a reply targeted at them would reach 0 players.
  const sender = players.find((p) => p.id === message.from);
  const senderOffline = sender !== undefined && !sender.connected;

  const canSend = body.trim().length > 0 && !sending;

  function handleSend() {
    if (!canSend) return;
    setStatus(null);
    setSending(true);

    // Reply closes the loop: target the SENDER (message.from) with a message
    // effect via the existing effect router.
    const req: SendEffectRequest = {
      target: { kind: "players", playerIds: [message.from] },
      spec: {
        kind: "message",
        body: body.trim(),
        mode: replyMode,
        ...(replyMode === "auto_dismiss"
          ? { autoDismissMs: REPLY_AUTO_DISMISS_MS }
          : {}),
      },
    };

    socket.emit("effect:send", req, (res: SendEffectResult) => {
      setSending(false);
      if (res.ok) {
        setBody("");
        setStatus({ kind: "sent", deliveredTo: res.deliveredTo });
      } else {
        setStatus({ kind: "error", text: res.error });
      }
    });
  }

  const isVoice = message.via === "voice";

  return (
    <div style={rowStyle}>
      {/* Header — sender, channel glyph, timestamp */}
      <div style={rowHeaderStyle}>
        <span style={{ display: "flex", alignItems: "center", gap: space(2) }}>
          <ViaGlyph via={message.via} />
          <span style={{ fontWeight: 700, color: "var(--text)", fontSize: "0.92rem" }}>
            {message.fromName}
          </span>
          {senderOffline && (
            <span style={offlineTagStyle} title="This player is currently offline">
              offline
            </span>
          )}
        </span>
        <span style={{ fontSize: "0.74rem", color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}>
          {formatTime(message.createdAt)}
        </span>
      </div>

      {/* Body — the typed text or the voice transcript */}
      <p style={bodyStyle}>
        {isVoice && (
          <span style={transcriptTagStyle}>transcript</span>
        )}
        {message.text}
      </p>

      {/* Voice playback — the real clip, if the server sent it back */}
      {isVoice && message.audio !== undefined && (
        <audio
          controls
          src={message.audio}
          style={{ width: "100%", height: 32, marginTop: space(1) }}
        />
      )}

      {/* Inline reply — closes the loop back to this sender */}
      <div style={replyWrapStyle}>
        <div style={{ display: "flex", gap: space(2), alignItems: "stretch" }}>
          <input
            type="text"
            placeholder={`Reply to ${message.fromName}…`}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              if (status !== null) setStatus(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSend();
            }}
            maxLength={1000}
            style={replyInputStyle}
          />
          <button onClick={handleSend} disabled={!canSend} style={replyButtonStyle(!canSend)}>
            {sending ? "Sending…" : "Reply"}
          </button>
        </div>

        {/* Reply mode selector — remembered across reloads */}
        <div style={{ display: "flex", alignItems: "center", gap: space(2), marginTop: space(2), flexWrap: "wrap" }}>
          {(["acknowledge", "auto_dismiss", "silent"] as const).map((m) => (
            <ModeChip
              key={m}
              active={replyMode === m}
              onClick={() => onReplyModeChange(m)}
            >
              {modeLabel(m)}
            </ModeChip>
          ))}

          {/* Status / hints */}
          {status?.kind === "sent" && status.deliveredTo > 0 && (
            <span style={{ ...statusHintStyle, color: palette.ember }}>sent ✓</span>
          )}
          {status?.kind === "sent" && status.deliveredTo === 0 && (
            <span style={{ ...statusHintStyle, color: "var(--text-dim)" }}>
              sent, but reached 0 players (sender offline?)
            </span>
          )}
          {status?.kind === "error" && (
            <span style={{ ...statusHintStyle, color: palette.ember }}>{status.text}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ViaGlyph — quill (text) vs crystal ball (voice)
// ---------------------------------------------------------------------------

function ViaGlyph({ via }: { via: ChannelMessage["via"] }) {
  const isVoice = via === "voice";
  return (
    <span
      title={isVoice ? "Voice (crystal ball)" : "Text (quill)"}
      aria-label={isVoice ? "voice message" : "text message"}
      style={{
        fontSize: "0.95rem",
        lineHeight: 1,
        color: palette.ember,
      }}
    >
      {isVoice ? "🔮" : "✎"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ModeChip — small toggle for the reply delivery mode
// ---------------------------------------------------------------------------

interface ModeChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function ModeChip({ active, onClick, children }: ModeChipProps) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${space(1)} ${space(3)}`,
        background: active ? palette.emberDim : "var(--surface)",
        color: active ? palette.ember : "var(--text-dim)",
        border: `1px solid ${active ? palette.ember : palette.ash}`,
        borderRadius: radius.pill,
        fontSize: "0.76rem",
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

/** Compact local HH:MM from an ISO timestamp. */
function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function modeLabel(m: MessageMode): string {
  switch (m) {
    case "acknowledge": return "Acknowledge";
    case "auto_dismiss": return "Auto-dismiss";
    case "silent": return "Silent";
  }
}

// ---------------------------------------------------------------------------
// Style constants (match MessageComposer / Soundboard)
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
  gap: space(2),
  borderLeft: `3px solid ${palette.emberDim}`,
};

const rowHeaderStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: space(3),
};

const bodyStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.92rem",
  color: "var(--text)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  lineHeight: 1.5,
};

const transcriptTagStyle: React.CSSProperties = {
  display: "inline-block",
  marginRight: space(2),
  padding: `0 ${space(2)}`,
  fontSize: "0.64rem",
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
  background: palette.ash,
  borderRadius: radius.pill,
  verticalAlign: "middle",
};

const offlineTagStyle: React.CSSProperties = {
  padding: `0 ${space(2)}`,
  fontSize: "0.66rem",
  fontWeight: 600,
  letterSpacing: "0.06em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
  background: palette.ash,
  borderRadius: radius.pill,
};

const replyWrapStyle: React.CSSProperties = {
  marginTop: space(2),
  paddingTop: space(3),
  borderTop: `1px solid ${palette.ash}`,
};

const replyInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--surface)",
  color: "var(--text)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  padding: `${space(2)} ${space(3)}`,
  fontSize: "0.9rem",
  outline: "none",
  fontFamily: "var(--font)",
  caretColor: palette.ember,
  boxSizing: "border-box",
};

function replyButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: `${space(2)} ${space(4)}`,
    background: disabled ? palette.ash : palette.ember,
    color: disabled ? palette.parchmentDim : palette.nearBlack,
    border: "none",
    borderRadius: radius.md,
    fontWeight: 700,
    fontSize: "0.88rem",
    cursor: disabled ? "not-allowed" : "pointer",
    transition: "background 0.15s",
    whiteSpace: "nowrap",
  };
}

const statusHintStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  marginLeft: space(1),
};
