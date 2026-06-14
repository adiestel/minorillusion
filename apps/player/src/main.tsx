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
  FlashEffect,
} from "@minorillusion/contract";
import { playerTheme, themeVars, palette, space } from "@minorillusion/design-system";
import { ParchmentMessage } from "./ParchmentMessage";
import { AmbianceLayer } from "./AmbianceLayer";
import { Heartbeat } from "./Heartbeat";
import { Flash } from "./Flash";
import { Consent } from "./Consent";
import { AudioUnlockModal } from "./AudioUnlockModal";

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
  /** GM-set fade-in/out ms for the scene's audio bed (default ~5s in audio). */
  fadeMs?: number;
}

/** Transient heartbeat overlay (keyed by effect id; latest wins). */
interface HeartbeatState {
  id: string;
  bpm: number;
  beats: number;
}

/** Transient flash overlay (keyed by effect id; latest wins). */
interface FlashState {
  id: string;
  intensity?: number;
  durationMs?: number;
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
  // True while joined AND the audio context is suspended (needs a tap to wake).
  const [audioLocked, setAudioLocked] = useState(false);

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

  // --- persistent ambiance + transient heartbeat/flash ---
  const [ambiance, setAmbiance] = useState<AmbianceState>({ scene: "clear" });
  const [heartbeat, setHeartbeat] = useState<HeartbeatState | null>(null);
  const [flash, setFlash] = useState<FlashState | null>(null);

  // --- sustained-effect registry (M2 control rework) ---
  // effectId → cleanup. A sustained effect (a standalone audio loop, or an
  // ambiance scene) registers a cleanup here when it starts; effect:end looks the
  // id up, runs the cleanup, and forgets it. Loops store handle.stop; an ambiance
  // stores "set the scene back to clear" (the AmbianceLayer then unmounts, which
  // already stops its rain bed). A ref (not state) — purely imperative bookkeeping.
  const sustainedCleanups = useRef<Map<string, () => void>>(new Map());
  // The effect id of the ambiance scene currently showing (null when clear), so
  // effect:end can tell whether an id refers to the live ambiance.
  const ambianceEffectId = useRef<string | null>(null);

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

  /** Register a cleanup for a sustained effect, keyed by its delivered id. */
  const registerSustained = useCallback((id: string, cleanup: () => void) => {
    sustainedCleanups.current.set(id, cleanup);
  }, []);

  /** Clear the persistent ambiance back to "clear" and forget its tracking. */
  const clearAmbiance = useCallback(() => {
    setAmbiance({ scene: "clear" });
    const prevId = ambianceEffectId.current;
    if (prevId !== null) sustainedCleanups.current.delete(prevId);
    ambianceEffectId.current = null;
  }, []);

  /**
   * Set the persistent ambiance to a (non-clear) scene and track it as a
   * sustained effect: supersede any prior ambiance, remember this id, and
   * register a cleanup that sweeps back to clear (run by effect:end). A "clear"
   * scene just tears the current ambiance down via clearAmbiance.
   */
  const setActiveAmbiance = useCallback(
    (id: string, scene: AmbianceScene, intensity?: number, fadeMs?: number) => {
      if (scene === "clear") {
        clearAmbiance();
        return;
      }
      // A new scene supersedes the previous one (latest wins): drop the old id's
      // stale cleanup entry before registering this one.
      const prevId = ambianceEffectId.current;
      if (prevId !== null && prevId !== id) {
        sustainedCleanups.current.delete(prevId);
      }
      setAmbiance({ scene, intensity, fadeMs });
      ambianceEffectId.current = id;
      registerSustained(id, clearAmbiance);
    },
    [clearAmbiance, registerSustained],
  );

  /**
   * A spoken effect with spooky treatment: fade the dissonant-whispers bed in
   * over 2s, start the voice (with echo / L↔R pan) 2s later, then fade the bed
   * out 2s after the voice ends. A cleanup (run by effect:end if the GM stops it
   * early) cancels the pending voice and the bed.
   */
  const playSpookyVoice = useCallback(
    (
      id: string,
      data: string,
      o: { whispers: boolean; echo: boolean; pan: boolean; gain?: number; whisperGain?: number },
    ) => {
      const bed = o.whispers
        ? audio.playWhisperBed({ gain: o.whisperGain ?? 0.4, fadeInMs: 2000, fadeOutMs: 2000 })
        : null;
      const lead = o.whispers ? 2000 : 0;
      let voice: { stop: () => void } | null = null;
      const leadTimer = window.setTimeout(() => {
        voice = audio.playVoice(data, {
          gain: o.gain,
          echo: o.echo,
          pan: o.pan,
          onEnded: () => {
            bed?.stop(); // fade the bed out 2s after the voice finishes
            sustainedCleanups.current.delete(id);
          },
        });
      }, lead);
      registerSustained(id, () => {
        window.clearTimeout(leadTimer);
        voice?.stop();
        bed?.stop();
      });
    },
    [registerSustained],
  );

