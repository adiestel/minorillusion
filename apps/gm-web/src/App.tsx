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

  // Session restore: on mount, if a saved code exists, attempt circle:open.
  // We wait until the socket is connected before emitting.
  useEffect(() => {
    const code = loadCircleCode();
    if (code === null) return;

    function attempt() {
      if (code === null) return;
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

    if (socket.connected) {
      attempt();
    } else {
      // Wait for the first successful connection, then restore.
      socket.once("connect", attempt);
      return () => { socket.off("connect", attempt); };
    }
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

      {/* Main */}
      <main style={{ padding: `${space(8)} ${space(5)}`, maxWidth: "520px", margin: "0 auto" }}>
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

function CirclePanel({ circle, players, onLeave }: CirclePanelProps) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space(8) }}>
      {/* Join code — prominent */}
      <section style={sectionStyle}>
        <h2 style={sectionHeadingStyle}>Join code</h2>
        <p style={{ margin: `0 0 ${space(3)}`, color: "var(--text-dim)", fontSize: "0.88rem" }}>
          Share this with your players.
        </p>
        <div style={{
          display: "inline-block",
          padding: `${space(4)} ${space(6)}`,
          background: "var(--surface)",
          border: `1px solid ${palette.emberDim}`,
          borderRadius: radius.md,
        }}>
          <span style={{
            fontSize: "3rem",
            fontWeight: 800,
            letterSpacing: "0.25em",
            color: palette.ember,
            fontVariantNumeric: "tabular-nums",
          }}>
            {circle.code}
          </span>
        </div>
        {circle.name && (
          <p style={{ margin: `${space(3)} 0 0`, color: "var(--text-dim)", fontSize: "0.88rem" }}>
            {circle.name}
          </p>
        )}
      </section>

      {/* Presence list */}
      <section style={sectionStyle}>
        <h2 style={sectionHeadingStyle}>
          Players
          <span style={{
            marginLeft: space(2),
            padding: `2px ${space(2)}`,
            background: palette.ash,
            borderRadius: radius.pill,
            fontSize: "0.75rem",
            fontWeight: 600,
            verticalAlign: "middle",
          }}>
            {players.filter((p) => p.connected).length}/{players.length}
          </span>
        </h2>

        {players.length === 0 ? (
          <p style={{ color: "var(--text-dim)", fontSize: "0.92rem" }}>
            Waiting for players to join…
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: space(2) }}>
            {players.map((player) => (
              <PlayerRow key={player.id} player={player} />
            ))}
          </ul>
        )}
      </section>

      <Divider />

      {/* M1 — message composer */}
      <MessageComposer players={players} />

      <Divider />

      {/* M2 — soundboard: one-tap atmosphere triggers */}
      <Soundboard players={players} />

      <Divider />

      {/* M2 — live registry of running effects (stop / countdown) */}
      <ActiveEffects circle={circle} players={players} />

      <Divider />

      {/* Leave control — detaches this browser only; does not end the circle server-side */}
      <section style={sectionStyle}>
        <h2 style={sectionHeadingStyle}>Session</h2>
        <p style={{ margin: `0 0 ${space(4)}`, color: "var(--text-dim)", fontSize: "0.88rem" }}>
          Leave this circle on this device. The circle stays active for your players.
        </p>
        <button
          style={leaveButtonStyle}
          onClick={onLeave}
        >
          Leave circle
        </button>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PlayerRow
// ---------------------------------------------------------------------------

function PlayerRow({ player }: { player: Player }) {
  return (
    <li style={{
      display: "flex",
      alignItems: "center",
      gap: space(3),
      padding: `${space(3)} ${space(4)}`,
      background: "var(--surface)",
      borderRadius: radius.md,
      transition: "opacity 0.2s",
      opacity: player.connected ? 1 : 0.45,
    }}>
      {/* Connected dot */}
      <span style={{
        width: "10px",
        height: "10px",
        borderRadius: "50%",
        background: player.connected ? palette.ember : palette.ash,
        flexShrink: 0,
        transition: "background 0.3s",
      }} />
      <span style={{ fontWeight: 500 }}>{player.name}</span>
      {!player.connected && (
        <span style={{ marginLeft: "auto", fontSize: "0.78rem", color: "var(--text-dim)" }}>
          disconnected
        </span>
      )}
    </li>
  );
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
