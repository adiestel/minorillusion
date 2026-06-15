/**
 * GM control surface — M0.
 * Lets the GM create a circle or open an existing one, then watches
 * players join/leave in real time via presence:update.
 *
 * Session restore (added): the active circle code is persisted in
 * localStorage under `mi.gm.circle` so a page refresh re-attaches
 * the GM automatically via circle:open.
 */
import {
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type {
  ChannelMessage,
  Circle,
  CreateCircleResult,
  OpenCircleResult,
  Player,
  PresenceUpdate,
} from "@minorillusion/contract";
import { gmTheme, palette, radius, space, themeVars } from "@minorillusion/design-system";
import { socket } from "./socket";
import { MessageComposer } from "./MessageComposer";
import { Soundboard } from "./Soundboard";
import { ActiveEffects } from "./ActiveEffects";
import { Stage } from "./Stage";
import { PlayersPanel } from "./PlayersPanel";
import { Channel } from "./Channel";
import { WhisperVoices } from "./WhisperVoices";
import { MasterVolume } from "./MasterVolume";
import { usePersistentState } from "./usePersistentState";

// ---------------------------------------------------------------------------
// Session-restore helpers
// ---------------------------------------------------------------------------

const CIRCLE_KEY = "mi.gm.circle";

function persistCircleCode(code: string): void {
  try {
    localStorage.setItem(CIRCLE_KEY, code);
  } catch {
    // storage not available — silently ignore
  }
}

function clearCircleCode(): void {
  try {
    localStorage.removeItem(CIRCLE_KEY);
  } catch {
    // storage not available — silently ignore
  }
}

function loadCircleCode(): string | null {
  try {
    return localStorage.getItem(CIRCLE_KEY);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type AppState =
  | { phase: "idle" }
  | { phase: "restoring" }
  | { phase: "active"; circle: Circle; players: Player[] };

type AppAction =
  | { type: "circle_opened"; circle: Circle; players: Player[] }
  | { type: "restore_failed" }
  | { type: "presence_update"; update: PresenceUpdate }
  | { type: "leave" };

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "circle_opened":
      return { phase: "active", circle: action.circle, players: action.players };
    case "restore_failed":
      return { phase: "idle" };
    case "leave":
      return { phase: "idle" };
    case "presence_update":
      if (state.phase !== "active") return state;
      if (action.update.circleId !== state.circle.id) return state;
      return { ...state, players: action.update.players };
  }
}

// ---------------------------------------------------------------------------
// Root app
// ---------------------------------------------------------------------------

export function App() {
  const savedCode = loadCircleCode();
  const [state, dispatch] = useReducer(
    appReducer,
    savedCode !== null ? { phase: "restoring" } : { phase: "idle" },
  );
  const [connected, setConnected] = useState(socket.connected);

  // Subscribe to socket lifecycle and presence:update once.
  useEffect(() => {
    function onConnect() { setConnected(true); }
    function onDisconnect() { setConnected(false); }
    function onPresence(update: PresenceUpdate) {
      dispatch({ type: "presence_update", update });
    }

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("presence:update", onPresence);
    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("presence:update", onPresence);
    };
  }, []);

  // Session restore + reconnect: re-open the saved circle on every (re)connect.
  // A reconnected socket (server restart / network blip) gets a fresh id with no
  // room membership or binding, so without re-opening the GM would stop seeing
  // presence / effects and couldn't send — re-opening re-subscribes and pulls a
  // fresh roster + active-effects snapshot.
  useEffect(() => {
    function attempt() {
      const code = loadCircleCode();
      if (code === null) return; // no circle yet — nothing to re-open
      socket.emit("circle:open", { code }, (result: OpenCircleResult) => {
        if (result.ok) {
          persistCircleCode(result.circle.code);
          dispatch({ type: "circle_opened", circle: result.circle, players: result.players });
        } else {
          clearCircleCode();
          dispatch({ type: "restore_failed" });
        }
      });
    }

    // ALWAYS listen for (re)connects so the GM re-subscribes after a restart —
    // even a GM that created its circle fresh this session (which had no saved
    // code at mount and so previously registered no reconnect handler).
    socket.on("connect", attempt);
    if (loadCircleCode() !== null && socket.connected) attempt();
    return () => { socket.off("connect", attempt); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCircleReady = useCallback(
    (circle: Circle, players: Player[]) => {
      persistCircleCode(circle.code);
      dispatch({ type: "circle_opened", circle, players });
    },
    [],
  );

  const handleLeave = useCallback(() => {
    clearCircleCode();
    dispatch({ type: "leave" });
  }, []);

  const vars = themeVars(gmTheme) as Record<string, string>;

  return (
    <div style={{ ...vars, minHeight: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "var(--font)" }}>
      {/* Header */}
      <header style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: `${space(3)} ${space(5)}`,
        borderBottom: `1px solid ${palette.ash}`,
      }}>
        <span style={{ fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", fontSize: "0.85rem", color: "var(--text-dim)" }}>
          Minor Illusion
        </span>
        <StatusDot connected={connected} />
      </header>

      {/* Main — a wide two-column console when a circle is active (controls +
          live Stage side by side); narrow for the landing/restore screens. */}
      <main
        style={{
          padding: `${space(8)} ${space(5)}`,
          maxWidth: state.phase === "active" ? "1360px" : "520px",
          margin: "0 auto",
          width: "100%",
          boxSizing: "border-box",
        }}
      >
        {state.phase === "restoring" ? (
          <RestoringView />
        ) : state.phase === "idle" ? (
          <LandingPanel onReady={handleCircleReady} connected={connected} />
        ) : (
          <CirclePanel circle={state.circle} players={state.players} onLeave={handleLeave} />
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StatusDot — socket connection indicator
// ---------------------------------------------------------------------------

function StatusDot({ connected }: { connected: boolean }) {
  return (
    <span style={{ display: "flex", alignItems: "center", gap: space(2), fontSize: "0.78rem", color: "var(--text-dim)" }}>
      <span style={{
        width: "8px",
        height: "8px",
        borderRadius: radius.pill,
        background: connected ? palette.ember : palette.ash,
        display: "inline-block",
        transition: "background 0.3s",
      }} />
      {connected ? "connected" : "offline"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// LandingPanel — create or open a circle
// ---------------------------------------------------------------------------

interface LandingPanelProps {
  onReady: (circle: Circle, players: Player[]) => void;
  connected: boolean;
}

function LandingPanel({ onReady, connected }: LandingPanelProps) {
  const [createError, setCreateError] = useState<string | null>(null);
  const [createBusy, setCreateBusy] = useState(false);

  const [openCode, setOpenCode] = useState("");
  const [openError, setOpenError] = useState<string | null>(null);
  const [openBusy, setOpenBusy] = useState(false);

  function handleCreate() {
    setCreateError(null);
    setCreateBusy(true);
    socket.emit("circle:create", {}, (result: CreateCircleResult) => {
      setCreateBusy(false);
      onReady(result.circle, []);
    });
  }

  function handleOpen(e: React.FormEvent) {
    e.preventDefault();
    if (openCode.length !== 6) {
      setOpenError("Enter a 6-digit code.");
      return;
    }
    setOpenError(null);
    setOpenBusy(true);
    socket.emit("circle:open", { code: openCode }, (result: OpenCircleResult) => {
      setOpenBusy(false);
      if (result.ok) {
        onReady(result.circle, result.players);
      } else {
        setOpenError(result.error);
      }
    });
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(8) }}>
      <h1 style={{ margin: 0, fontSize: "1.5rem", fontWeight: 700 }}>
        Game Master Console
      </h1>

      {/* Create */}
      <section style={sectionStyle}>
        <h2 style={sectionHeadingStyle}>Start a new circle</h2>
        <p style={{ margin: `0 0 ${space(4)}`, color: "var(--text-dim)", fontSize: "0.92rem" }}>
          Generate a fresh join code for your players.
        </p>
        <button
          style={primaryButtonStyle(createBusy || !connected)}
          disabled={createBusy || !connected}
          onClick={handleCreate}
        >
          {createBusy ? "Creating…" : "Create circle"}
        </button>
        {createError && <ErrorLine message={createError} />}
      </section>

      <Divider />

      {/* Open */}
      <section style={sectionStyle}>
        <h2 style={sectionHeadingStyle}>Rejoin an existing circle</h2>
        <form onSubmit={handleOpen} style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
          <CodeInput
            value={openCode}
            onChange={(v) => { setOpenCode(v); setOpenError(null); }}
          />
          <button
            style={primaryButtonStyle(openBusy || !connected || openCode.length !== 6)}
            disabled={openBusy || !connected || openCode.length !== 6}
            type="submit"
          >
            {openBusy ? "Opening…" : "Open circle"}
          </button>
          {openError && <ErrorLine message={openError} />}
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RestoringView — shown briefly while we attempt session restore
// ---------------------------------------------------------------------------

function RestoringView() {
  return (
    <p style={{ color: "var(--text-dim)", fontSize: "0.92rem" }}>
      Restoring session…
    </p>
  );
}

// ---------------------------------------------------------------------------
// CirclePanel — active circle: join code + live presence list
// ---------------------------------------------------------------------------

interface CirclePanelProps {
  circle: Circle;
  players: Player[];
  onLeave: () => void;
}

type Tab = "effects" | "messages" | "channel" | "players";

/** Max inbound messages retained in the GM inbox (newest kept). */
const CHANNEL_CAP = 100;

function CirclePanel({ circle, players, onLeave }: CirclePanelProps) {
  const [tab, setTab] = usePersistentState<Tab>("mi.gm.tab", "effects");
  const connected = players.filter((p) => p.connected).length;

  // Inbox state — App owns the live message list + the channel:message listener
  // (the Channel panel only renders + replies). Newest-first; capped.
  const [messages, setMessages] = useState<ChannelMessage[]>([]);
  // Unread tracking: how many messages the GM has "seen". Reset to the current
  // length whenever the Channel tab is open; unread is the difference.
  const [seenCount, setSeenCount] = useState(0);

  useEffect(() => {
    function onChannelMessage(message: ChannelMessage) {
      setMessages((prev) => {
        // Ignore messages from other circles (defensive) and de-dupe by id.
        if (message.circleId !== circle.id) return prev;
        if (prev.some((m) => m.id === message.id)) return prev;
        return [message, ...prev].slice(0, CHANNEL_CAP);
      });
    }
    socket.on("channel:message", onChannelMessage);
    return () => {
      socket.off("channel:message", onChannelMessage);
    };
  }, [circle.id]);

  // When the Channel tab is open, everything is considered seen.
  useEffect(() => {
    if (tab === "channel") setSeenCount(messages.length);
  }, [tab, messages.length]);

  const unread = Math.max(0, messages.length - seenCount);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(6) }}>
      {/* Circle header — always visible: join code, live count, leave. */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: space(4),
        flexWrap: "wrap",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: space(4), flexWrap: "wrap" }}>
          <CodeChip code={circle.code} />
          <span style={{ fontSize: "0.88rem", color: "var(--text-dim)" }}>
            {connected}/{players.length} {players.length === 1 ? "player" : "players"}
            {circle.name ? ` · ${circle.name}` : ""}
          </span>
        </div>
        <button style={leaveButtonStyle} onClick={onLeave}>
          Leave
        </button>
      </div>

      {/* Two columns: control tabs on the left, the live Stage on the right —
          so effects show up in the player previews as the GM fires them. Wraps
          to a single column on a narrow window (Stage drops below the controls). */}
      <div style={{ display: "flex", gap: space(6), alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* LEFT — control tabs */}
        <div style={{ flex: "1 1 360px", minWidth: 320, maxWidth: 560, display: "flex", flexDirection: "column", gap: space(5) }}>
          <div style={{ display: "flex", gap: space(1), borderBottom: `1px solid ${palette.ash}` }}>
            {(["effects", "messages", "channel", "players"] as const).map((id) => (
              <button key={id} onClick={() => setTab(id)} style={tabButtonStyle(tab === id)}>
                {tabLabel(id)}
                {id === "channel" && unread > 0 && <UnreadBadge count={unread} />}
              </button>
            ))}
          </div>

          {tab === "effects" && (
            <div style={{ display: "flex", flexDirection: "column", gap: space(6) }}>
              <Soundboard players={players} />
              <WhisperVoices players={players} />
              <ActiveEffects circle={circle} players={players} />
            </div>
          )}

          {tab === "messages" && <MessageComposer players={players} />}

          {tab === "channel" && <Channel players={players} messages={messages} />}

          {tab === "players" && <PlayersPanel players={players} />}
        </div>

        {/* RIGHT — the live Stage with the master volume right under the table,
            sticky so both stay in view while scrolling. */}
        <div style={{ flex: "1 1 440px", minWidth: 340, position: "sticky", top: space(4) }}>
          <div style={{ display: "flex", flexDirection: "column", gap: space(4) }}>
            <Stage circle={circle} players={players} />
            <MasterVolume />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CodeChip — compact-but-legible join code (always visible in the header)
// ---------------------------------------------------------------------------

function CodeChip({ code }: { code: string }) {
  return (
    <div style={{
      display: "inline-flex",
      alignItems: "baseline",
      gap: space(2),
      padding: `${space(2)} ${space(4)}`,
      background: "var(--surface)",
      border: `1px solid ${palette.emberDim}`,
      borderRadius: radius.md,
    }}>
      <span style={{
        fontSize: "0.62rem",
        letterSpacing: "0.14em",
        textTransform: "uppercase",
        color: "var(--text-dim)",
      }}>
        Join
      </span>
      <span style={{
        fontSize: "1.55rem",
        fontWeight: 800,
        letterSpacing: "0.22em",
        color: palette.ember,
        fontVariantNumeric: "tabular-nums",
      }}>
        {code}
      </span>
    </div>
  );
}

function tabLabel(id: Tab): string {
  switch (id) {
    case "effects": return "Effects";
    case "messages": return "Messages";
    case "channel": return "Channel";
    case "players": return "Players";
  }
}

// ---------------------------------------------------------------------------
// UnreadBadge — small ember count on the Channel tab when notes arrive while
// the GM is on another tab.
// ---------------------------------------------------------------------------

function UnreadBadge({ count }: { count: number }) {
  return (
    <span
      aria-label={`${count} unread`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        minWidth: "16px",
        height: "16px",
        marginLeft: space(2),
        padding: "0 4px",
        boxSizing: "border-box",
        background: palette.ember,
        color: palette.nearBlack,
        borderRadius: radius.pill,
        fontSize: "0.66rem",
        fontWeight: 800,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
        verticalAlign: "middle",
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: `${space(3)} ${space(4)}`,
    background: "transparent",
    color: active ? palette.ember : "var(--text-dim)",
    border: "none",
    borderBottom: `2px solid ${active ? palette.ember : "transparent"}`,
    marginBottom: "-1px",
    fontWeight: active ? 700 : 500,
    fontSize: "0.9rem",
    letterSpacing: "0.04em",
    cursor: "pointer",
    transition: "color 0.15s, border-color 0.15s",
  };
}

// ---------------------------------------------------------------------------
// CodeInput — controlled 6-digit numeric input
// ---------------------------------------------------------------------------

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="numeric"
      pattern="\d{6}"
      maxLength={6}
      placeholder="000000"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 6))}
      style={{
        background: "var(--surface)",
        color: "var(--text)",
        border: `1px solid ${palette.ash}`,
        borderRadius: radius.md,
        padding: `${space(3)} ${space(4)}`,
        fontSize: "1.6rem",
        fontWeight: 700,
        letterSpacing: "0.3em",
        width: "100%",
        boxSizing: "border-box",
        fontVariantNumeric: "tabular-nums",
        outline: "none",
        caretColor: palette.ember,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function ErrorLine({ message }: { message: string }) {
  return (
    <p style={{ margin: `${space(2)} 0 0`, color: palette.ember, fontSize: "0.85rem" }}>
      {message}
    </p>
  );
}

function Divider() {
  return (
    <hr style={{ border: "none", borderTop: `1px solid ${palette.ash}`, margin: 0 }} />
  );
}

// ---------------------------------------------------------------------------
// Style helpers
// ---------------------------------------------------------------------------

const sectionStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

const sectionHeadingStyle: React.CSSProperties = {
  margin: `0 0 ${space(3)}`,
  fontSize: "0.78rem",
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
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
    alignSelf: "flex-start",
  };
}

const leaveButtonStyle: React.CSSProperties = {
  padding: `${space(2)} ${space(4)}`,
  background: "transparent",
  color: "var(--text-dim)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  fontWeight: 600,
  fontSize: "0.85rem",
  cursor: "pointer",
  transition: "color 0.15s, border-color 0.15s",
  alignSelf: "flex-start",
};
