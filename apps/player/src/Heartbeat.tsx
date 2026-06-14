/**
 * Heartbeat — a transient blood-pulse overlay.
 *
 * A deep-red radial vignette that lives at the screen edges and pulses inward
 * once per beat, synced to `bpm`, for `beats` beats, then unmounts (via onDone).
 * Each beat also fires the heartbeat haptic. Atmospheric, not gory — a felt
 * pulse, low opacity, no blood imagery. Cheap DOM/CSS (DECISIONS D7/D13).
 *
 * Sits above the ambiance + ember but below the parchment overlay (z-index 40).
 * Latest-wins: main.tsx keys it by effect id, so a new heartbeat replaces any
 * in-flight one rather than stacking.
 */

import { useEffect, useRef, CSSProperties } from "react";
import { audio, haptics } from "./capabilities/index";
import { HAPTIC_PATTERNS } from "./hapticPatterns";

const STYLE_ID = "mi-heartbeat-styles";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // One pulse: the edge vignette swells inward and brightens, then recedes.
  // Kept well under a beat at any sane bpm so beats read as discrete throbs.
  style.textContent = `
    @keyframes mi-heartbeat-pulse {
      0%   { opacity: 0;    transform: scale(1.06); }
      18%  { opacity: 0.85; transform: scale(1);    }
      45%  { opacity: 0;    transform: scale(1.06); }
      100% { opacity: 0;    transform: scale(1.06); }
    }
    .mi-heartbeat {
      position: fixed; inset: 0; z-index: 40;
      pointer-events: none;
      /* deep red, only at the edges — center stays clear */
      background: radial-gradient(
        ellipse at center,
        transparent 38%,
        rgba(120, 12, 12, 0.28) 78%,
        rgba(90, 6, 6, 0.55) 100%
      );
      opacity: 0;
      will-change: opacity, transform;
    }
    .mi-heartbeat.is-beating {
      animation-name: mi-heartbeat-pulse;
      animation-timing-function: ease-out;
      animation-iteration-count: 1;
    }
  `;
  document.head.appendChild(style);
}

export interface HeartbeatProps {
  bpm: number;
  beats: number;
  onDone: () => void;
}

export function Heartbeat({ bpm, beats, onDone }: HeartbeatProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  // Guard onDone against StrictMode double-invoke / re-fires.
  const doneRef = useRef(false);

  useEffect(() => {
    injectStyles();

    const safeBpm = Math.min(200, Math.max(30, bpm));
    const safeBeats = Math.min(64, Math.max(1, Math.round(beats)));
    const intervalMs = 60_000 / safeBpm;

    const el = layerRef.current;
    let count = 0;
    const timers: number[] = [];

    const beat = () => {
      count += 1;

      // Re-trigger the CSS pulse: clear, force reflow, re-add.
      if (el !== null) {
        el.classList.remove("is-beating");
        // reading offsetWidth forces a reflow so the animation restarts
        void el.offsetWidth;
        el.classList.add("is-beating");
      }

      haptics.vibrate(HAPTIC_PATTERNS.heartbeat);
      // A single lub-dub thump per beat, synced with the pulse + haptic so bpm
      // drives sight, touch, and sound together.
      audio.play({ via: "cue", cue: "heartbeat" }, { gain: 0.9 });

      if (count >= safeBeats) {
        // Let the final pulse breathe out before unmounting.
        const tail = window.setTimeout(() => {
          if (doneRef.current) return;
          doneRef.current = true;
          onDone();
        }, intervalMs);
        timers.push(tail);
        return;
      }
      const next = window.setTimeout(beat, intervalMs);
      timers.push(next);
    };

    // First beat immediately so the effect lands on receipt.
    beat();

    return () => {
      for (const t of timers) window.clearTimeout(t);
    };
    // bpm/beats are fixed per mounted instance (keyed by effect id in main.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const style: CSSProperties = { contain: "strict" };
  return <div ref={layerRef} className="mi-heartbeat" style={style} aria-hidden="true" />;
}
