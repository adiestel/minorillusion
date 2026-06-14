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
 *   • storm — dark blue-grey vignette wash + a rain audio bed + faint CSS rain
 *             streaks. Lightning is NO LONGER self-generated here: the server
 *             paces it as `flash` effects (rendered by <Flash> in main.tsx) on
 *             top of the ambiance, so strikes stay seconds apart (photosensitivity,
 *             D10) and the GM controls them.
 *   • rain  — the rain bed + streaks WITHOUT the cold storm vignette or lightning:
 *             rain at the hearth (the warm ember still glows through). storm and
 *             rain are mutually exclusive (one ambiance per target), so switching
 *             between them crossfades the bed via the loop fades rather than
 *             stacking two rain beds.
 *   • ember — a warm amber glow wash (embers "stirred"); subtle, not a fire.
 *
 * All DOM/CSS — the cheap path (DECISIONS D7/D13; no WebGL). Sub-components are
 * split out so each can be refined independently later.
 */

import { useEffect, useState, CSSProperties } from "react";
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
// Storm — vignette + rain streaks + rain bed.
//
// Lightning is NOT generated here anymore: the server drives it as `flash`
// effects (rendered by <Flash> in main.tsx) layered on top, so strikes are paced
// seconds apart and the GM controls them. This layer is the steady backdrop.
// ---------------------------------------------------------------------------

/**
 * The rain audio bed — started on mount, stopped on unmount, both fading over
 * `fadeMs` (GM-controllable; audio defaults to ~5s when undefined). The fade lets
 * a storm⇄rain switch crossfade rather than cut.
 */
function useRainBed(gain: number, fadeMs?: number): void {
  useEffect(() => {
    const handle: AudioHandle = audio.play(
      { via: "cue", cue: "rain" },
      { loop: true, gain, fadeInMs: fadeMs, fadeOutMs: fadeMs },
    );
    return () => handle.stop();
  }, [gain, fadeMs]);
}

function StormLayer({ intensity, fadeMs }: { intensity: number; fadeMs?: number }) {
  useRainBed(0.45, fadeMs);

  // intensity nudges the vignette/rain opacity a little.
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
    </>
  );
}

/** Rain without the storm: the bed + streaks, no cold vignette, no lightning. */
function RainLayer({ intensity, fadeMs }: { intensity: number; fadeMs?: number }) {
  useRainBed(0.45, fadeMs);
  const rainStyle: CSSProperties = {
    opacity: 0.3 + 0.3 * clamp01(intensity),
  };
  return <div className="mi-storm-rain" style={rainStyle} />;
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
  /** Fade-in/out ms for the audio bed (undefined → audio's ~5s default). */
  fadeMs?: number;
}

export function AmbianceLayer({ scene, intensity = 1, fadeMs }: AmbianceLayerProps) {
  // Ensure keyframes/classes exist before first paint of any scene.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    injectStyles();
    setReady(true);
  }, []);

  // NB: do NOT sweep audio here when the scene clears. The rain bed is owned by
  // StormLayer/RainLayer and stopped on their unmount (useRainBed's handle.stop),
  // so a blanket audio.stopAll() is redundant — and it would also kill unrelated
  // beds, e.g. an active whisperscape that overlaps the same player (the bug where
  // stopping the storm silenced the still-running whispers).

  if (!ready) return null;

  if (scene === "clear") {
    // Nothing to render — resting near-black + the ember show through.
    return null;
  }

  return (
    <div className="mi-ambiance" aria-hidden="true">
      {scene === "storm" && <StormLayer intensity={intensity} fadeMs={fadeMs} />}
      {scene === "rain" && <RainLayer intensity={intensity} fadeMs={fadeMs} />}
      {scene === "ember" && <EmberLayer intensity={intensity} />}
    </div>
  );
}
