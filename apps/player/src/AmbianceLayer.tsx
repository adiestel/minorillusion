/**
 * AmbianceLayer — the persistent atmospheric background.
 *
 * Sits BEHIND all content (z-index 0; the ember sits above it, the parchment
 * scrim far above). An ambiance effect stays until the GM changes the scene, so
 * this is driven by a single { scene, intensity } state in main.tsx; swapping
 * scene replaces the previous one.
 *
 * Scenes:
 *   • clear — render nothing (resting near-black + ember show through), and stop
 *             any audio loop on entry (ends a lingering rain bed).
 *   • storm — dark blue-grey vignette wash + JS-timed lightning (brief flashes,
 *             randomized 4–9s apart, sometimes a double-strike) + a rain audio
 *             bed + faint CSS rain streaks. NOT a strobe (photosensitivity, D10).
 *   • ember — a warm amber glow wash (embers "stirred"); subtle, not a fire.
 *
 * All DOM/CSS — the cheap path (DECISIONS D7/D13; no WebGL). Sub-components are
 * split out so each can be refined independently later.
 */

import { useEffect, useRef, useState, CSSProperties } from "react";
import type { AmbianceScene } from "@minorillusion/contract";
import { audio, type AudioHandle } from "./capabilities/index";

const STYLE_ID = "mi-ambiance-styles";

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .mi-ambiance {
      position: fixed; inset: 0; z-index: 0;
      pointer-events: none;
      overflow: hidden;
    }

    /* --- storm --- */
    .mi-storm-wash {
      position: absolute; inset: 0;
      /* a cold blue-grey vignette that keeps the near-black mood */
      background:
        radial-gradient(ellipse at 50% 38%,
          rgba(38, 50, 74, 0.55) 0%,
          rgba(16, 22, 34, 0.7) 55%,
          rgba(6, 8, 12, 0.92) 100%);
    }
    .mi-storm-flash {
      position: absolute; inset: 0;
      background: linear-gradient(
        to bottom,
        rgba(228, 238, 255, 0.95),
        rgba(150, 180, 230, 0.7)
      );
      opacity: 0;
      will-change: opacity;
    }
    /* a single brief strike: up fast, down slower; ~360ms total */
    @keyframes mi-strike {
      0%   { opacity: 0; }
      8%   { opacity: 0.9; }
      22%  { opacity: 0.32; }
      30%  { opacity: 0.7; }
      100% { opacity: 0; }
    }
    .mi-storm-flash.is-strike { animation: mi-strike 360ms ease-out 1; }

    /* faint, slow-drifting rain streaks — cheap repeating-gradient, no JS */
    .mi-storm-rain {
      position: absolute; inset: -20% 0;
      background-image: repeating-linear-gradient(
        100deg,
        transparent 0px,
        transparent 7px,
        rgba(180, 200, 230, 0.06) 7px,
        rgba(180, 200, 230, 0.06) 8px
      );
      background-size: auto 140px;
      animation: mi-rain-fall 0.7s linear infinite;
      opacity: 0.5;
    }
    @keyframes mi-rain-fall {
      from { background-position: 0 0; }
      to   { background-position: -26px 140px; }
    }

    /* --- ember --- */
    .mi-ember-wash {
      position: absolute; inset: 0;
      background:
        radial-gradient(ellipse at 50% 62%,
          rgba(120, 52, 18, 0.5) 0%,
          rgba(70, 28, 10, 0.32) 45%,
          transparent 72%);
      animation: mi-ember-stir 6.5s ease-in-out infinite;
      will-change: opacity;
    }
    @keyframes mi-ember-stir {
      0%, 100% { opacity: 0.7; }
      50%      { opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Storm — vignette + JS-timed lightning + rain bed.
// ---------------------------------------------------------------------------

/** A bright flash is added by toggling .is-strike on the flash div, JS-timed. */
function StormLayer({ intensity }: { intensity: number }) {
  const flashRef = useRef<HTMLDivElement | null>(null);

  // Lightning: randomized, infrequent, brief — never a fast repetitive strobe.
  useEffect(() => {
    const timers: number[] = [];
    let stopped = false;

    const fireStrike = () => {
      const el = flashRef.current;
      if (el === null) return;
      el.classList.remove("is-strike");
      void el.offsetWidth; // reflow → restart animation
      el.classList.add("is-strike");
    };

    const scheduleNext = () => {
      if (stopped) return;
      // 4–9s between lightning events (randomized so it never feels mechanical).
      const delay = 4000 + Math.random() * 5000;
      const t = window.setTimeout(() => {
        fireStrike();
        // ~35% of the time, a quick second strike ~180–320ms later.
        if (Math.random() < 0.35) {
          const dbl = window.setTimeout(fireStrike, 180 + Math.random() * 140);
          timers.push(dbl);
        }
        scheduleNext();
      }, delay);
      timers.push(t);
    };

    scheduleNext();
    return () => {
      stopped = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, []);

  // Rain audio bed — owned here: starts on mount, stops on unmount.
  useEffect(() => {
    const handle: AudioHandle = audio.play(
      { via: "cue", cue: "rain" },
      { loop: true, gain: 0.6 },
    );
    return () => handle.stop();
  }, []);

  // intensity nudges the vignette/rain opacity a little; brightness of strikes
  // is left fixed (photosensitivity — don't let a high intensity ramp flashes).
  const washStyle: CSSProperties = {
    opacity: 0.85 + 0.15 * clamp01(intensity),
  };
  const rainStyle: CSSProperties = {
    opacity: 0.35 + 0.3 * clamp01(intensity),
  };

  return (
    <>
      <div className="mi-storm-wash" style={washStyle} />
      <div className="mi-storm-rain" style={rainStyle} />
      <div ref={flashRef} className="mi-storm-flash" />
    </>
  );
}

// ---------------------------------------------------------------------------
// Ember — warm amber glow wash.
// ---------------------------------------------------------------------------

function EmberLayer({ intensity }: { intensity: number }) {
  const style: CSSProperties = { opacity: 0.6 + 0.4 * clamp01(intensity) };
  return <div className="mi-ember-wash" style={style} />;
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 1;
  return Math.min(1, Math.max(0, n));
}

export interface AmbianceLayerProps {
  scene: AmbianceScene;
  intensity?: number;
}

export function AmbianceLayer({ scene, intensity = 1 }: AmbianceLayerProps) {
  // Ensure keyframes/classes exist before first paint of any scene.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    injectStyles();
    setReady(true);
  }, []);

  // Entering "clear" sweeps any audio loop (the rain bed) — belt-and-braces with
  // StormLayer's own unmount stop, in case scene flips clear before unmount runs.
  useEffect(() => {
    if (scene === "clear") audio.stopAll();
  }, [scene]);

  if (!ready) return null;

  if (scene === "clear") {
    // Nothing to render — resting near-black + the ember show through.
    return null;
  }

  return (
    <div className="mi-ambiance" aria-hidden="true">
      {scene === "storm" && <StormLayer intensity={intensity} />}
      {scene === "ember" && <EmberLayer intensity={intensity} />}
    </div>
  );
}
