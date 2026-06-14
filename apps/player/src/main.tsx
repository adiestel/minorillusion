/**
 * Minor Illusion — Player app, M0.
 *
 * Two states:
 *   1. Join screen  — code + name inputs → circle:join emit → ack handling.
 *   2. Joined state — near-black canvas with a breathing ember and presence list.
 *
 * Contract imports: @minorillusion/contract  (types only; never hand-define wire shapes)
 * Theme imports:    @minorillusion/design-system (playerTheme, themeVars, palette, space)
 * Capability seam:  src/capabilities/index.ts  (haptics.vibrate for success buzz)
 */

import {
  StrictMode,
  useState,
  useEffect,
  useCallback,
  useRef,
  CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";

import type { JoinResult, PresenceUpdate, Player, DeliveredEffect, MessageEffect } from "@minorillusion/contract";
import { playerTheme, themeVars, palette, space } from "@minorillusion/design-system";
import { ParchmentMessage } from "./ParchmentMessage";

import { socket } from "./socket";
import { deviceId } from "./deviceId";
import { haptics } from "./capabilities/index";
import { saveSession, loadSession, clearSession } from "./session";

// ---------------------------------------------------------------------------
// CSS-in-JS helpers (no build-time CSS needed; keeps the file self-contained)
// ---------------------------------------------------------------------------

/** Inject a <style> block once on mount. */
function injectGlobalStyles() {
  if (document.getElementById("mi-global-styles")) return;
  const style = document.createElement("style");
  style.id = "mi-global-styles";
  style.textContent = `
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html, body, #root {
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: ${palette.nearBlack};
    }

    body {
      font-family: var(--font);
      color: var(--text);
      -webkit-font-smoothing: antialiased;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }

    /* The breathing ember — a faint pulsing radial glow */
    @keyframes ember-breathe {
      0%, 100% {
        opacity: 0.18;
        transform: scale(1);
      }
      50% {
        opacity: 0.38;
        transform: scale(1.12);
      }
    }

    .ember-glow {
      animation: ember-breathe 3.6s ease-in-out infinite;
    }

    /* Subtle fade-in for the joined canvas */
    @keyframes fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    .fade-in {
      animation: fade-in 1.2s ease-out forwards;
    }

    /* Input focus ring uses the accent colour */
    input:focus-visible {
      outline: 2px solid ${palette.ember};
      outline-offset: 2px;
    }

    /* Presence dot pulse */
    @keyframes presence-pulse {
      0%, 100% { opacity: 0.5; }
      50%      { opacity: 1; }
    }

    .presence-dot {
      animation: presence-pulse 2.4s ease-in-out infinite;
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface EmberProps {
  size?: number;
}

/** The breathing ember resting-state glow. Cheap DOM/CSS path (DESIGN.md). */
function Ember({ size = 240 }: EmberProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    background: `radial-gradient(circle, ${palette.ember}66 0%, ${palette.emberDim}33 45%, transparent 70%)`,
    flexShrink: 0,
  };
  return <div className="ember-glow" style={style} aria-hidden="true" />;
}

// Presence is intentionally NOT shown to players — no roster, no names, no text
// (skeuomorphic rule, docs/DESIGN.md). If we ever want players to sense who's in
// the circle, it'd be diegetic — small flames ringing the fire — never a list.

// ---------------------------------------------------------------------------
// Reconnecting screen — shown while auto-rejoining on refresh
// ---------------------------------------------------------------------------

/** Bare ember canvas shown while session reconnect is in progress. No text. */
function ReconnectingScreen() {
  const screenStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    background: "var(--bg)",
  };
  return (
    <div style={screenStyle}>
      <Ember size={200} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Join screen
// ---------------------------------------------------------------------------

interface JoinScreenProps {
  onJoined: (result: Extract<JoinResult, { ok: true }>) => void;
}

function JoinScreen({ onJoined }: JoinScreenProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = /^\d{6}$/.test(code) && name.trim().length > 0 && !busy;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    setError(null);
    setBusy(true);

    if (!socket.connected) socket.connect();

    socket.emit(
      "circle:join",
      { code, name: name.trim(), deviceId },
      (result: JoinResult) => {
        setBusy(false);
        if (result.ok) {
          haptics.vibrate([30, 40, 80]); // success buzz
          onJoined(result);
        } else {
          setError(result.error);
        }
      },
    );
  }, [canSubmit, code, name, onJoined]);

  // Submit on Enter in either field
  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit],
  );

  // --- styles ---
  const screenStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    padding: `${space(6)} ${space(5)}`,
    gap: space(5),
    background: "var(--bg)",
  };

  const headingStyle: CSSProperties = {
    fontSize: 13,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: palette.ash,
    userSelect: "none",
  };

  const formStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space(4),
    width: "100%",
    maxWidth: 280,
  };

  const inputStyle: CSSProperties = {
    background: "transparent",
    border: `1px solid ${palette.ash}`,
    borderRadius: "6px",
    color: palette.parchment,
    font: "inherit",
    fontSize: 16, // prevents iOS zoom on focus
    padding: `${space(3)} ${space(4)}`,
    width: "100%",
    textAlign: "center",
    letterSpacing: "0.06em",
    transition: "border-color 0.2s",
  };

  const codeInputStyle: CSSProperties = {
    ...inputStyle,
    fontSize: 28,
    letterSpacing: "0.25em",
    fontVariantNumeric: "tabular-nums",
  };

  const buttonStyle: CSSProperties = {
    background: canSubmit ? palette.emberDim : palette.ink,
    border: "none",
    borderRadius: "6px",
    color: canSubmit ? palette.parchment : palette.ash,
    cursor: canSubmit ? "pointer" : "default",
    font: "inherit",
    fontSize: 15,
    letterSpacing: "0.08em",
    padding: `${space(4)} ${space(5)}`,
    textTransform: "uppercase",
    transition: "background 0.2s, color 0.2s",
    width: "100%",
  };

  const errorStyle: CSSProperties = {
    color: palette.emberDim,
    fontSize: 13,
    textAlign: "center",
    minHeight: 20,
  };

  return (
    <div style={screenStyle}>
      {/* Faint ember at top */}
      <Ember size={120} />

      <span style={headingStyle}>enter the circle</span>

      <div style={formStyle}>
        <input
          aria-label="Circle code"
          autoComplete="off"
          inputMode="numeric"
          maxLength={6}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={handleKey}
          placeholder="000000"
          style={codeInputStyle}
          type="text"
          value={code}
        />

        <input
          aria-label="Your name"
          autoComplete="off"
          maxLength={40}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKey}
          placeholder="your name"
          style={inputStyle}
          type="text"
          value={name}
        />

        <button
          disabled={!canSubmit}
          onClick={handleSubmit}
          style={buttonStyle}
          type="button"
        >
          {busy ? "joining…" : "join"}
        </button>
      </div>

      <div aria-live="polite" role="status" style={errorStyle}>
        {error ?? ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Joined / in-the-circle screen
// ---------------------------------------------------------------------------

interface JoinedState {
  circleId: string;
  playerId: string;
  playerName: string;
  players: Player[];
}

interface JoinedScreenProps {
  state: JoinedState;
}

function JoinedScreen(_props: JoinedScreenProps) {
  // Skeuomorphic / diegetic rule (docs/DESIGN.md): the joined/resting state is
  // JUST the breathing ember on near-black — no name, no presence roster, no
  // text. The fire being lit IS the feedback that you're in the circle.
  // Presence is the GM's concern (players see each other at the table).
  const screenStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    background: "var(--bg)",
  };

  return (
    <div className="fade-in" style={screenStyle}>
      <Ember size={200} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root App
// ---------------------------------------------------------------------------

type AppState =
  | { screen: "join" }
  | { screen: "reconnecting" }
  | { screen: "joined"; joined: JoinedState };

function App() {
  // Initialise to "reconnecting" if a stored session exists, "join" otherwise.
  const [appState, setAppState] = useState<AppState>(() =>
    loadSession() !== null ? { screen: "reconnecting" } : { screen: "join" },
  );

  // ---------------------------------------------------------------------------
  // Parchment message queue — M1 effect:deliver handling
  // ---------------------------------------------------------------------------

  // Queue of MessageEffect instances waiting to be shown.
  const [messageQueue, setMessageQueue] = useState<MessageEffect[]>([]);
  // The currently-displayed effect (head of queue), null when nothing active.
  const [activeMessage, setActiveMessage] = useState<MessageEffect | null>(null);
  // Ref to avoid stale closures in the socket handler.
  const activeMessageRef = useRef<MessageEffect | null>(null);
  activeMessageRef.current = activeMessage;

  // Receive an incoming effect and enqueue or display immediately.
  const handleEffectDeliver = useCallback((effect: DeliveredEffect) => {
    // M1 only handles MessageEffect (kind === "message").
    // The discriminated union currently only has "message", but guard anyway.
    if (effect.kind !== "message") return;
    const msg = effect as MessageEffect;

    if (activeMessageRef.current === null) {
      // Nothing on screen — show immediately.
      setActiveMessage(msg);
    } else {
      // Queue behind whatever is currently displayed.
      setMessageQueue((q) => [...q, msg]);
    }
  }, []);

  // Called by ParchmentMessage when the current message fully exits.
  const handleMessageDone = useCallback(() => {
    setActiveMessage(null);
    setMessageQueue((q) => {
      const [next, ...rest] = q;
      if (next !== undefined) {
        // Promote head of queue in the next tick so the component unmounts
        // cleanly first.
        setTimeout(() => setActiveMessage(next), 0);
      }
      return rest;
    });
  }, []);

  // Listen for effect:deliver (always, not just when joined — the server won't
  // deliver to a socket that hasn't joined a circle, so this is safe).
  useEffect(() => {
    socket.on("effect:deliver", handleEffectDeliver);
    return () => {
      socket.off("effect:deliver", handleEffectDeliver);
    };
  }, [handleEffectDeliver]);

  // ---------------------------------------------------------------------------
  // Presence updates
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function onPresenceUpdate(update: PresenceUpdate) {
      setAppState((prev) => {
        if (prev.screen !== "joined") return prev;
        if (update.circleId !== prev.joined.circleId) return prev;
        return {
          ...prev,
          joined: { ...prev.joined, players: update.players },
        };
      });
    }

    socket.on("presence:update", onPresenceUpdate);
    return () => {
      socket.off("presence:update", onPresenceUpdate);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Auto-rejoin on mount when a stored session exists
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const session = loadSession();
    if (session === null) return; // no stored session — nothing to do

    // Already in "reconnecting" state (set by useState initialiser above).
    if (!socket.connected) socket.connect();

    socket.emit(
      "circle:join",
      { code: session.code, name: session.name, deviceId },
      (result: JoinResult) => {
        if (result.ok) {
          setAppState({
            screen: "joined",
            joined: {
              circleId: result.circle.id,
              playerId: result.player.id,
              playerName: result.player.name,
              players: [result.player],
            },
          });
        } else {
          clearSession();
          setAppState({ screen: "join" });
        }
      },
    );
    // Intentionally runs only once on mount — no deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleJoined = useCallback(
    (result: Extract<JoinResult, { ok: true }>) => {
      // Persist the session so a future refresh can auto-rejoin.
      saveSession({ code: result.circle.code, name: result.player.name });
      setAppState({
        screen: "joined",
        joined: {
          circleId: result.circle.id,
          playerId: result.player.id,
          playerName: result.player.name,
          players: [result.player],
        },
      });
    },
    [],
  );

  return (
    <>
      {appState.screen === "joined" ? (
        <JoinedScreen state={appState.joined} />
      ) : appState.screen === "reconnecting" ? (
        <ReconnectingScreen />
      ) : (
        <JoinScreen onJoined={handleJoined} />
      )}

      {/* Parchment overlay — rendered above everything, portalled via fixed positioning */}
      {activeMessage !== null && (
        <ParchmentMessage
          key={activeMessage.id}
          effect={activeMessage}
          onDone={handleMessageDone}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

injectGlobalStyles();

// Apply theme CSS vars to the root element
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

const vars = themeVars(playerTheme);
for (const [prop, value] of Object.entries(vars)) {
  rootEl.style.setProperty(prop, value);
}

rootEl.style.height = "100%";
rootEl.style.width = "100%";

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