  // Receive an incoming effect and route by kind, each honouring startDelayMs.
  const handleEffectDeliver = useCallback(
    (effect: DeliveredEffect) => {
      switch (effect.kind) {
        case "message":
          scheduleEffect(effect.startDelayMs, () => enqueueMessage(effect));
          break;

        case "audio": {
          // A spoken effect with spooky treatment (whispers bed / echo / pan) is
          // orchestrated specially; everything else is plain playback.
          const isSpooky =
            effect.source.via === "data" &&
            (effect.whispers === true || effect.echo === true || effect.pan === true);
          scheduleEffect(effect.startDelayMs, () => {
            if (isSpooky && effect.source.via === "data") {
              playSpookyVoice(effect.id, effect.source.data, {
                whispers: effect.whispers === true,
                echo: effect.echo === true,
                pan: effect.pan === true,
                gain: effect.gain,
                whisperGain: effect.whisperGain,
              });
              return;
            }
            const handle = audio.play(effect.source, {
              gain: effect.gain,
              loop: effect.loop,
            });
            // A standalone loop is a sustained effect: register its stop under the
            // effect id so effect:end can halt it. (The storm's rain bed is owned
            // by the AmbianceLayer instead and isn't tracked here.) One-shots play
            // out and untrack themselves inside the audio capability.
            if (effect.loop === true) {
              registerSustained(effect.id, handle.stop);
            }
          });
          break;
        }

        case "haptic":
          scheduleEffect(effect.startDelayMs, () => {
            haptics.vibrate(HAPTIC_PATTERNS[effect.pattern]);
          });
          break;

        case "ambiance":
          // Persistent: set the scene; the AmbianceLayer swaps in place. A
          // non-clear scene is a sustained effect — remember its id and register
          // a cleanup that sweeps back to clear (so effect:end / "Calm" can end
          // it; the AmbianceLayer then unmounts and stops its own rain bed).
          scheduleEffect(effect.startDelayMs, () => {
            setActiveAmbiance(effect.id, effect.scene, effect.intensity, effect.fadeMs);
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

        case "flash":
          // Transient: a brief full-screen flash (latest wins, keyed by id). The
          // server paces storm strikes seconds apart (photosensitivity, D10).
          scheduleEffect(effect.startDelayMs, () => {
            setFlash({
              id: effect.id,
              intensity: effect.intensity,
              durationMs: effect.durationMs,
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
    [scheduleEffect, enqueueMessage, registerSustained, setActiveAmbiance, playSpookyVoice],
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

  // Self-removal when a flash finishes (the brief strike has faded out).
  const handleFlashDone = useCallback((id: string) => {
    // Latest-wins guard: only clear if this is still the showing flash, so a
    // newer strike that arrived mid-fade isn't yanked by the old one's onDone.
    setFlash((cur) => (cur !== null && cur.id === id ? null : cur));
  }, []);

  // Stop/clear a specific active effect on the server's say-so (M2 control
  // rework — drives the GM "Stop" / "Calm" buttons). Look the id up in the
  // sustained-cleanup registry; if found, run the cleanup and forget it. An
  // ambiance cleanup sweeps the scene back to clear (the AmbianceLayer then
  // unmounts and stops its own rain bed); a loop cleanup is its handle.stop.
  const handleEffectEnd = useCallback(({ effectId }: { effectId: string }) => {
    const cleanup = sustainedCleanups.current.get(effectId);
    if (cleanup === undefined) return;
    sustainedCleanups.current.delete(effectId);
    cleanup();
  }, []);

  // Listen for effect:deliver (always, not just when joined — the server won't
  // deliver to a socket that hasn't joined a circle, so this is safe).
  useEffect(() => {
    socket.on("effect:deliver", handleEffectDeliver);
    return () => {
      socket.off("effect:deliver", handleEffectDeliver);
    };
  }, [handleEffectDeliver]);

  // Listen for effect:end (stop a specific sustained loop/ambiance by id).
  useEffect(() => {
    socket.on("effect:end", handleEffectEnd);
    return () => {
      socket.off("effect:end", handleEffectEnd);
    };
  }, [handleEffectEnd]);

  // Apply the GM's master effects volume (live).
  useEffect(() => {
    function onMixer({ gain }: { gain: number }) {
      audio.setMasterGain(gain);
    }
    socket.on("mixer:apply", onMixer);
    return () => {
      socket.off("mixer:apply", onMixer);
    };
  }, []);

  // Clear any pending startDelayMs timers AND run any sustained cleanups
  // (standalone audio loops) on unmount, so nothing keeps playing into a
  // torn-down tree. (Ambiance cleanups are cheap setState no-ops at unmount.)
  useEffect(() => {
    const timers = delayTimers.current;
    const cleanups = sustainedCleanups.current;
    return () => {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      for (const cleanup of cleanups.values()) cleanup();
      cleanups.clear();
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
  // Watch the audio lock-state while joined, so we can prompt for a tap only
  // when sound is actually blocked (a suspended context — autoplay policy, the
  // browser idling it, or returning from the background). Clear when not joined.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (appState.screen !== "joined") {
      setAudioLocked(false);
      return;
    }
    return audio.onLockChange(setAudioLocked);
  }, [appState.screen]);

  // ---------------------------------------------------------------------------
  // The GM removed this player: clear the session and return to the join screen
  // (don't auto-rejoin — re-entering requires the code again).
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function onEjected() {
      clearSession();
      setAppState({ screen: "join" });
    }
    socket.on("circle:ejected", onEjected);
    return () => {
      socket.off("circle:ejected", onEjected);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Report this device's viewport (size + shape) while joined, so the GM's
  // Stage can render each tile at the device's true aspect ratio. Fires on
  // join, on resize, and on orientation change (debounced). Output-only and
  // privacy-safe: it's just the window dimensions, never screen content.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (appState.screen !== "joined") return;
    let timer: number | undefined;
    const report = () => {
      const width = Math.round(window.innerWidth);
      const height = Math.round(window.innerHeight);
      if (width > 0 && height > 0) socket.emit("player:viewport", { width, height });
    };
    const onResize = () => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(report, 250);
    };
    report(); // initial report on (re)join
    // A second pass once layout settles (mobile URL bar / late reflow) so the
    // GM gets the final size, not a transient one.
    const settle = window.setTimeout(report, 600);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", report);
    // (Re-reporting after a socket reconnect is handled by the rejoin flow, once
    // the server binding is re-established — see the reconnect effect below.)
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
      window.clearTimeout(settle);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", report);
    };
  }, [appState.screen]);

  // ---------------------------------------------------------------------------
  // Rejoin from the stored session on every (re)connect.
  //
  // Covers first load with a saved session AND any later socket reconnect
  // (server restart / network blip). Without re-joining on reconnect, the fresh
  // socket has no server binding, so the GM sees the circle as empty ("only one
  // here") and the player's reported viewport is lost. Reconnect was already
  // consented (D10: don't re-prompt); a first touch primes iOS audio.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (loadSession() === null) return; // no stored session — nothing to restore

    // First user touch primes iOS audio (reconnect path has no consent tap).
    const unlockOnce = () => audio.unlock();
    document.addEventListener("pointerdown", unlockOnce, { once: true });

    const rejoin = () => {
      const session = loadSession();
      if (session === null) return;
      socket.emit(
        "circle:join",
        { code: session.code, name: session.name, deviceId },
        (result: JoinResult) => {
          if (result.ok) {
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
            // Re-report the viewport now that the binding is re-established, so
            // the GM Stage keeps the right size across reconnects.
            const w = Math.round(window.innerWidth);
            const h = Math.round(window.innerHeight);
            if (w > 0 && h > 0) socket.emit("player:viewport", { width: w, height: h });
          } else {
            clearSession();
            setAppState({ screen: "join" });
          }
        },
      );
    };

    // Rejoin now if already connected, and on every (re)connect thereafter.
    if (socket.connected) rejoin();
    else socket.connect();
    socket.on("connect", rejoin);

    return () => {
      document.removeEventListener("pointerdown", unlockOnce);
      socket.off("connect", rejoin);
    };
    // Runs once on mount; the listener handles all later reconnects.
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
      <AmbianceLayer scene={ambiance.scene} intensity={ambiance.intensity} fadeMs={ambiance.fadeMs} />

      {/* Transient heartbeat overlay — above ambiance/ember, below parchment. */}
      {heartbeat !== null && (
        <Heartbeat
          key={heartbeat.id}
          bpm={heartbeat.bpm}
          beats={heartbeat.beats}
          onDone={handleHeartbeatDone}
        />
      )}

      {/* Transient flash (storm lightning etc.) — above ambiance/ember/heartbeat,
          below the parchment scrim. Keyed by id so a new strike replaces an
          in-flight one cleanly (latest-wins; one brief flash each, D10). */}
      {flash !== null && (
        <Flash
          key={flash.id}
          intensity={flash.intensity}
          durationMs={flash.durationMs}
          onDone={() => handleFlashDone(flash.id)}
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

      {/* Audio-unlock prompt — only while joined AND the context is suspended.
          Sits above all else (z 100); a tap wakes the sound and clears it. */}
      {audioLocked && <AudioUnlockModal />}
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
