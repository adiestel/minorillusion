/**
 * Mirror mode — the player canvas rendered as a SILENT, read-only view, for the
 * GM's Stage. It mounts the SAME visual components the real player uses
 * (AmbianceLayer, Flash, Heartbeat, ParchmentMessage, the breathing ember), so
 * the Stage tile is a true pixel mirror of the PWA — not a lookalike.
 *
 * It is driven entirely by window.postMessage from the embedding GM page (never
 * a socket — autoConnect is off and we never call connect()), and audio/haptics
 * are stubbed to no-ops so embedding N mirrors makes no sound on the GM machine.
 *
 * Protocol (GM → iframe):
 *   { type: "mi-scene", scene, intensity?, fadeMs? }  → set the ambiance
 *   { type: "mi-effect", effect }                      → a transient (flash /
 *                                                        heartbeat / message)
 *   { type: "mi-clear" }                               → reset to resting
 * Handshake (iframe → GM): { type: "mi-ready" } once the listener is live.
 *
 * Served at /mirror.html (dev) — a sibling entry to index.html.
 */
import {
  StrictMode,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import type {
  AmbianceScene,
  DeliveredEffect,
  MessageEffect,
} from "@minorillusion/contract";
import { palette, playerTheme, themeVars } from "@minorillusion/design-system";
import { AmbianceLayer } from "./AmbianceLayer";
import { Heartbeat } from "./Heartbeat";
import { Flash } from "./Flash";
import { ParchmentMessage } from "./ParchmentMessage";
import { audio, haptics } from "./capabilities/index";

// A mirror makes no sound and never vibrates — neutralise the capabilities so
// the real components (which call them) are silent here.
audio.play = () => ({ stop: () => {}, setGain: () => {} });
audio.playWhisperBed = () => ({ stop: () => {}, setGain: () => {} });
audio.stopAll = () => {};
audio.unlock = () => {};
audio.locked = () => false;
audio.onLockChange = () => () => {};
haptics.vibrate = () => {};

// ---------------------------------------------------------------------------
// Global styles (the resting ember + reset) — the components inject their own.
// ---------------------------------------------------------------------------

const base = document.createElement("style");
base.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; width: 100%; overflow: hidden; background: ${palette.nearBlack}; }
  body { font-family: var(--font); color: var(--text); -webkit-font-smoothing: antialiased; }
  @keyframes ember-breathe {
    0%, 100% { opacity: 0.18; transform: scale(1); }
    50%      { opacity: 0.38; transform: scale(1.12); }
  }
  .ember-glow { animation: ember-breathe 3.6s ease-in-out infinite; }
  @keyframes fade-in { from { opacity: 0 } to { opacity: 1 } }
  .fade-in { animation: fade-in 1.2s ease-out forwards; }
`;
document.head.appendChild(base);
for (const [prop, value] of Object.entries(themeVars(playerTheme))) {
  document.documentElement.style.setProperty(prop, value);
}

// ---------------------------------------------------------------------------
// Messages from the embedding GM page
// ---------------------------------------------------------------------------

type MirrorMessage =
  | { type: "mi-scene"; scene: AmbianceScene; intensity?: number; fadeMs?: number }
  | { type: "mi-effect"; effect: DeliveredEffect }
  | { type: "mi-ack"; effectId: string }
  | { type: "mi-clear" };

interface SceneState {
  scene: AmbianceScene;
  intensity?: number;
  fadeMs?: number;
}
interface FlashState {
  id: string;
  intensity?: number;
  durationMs?: number;
}
interface HeartbeatState {
  id: string;
  bpm: number;
  beats: number;
}

function Ember() {
  const style: CSSProperties = {
    width: 200,
    height: 200,
    borderRadius: "50%",
    background: `radial-gradient(circle, ${palette.ember}66 0%, ${palette.emberDim}33 45%, transparent 70%)`,
  };
  return <div className="ember-glow" style={style} aria-hidden="true" />;
}

function MirrorApp() {
  const [ambiance, setAmbiance] = useState<SceneState>({ scene: "clear" });
  const [flash, setFlash] = useState<FlashState | null>(null);
  const [heartbeat, setHeartbeat] = useState<HeartbeatState | null>(null);
  const [message, setMessage] = useState<MessageEffect | null>(null);

  // Latest scene in a ref so we don't depend on it in the message effect.
  const sceneRef = useRef<AmbianceScene>("clear");
  sceneRef.current = ambiance.scene;

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      const data = ev.data as MirrorMessage | undefined;
      if (!data || typeof data !== "object" || !("type" in data)) return;

      if (data.type === "mi-scene") {
        setAmbiance({ scene: data.scene, intensity: data.intensity, fadeMs: data.fadeMs });
        return;
      }
      if (data.type === "mi-clear") {
        setAmbiance({ scene: "clear" });
        setFlash(null);
        setHeartbeat(null);
        setMessage(null);
        return;
      }
      if (data.type === "mi-ack") {
        // The real player dismissed this message — clear it here too (the mirror
        // can't be tapped, so acknowledge messages would otherwise linger).
        setMessage((cur) => (cur && cur.id === data.effectId ? null : cur));
        return;
      }
      if (data.type === "mi-effect") {
        const effect = data.effect;
        switch (effect.kind) {
          case "flash":
            setFlash({ id: effect.id, intensity: effect.intensity, durationMs: effect.durationMs });
            break;
          case "heartbeat":
            setHeartbeat({ id: effect.id, bpm: effect.bpm, beats: effect.beats });
            break;
          case "message":
            setMessage(effect);
            break;
          // ambiance arrives via mi-scene; audio/haptic have no player visual.
          default:
            break;
        }
      }
    }

    window.addEventListener("message", onMessage);
    // Tell the embedding GM page we're live so it can send the current scene.
    window.parent?.postMessage({ type: "mi-ready" }, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <>
      {/* The resting ember canvas (z 1), same as the joined player. */}
      <div
        className="fade-in"
        style={{
          position: "relative",
          zIndex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          background: "transparent",
        }}
      >
        <Ember />
      </div>

      <AmbianceLayer scene={ambiance.scene} intensity={ambiance.intensity} fadeMs={ambiance.fadeMs} />

      {heartbeat !== null && (
        <Heartbeat
          key={heartbeat.id}
          bpm={heartbeat.bpm}
          beats={heartbeat.beats}
          onDone={() => setHeartbeat(null)}
        />
      )}

      {flash !== null && (
        <Flash
          key={flash.id}
          intensity={flash.intensity}
          durationMs={flash.durationMs}
          onDone={() => setFlash(null)}
        />
      )}

      {message !== null && (
        <ParchmentMessage key={message.id} effect={message} onDone={() => setMessage(null)} />
      )}
    </>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
rootEl.style.height = "100%";
rootEl.style.width = "100%";
createRoot(rootEl).render(
  <StrictMode>
    <MirrorApp />
  </StrictMode>,
);
