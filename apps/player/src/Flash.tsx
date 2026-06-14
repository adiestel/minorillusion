/**
 * Flash — a brief full-screen light flash (a storm strike, a spell, a blast).
 *
 * One short flash per mounted instance: opacity rises fast (~60ms) to a peak,
 * then falls over the remainder (~260ms), ~320ms total by default (or
 * `effect.durationMs`), then unmounts via onDone. The wash is white shading to
 * pale-blue (lightning). `intensity` (0..1, default ~0.85) scales the PEAK
 * opacity only — never the speed or count.
 *
 * Sits above the ambiance (z-index 0) + ember (z-index 1), below the parchment
 * scrim (z-index 60), at z-index 45.
 *
 * Photosensitivity (DECISIONS D10): ONE brief flash per effect. The server paces
 * storm strikes seconds apart, so this is never a fast repetitive strobe. main.tsx
 * keys each instance by effect id (latest-wins) so quick succession doesn't leak.
 * Cheap DOM/CSS (DECISIONS D7/D13). In-world canvas stays text-free.
 */

import { useEffect, useRef, CSSProperties } from "react";

const STYLE_ID = "mi-flash-styles";

/** Default total duration (ms) when the effect omits durationMs. */
const DEFAULT_DURATION_MS = 320;
/** Default peak opacity when the effect omits intensity. */
const DEFAULT_INTENSITY = 0.85;
/** Fraction of the run spent rising to the peak (fast up, slower down). */
const RISE_FRACTION = 0.19; // ~60ms of 320ms

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  // The peak opacity is supplied per-instance via the --mi-flash-peak custom
  // property so intensity scales brightness without a per-instance keyframe.
  // Up fast to the peak, then down across the rest — a single, brief strike.
  style.textContent = `
    @keyframes mi-flash {
      0%   { opacity: 0; }
      ${Math.round(RISE_FRACTION * 100)}%  { opacity: var(--mi-flash-peak, 0.85); }
      100% { opacity: 0; }
    }
    .mi-flash {
      position: fixed; inset: 0; z-index: 45;
      pointer-events: none;
      /* white → pale-blue, the colour of a lightning wash */
      background: linear-gradient(
        to bottom,
        rgba(255, 255, 255, 1),
        rgba(198, 216, 255, 0.92)
      );
      opacity: 0;
      will-change: opacity;
      contain: strict;
    }
    .mi-flash.is-flashing {
      animation-name: mi-flash;
      animation-timing-function: ease-out;
      animation-iteration-count: 1;
      animation-fill-mode: forwards;
    }
  `;
  document.head.appendChild(style);
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return DEFAULT_INTENSITY;
  return Math.min(1, Math.max(0, n));
}

export interface FlashProps {
  intensity?: number;
  durationMs?: number;
  onDone: () => void;
}

export function Flash({ intensity, durationMs, onDone }: FlashProps) {
  // Guard onDone against StrictMode double-invoke / late fires.
  const doneRef = useRef(false);

  useEffect(() => {
    injectStyles();

    const total =
      durationMs !== undefined && durationMs > 0
        ? durationMs
        : DEFAULT_DURATION_MS;

    // Unmount once the single flash has fully faded back to transparent.
    const t = window.setTimeout(() => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone();
    }, total);

    return () => window.clearTimeout(t);
    // intensity/duration are fixed per mounted instance (keyed by id in main.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const peak = clamp01(intensity ?? DEFAULT_INTENSITY);
  const total =
    durationMs !== undefined && durationMs > 0 ? durationMs : DEFAULT_DURATION_MS;

  const style: CSSProperties = {
    // Custom props drive the keyframe peak + run length without a per-instance
    // @keyframes. (TS: CSS custom properties aren't in CSSProperties' typed keys.)
    ["--mi-flash-peak" as string]: String(peak),
    animationDuration: `${total}ms`,
  };

  return (
    <div className="mi-flash is-flashing" style={style} aria-hidden="true" />
  );
}
