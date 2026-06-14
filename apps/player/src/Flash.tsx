/**
 * Flash — a full-screen light flash (a storm strike, a spell, a blast).
 *
 * Each strike is RANDOMIZED so no two look identical (real lightning varies): a
 * ~0.5s bloom up to a bright, near-white peak, then a long ~2s fade-out, and
 * sometimes one soft secondary swell on the way down (a lightning re-flicker).
 * Driven by the Web Animations API with per-instance keyframes; the screen goes
 * as bright as possible at the peak. Calls onDone when it has fully faded.
 *
 * Sits above the ambiance (z 0) + ember (z 1), below the parchment scrim (z 60),
 * at z-index 45.
 *
 * Photosensitivity (DECISIONS D10): smooth bloom + long fade, at most one gentle
 * secondary swell — never a fast repetitive strobe. The server paces storm
 * strikes seconds apart; main.tsx keys each instance by effect id (latest-wins).
 * Cheap DOM/CSS (D7/D13). In-world canvas stays text-free.
 *
 * `intensity`/`durationMs` are accepted for wire compatibility but the strike
 * owns its own bright envelope (so flashes are always vivid + varied).
 */

import { useEffect, useRef, CSSProperties } from "react";

const BASE_STYLE: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 45,
  pointerEvents: "none",
  opacity: 0,
  willChange: "opacity",
  contain: "strict",
  // bright white, shading to a faint cool blue at the edges (a lightning wash)
  background:
    "radial-gradient(ellipse at 50% 42%, rgba(255,255,255,1) 0%, rgba(236,243,255,1) 66%, rgba(208,224,255,1) 100%)",
};

export interface FlashProps {
  /** Reserved (wire compat); strikes currently always go bright. */
  intensity?: number;
  /** Reserved (wire compat); the strike owns its 0.5s-in / ~2s-out envelope. */
  durationMs?: number;
  onDone: () => void;
}

export function Flash({ onDone }: FlashProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone();
    };

    const el = ref.current;
    if (el === null || typeof el.animate !== "function") {
      // No Web Animations — hold briefly, then done (no flash rather than a jump).
      const t = window.setTimeout(finish, 2500);
      return () => window.clearTimeout(t);
    }

    // Randomized envelope — no two strikes the same.
    const fadeIn = 400 + Math.random() * 250; // 0.40–0.65s bloom
    const fadeOut = 1600 + Math.random() * 800; // 1.6–2.4s fade-out
    const total = fadeIn + fadeOut;
    const peak = 0.9 + Math.random() * 0.1; // near-white, as bright as possible
    const p = fadeIn / total;

    const frames: Keyframe[] = [
      { opacity: 0, offset: 0, easing: "ease-out" },
      { opacity: peak, offset: p, easing: "ease-out" },
    ];
    // ~55% of the time, a single soft re-flicker partway through the fade-out.
    if (Math.random() < 0.55) {
      const dipOff = Math.min(0.8, p + (1 - p) * (0.18 + Math.random() * 0.12));
      const swellOff = Math.min(0.9, dipOff + (1 - p) * (0.1 + Math.random() * 0.1));
      frames.push({ opacity: peak * (0.15 + Math.random() * 0.15), offset: dipOff, easing: "ease-out" });
      frames.push({ opacity: peak * (0.4 + Math.random() * 0.25), offset: swellOff, easing: "ease-out" });
    }
    frames.push({ opacity: 0, offset: 1 });

    const anim = el.animate(frames, { duration: total, fill: "forwards" });
    anim.onfinish = finish;

    return () => {
      try {
        anim.cancel();
      } catch {
        /* already gone */
      }
    };
    // Fixed per mounted instance (keyed by effect id in main.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the class for the dev preview's freeze hook (preview.tsx ?flash=1).
  return <div ref={ref} className="mi-flash" style={BASE_STYLE} aria-hidden="true" />;
}
