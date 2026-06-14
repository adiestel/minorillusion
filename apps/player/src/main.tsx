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

import type {
  JoinResult,
  PresenceUpdate,
  Player,
  DeliveredEffect,
  MessageEffect,
  AmbianceScene,
} from "@minorillusion/contract";
import { playerTheme, themeVars, palette, space } from "@minorillusion/design-system";
import { ParchmentMessage } from "./ParchmentMessage";
import { AmbianceLayer } from "./AmbianceLayer";
import { Heartbeat } from "./Heartbeat";
import { Consent } from "./Consent";

import { socket } from "./socket";
import { deviceId } from "./deviceId";
import { haptics, audio } from "./capabilities/index";
import { HAPTIC_PATTERNS } from "./hapticPatterns";
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
    position: "relative",
    zIndex: 1,
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
  /**
   * Called with a valid (code, name) on submit. Does NOT join yet — the App
   * shows the consent disclosure first (D10), and only its primary button
   * performs the actual circle:join + audio unlock.
   */
  onProceed: (code: string, name: string) => void;
  /** Surface a join error returned after consent (e.g. bad code). */
  error?: string | null;
  /** True while a post-consent join is in flight. */
  busy?: boolean;
}

function JoinScreen({ onProceed, error = null, busy = false }: JoinScreenProps) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");

  const canSubmit = /^\d{6}$/.test(code) && name.trim().length > 0 && !busy;

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    onProceed(code, name.trim());
  }, [canSubmit, code, name, onProceed]);

  // Submit on Enter in either field
  const handleKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") handleSubmit();
    },
    [handleSubmit],
  );

  // --- styles ---
  const screenStyle: CSSProperties = {
    position: "relative",
    zIndex: 1,
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
  // JUST the breathing ember — no name, no presence roster, no text. The fire
  // being lit IS the feedback that you're in the circle.
  //
  // Background is transparent (NOT var(--bg)) so the persistent AmbianceLayer
  // behind it shows through; the body's near-black is the resting base. The
  // canvas is positioned at z-index 1 so the ember sits above the ambiance
  // layer (z-index 0).
  const screenStyle: CSSProperties = {
    position: "relative",
    zIndex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    background: "transparent",
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
  // Consent disclosure for a fresh manual join, holding the pending creds.
  | { screen: "consent"; pending: { code: string; name: string } }
  | { screen: "reconnecting" }
  | { screen: "joined"; joined: JoinedState };

/** Persistent ambiance background state (latest scene wins; stays until changed). */
interface AmbianceState {
  scene: AmbianceScene;
  intensity?: number;
}

/** Transient heartbeat overlay (keyed by effect id; latest wins). */
interface HeartbeatState {
  id: string;
  bpm: number;
  beats: number;
}

function App() {
  // Initialise to "reconnecting" if a stored session exists, "join" otherwise.
  const [appState, setAppState] = useState<AppState>(() =>
    loadSession() !== null ? { screen: "reconnecting" } : { screen: "join" },
  );
  // A join error surfaced after consent (shown back on the join screen).
  const [joinError, setJoinError] = useState<string | null>(null);
  // True while a post-consent join round-trips.
  const [joining, setJoining] = useState(false);

  // ---------------------------------------------------------------------------
  // Effect dispatcher — effect:deliver routed by effect.kind.
  //
  // Every effect respects startDelayMs: the action is scheduled with
  // setTimeout(..., startDelayMs ?? 0) and the timer is tracked so it's cleared
  // on unmount (no firing into a torn-down tree). The "message" path is the
  // unchanged M1 parchment queue; the new kinds drive audio/haptics/ambiance/
  // heartbeat below.
  // ---------------------------------------------------------------------------

  // --- parchment message queue (M1; behaviour unchanged) ---
  const [messageQueue, setMessageQueue] = useState<MessageEffect[]>([]);
  const [activeMessage, setActiveMessage] = useState<MessageEffect | null>(null);
  const activeMessageRef = useRef<MessageEffect | null>(null);
  activeMessageRef.current = activeMessage;

  // --- persistent ambiance + transient heartbeat ---
  const [ambiance, setAmbiance] = useState<AmbianceState>({ scene: "clear" });
  const [heartbeat, setHeartbeat] = useState<HeartbeatState | null>(null);

  // Outstanding startDelayMs timers, cleared on unmount.
  const delayTimers = useRef<Set<number>>(new Set());

  /** Run an action after effect.startDelayMs, tracking the timer for cleanup. */
  const scheduleEffect = useCallback((delayMs: number | undefined, run: () => void) => {
    const id = window.setTimeout(() => {
      delayTimers.current.delete(id);
      run();
    }, delayMs ?? 0);
    delayTimers.current.add(id);
  }, []);

  // Enqueue a parchment message (immediate display, or behind the active one).
  const enqueueMessage = useCallback((msg: MessageEffect) => {
    if (activeMessageRef.current === null) {
      setActiveMessage(msg);
    } else {
      setMessageQueue((q) => [...q, msg]);
    }
  }, []);

  // Receive an incoming effect and route by kind, each honouring startDelayMs.
  const handleEffectDeliver = useCallback(
    (effect: DeliveredEffect) => {
      switch (effect.kind) {
        case "message":
          scheduleEffect(effect.startDelayMs, () => enqueueMessage(effect));
          break;

        case "audio":
          // One-shots play out and untrack themselves; loops are owned by the
          // ambiance layer, so we keep no handle here.
          scheduleEffect(effect.startDelayMs, () => {
            audio.play(effect.source, { gain: effect.gain, loop: effect.loop });
          });
          break;

        case "haptic":
          scheduleEffect(effect.startDelayMs, () => {
            haptics.vibrate(HAPTIC_PATTERNS[effect.pattern]);
          });
          break;

        case "ambiance":
          // Persistent: set the scene; the AmbianceLayer swaps in place.
          scheduleEffect(effect.startDelayMs, () => {
            setAmbiance({ scene: effect.scene, intensity: effect.intensity });
          });
          break;

        case "heartbeat":
          // Transient: mount (latest wins, keyed by effect id).
          scheduleEffect(effect.startDelayMs, () => {
            setHeartbeat({
              id: effect.id,
              bpm: effect.bpm,
              beats: effect.beats,
            });
          });
          break;

        default: {
          // Exhaustiveness guard — a new kind should fail to typecheck here.
          const _never: never = effect;
          void _never;
        }
      }
    },
    [scheduleEffect, enqueueMessage],
  );

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

  // Self-removal when a heartbeat finishes its beats.
  const handleHeartbeatDone = useCallback(() => {
    setHeartbeat(null);
  }, []);

  // Listen for effect:deliver (always, not just when joined — the server won't
  // deliver to a socket that hasn't joined a circle, so this is safe).
  useEffect(() => {
    socket.on("effect:deliver", handleEffectDeliver);
    return () => {
      socket.off("effect:deliver", handleEffectDeliver);
    };
  }, [handleEffectDeliver]);

  // Clear any pending startDelayMs timers on unmount.
  useEffect(() => {
    const timers = delayTimers.current;
    return () => {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
    };
  }, []);

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
  //
  // Reconnect already consented (D10: don't re-prompt). It has no explicit tap,
  // so audio can't be unlocked yet — we attach a one-shot pointerdown on the
  // document to prime audio on the player's first touch after reconnect.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const session = loadSession();
    if (session === null) return; // no stored session — nothing to do

    // First user touch primes iOS audio (reconnect path has no consent tap).
    const unlockOnce = () => audio.unlock();
    document.addEventListener("pointerdown", unlockOnce, { once: true });

    // Already in "reconnecting" state (set by useState initialiser above).
    if (!socket.connected) socket.connect();

    socket.emit(
      "circle:join",
      { code: session.code, name: session.name, deviceId },
      (result: JoinResult) => {
        if (result.ok) {
          // Keep the consent flag intact across reconnects.
          saveSession({
            code: result.circle.code,
            name: result.player.name,
            consented: true,
          });
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

    return () => {
      document.removeEventListener("pointerdown", unlockOnce);
    };
    // Intentionally runs only once on mount — no deps needed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // JoinScreen submit: hold the creds and show the consent disclosure (D10).
  // We do NOT join here — only the consent primary button joins.
  const handleProceed = useCallback((code: string, name: string) => {
    setJoinError(null);
    setAppState({ screen: "consent", pending: { code, name } });
  }, []);

  const handleConsentDecline = useCallback(() => {
    setAppState({ screen: "join" });
  }, []);

  // Consent primary button — the user gesture. (1) unlock audio, then
  // (2) emit circle:join. On success, persist the session WITH the consent flag
  // so reconnect won't re-prompt.
  const handleConsentAccept = useCallback(() => {
    if (appState.screen !== "consent") return;
    const { code, name } = appState.pending;

    // (1) user-gesture audio unlock (must happen inside this handler for iOS).
    audio.unlock();

    // (2) join.
    setJoining(true);
    if (!socket.connected) socket.connect();

    socket.emit(
      "circle:join",
      { code, name, deviceId },
      (result: JoinResult) => {
        setJoining(false);
        if (result.ok) {
          haptics.vibrate(HAPTIC_PATTERNS.success);
          saveSession({
            code: result.circle.code,
            name: result.player.name,
            consented: true,
          });
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
          // Surface the error back on the join screen.
          setJoinError(result.error);
          setAppState({ screen: "join" });
        }
      },
    );
  }, [appState]);

  return (
    <>
      {appState.screen === "joined" ? (
        <JoinedScreen state={appState.joined} />
      ) : appState.screen === "reconnecting" ? (
        <ReconnectingScreen />
      ) : appState.screen === "consent" ? (
        <Consent
          onAccept={handleConsentAccept}
          onDecline={handleConsentDecline}
          busy={joining}
        />
      ) : (
        <JoinScreen onProceed={handleProceed} error={joinError} busy={joining} />
      )}

      {/* Persistent ambiance — BEHIND all content (z-index 0). */}
      <AmbianceLayer scene={ambiance.scene} intensity={ambiance.intensity} />

      {/* Transient heartbeat overlay — above ambiance/ember, below parchment. */}
      {heartbeat !== null && (
        <Heartbeat
          key={heartbeat.id}
          bpm={heartbeat.bpm}
          beats={heartbeat.beats}
          onDone={handleHeartbeatDone}
        />
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

// Apply theme CSS vars at :root (documentElement), not #root. A var set only on
// #root never reaches the `body { font-family: var(--font) }` rule — custom
// properties inherit downward, and body is #root's parent — so the UI silently
// fell back to serif. Setting them on :root makes --font/--text/--bg inherit to
// body and the whole tree.
const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root element not found");

const vars = themeVars(playerTheme);
for (const [prop, value] of Object.entries(vars)) {
  document.documentElement.style.setProperty(prop, value);
}

rootEl.style.height = "100%";
rootEl.style.width = "100%";

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
