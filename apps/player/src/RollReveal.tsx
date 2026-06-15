/**
 * RollReveal — the player-side roll visualization (M5: "the die reveals the result").
 *
 * When the GM calls a roll targeted at this player (or a public roll), the server
 * sends `roll:result` (the authoritative result, D6 — we own rolls) and main.tsx
 * mounts this transient overlay, keyed by the result id (latest-wins), self-removing
 * via onDone — the same pattern as Heartbeat/Flash.
 *
 * The reveal is diegetic + restrained (DESIGN.md): an in-world die settling onto a
 * dark tray, with a parchment readout beneath it — not app chrome. For a d20 roll
 * we mount the M4 DiceIsland (lazy, gated behind useGLEnabled "roll") so the die
 * tumbles and lands on the natural-d20 face (result = result.kept, the raw d20
 * before the modifier); when GL is unavailable the cheap fallback is a large rolled
 * number. Non-d20 rolls (e.g. 2d6 damage) skip the 3D die entirely and show only
 * the parchment readout.
 *
 * A crit (natural 20) gets a warm/gold flourish; a fumble (natural 1) a cold/ashen
 * one. Auto-dismisses after a few seconds (longer for a crit) via onDone(id).
 *
 * Sits above the ember/ambiance/heartbeat/flash (z 0/1/40/45) and the PlayerInput
 * compose plane (z 50), below the parchment message scrim (z 60) and the
 * audio-unlock modal (z 100): z-index 55.
 */

import {
  Suspense,
  lazy,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { RollResult } from "@minorillusion/contract";
import { palette } from "@minorillusion/design-system";
import { useGLEnabled } from "./gl/useGLEnabled";

// Lazy so three/R3F only enter the bundle as a chunk when a d20 actually reveals.
const DiceIsland = lazy(() => import("./gl/DiceIsland"));

const STYLE_ID = "mi-roll-styles";
const Z_INDEX = 55;
const DISMISS_MS = 5000;
const DISMISS_CRIT_MS = 7000; // a crit/fumble lingers a beat longer

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes mi-roll-scrim-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes mi-roll-scrim-out { from { opacity: 1 } to { opacity: 0 } }
    @keyframes mi-roll-readout-in {
      from { opacity: 0; transform: translateY(14px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    @keyframes mi-roll-total-in {
      0%   { opacity: 0; transform: scale(.7) }
      60%  { opacity: 1; transform: scale(1.08) }
      100% { opacity: 1; transform: scale(1) }
    }
    .mi-roll-scrim {
      position: fixed; inset: 0; z-index: ${Z_INDEX};
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      pointer-events: none;
      background: radial-gradient(ellipse at center, transparent 42%, rgba(0,0,0,.62) 100%);
      animation: mi-roll-scrim-in .5s ease forwards;
    }
    .mi-roll-scrim.is-out { animation: mi-roll-scrim-out .5s ease forwards; }
    .mi-roll-die {
      position: relative;
      width: min(72vw, 320px); height: min(72vw, 320px);
      flex-shrink: 0;
    }
    .mi-roll-readout {
      display: flex; flex-direction: column; align-items: center;
      gap: 6px; padding: 0 28px;
      text-align: center;
      font-family: 'IM Fell English', Georgia, serif;
      color: ${palette.parchment};
      animation: mi-roll-readout-in .9s cubic-bezier(.16,.8,.3,1) .25s both;
    }
    .mi-roll-label {
      font-size: clamp(15px, 4.4vw, 19px);
      letter-spacing: 0.04em;
      color: ${palette.parchmentDim};
    }
    .mi-roll-char { color: ${palette.ash}; }
    .mi-roll-breakdown {
      font-size: clamp(12px, 3.4vw, 14px);
      letter-spacing: 0.06em;
      color: ${palette.ash};
      font-variant-numeric: tabular-nums;
    }
    .mi-roll-total {
      font-size: clamp(52px, 16vw, 92px);
      line-height: 1; font-weight: 700;
      font-variant-numeric: tabular-nums;
      color: ${palette.parchment};
      animation: mi-roll-total-in .7s cubic-bezier(.16,.8,.3,1) .35s both;
    }
    /* a warm/gold flourish for a crit; a cold/ashen one for a fumble */
    .mi-roll-total.is-crit {
      color: #f4d28a;
      text-shadow: 0 0 22px rgba(244,170,90,.7), 0 0 46px rgba(255,120,40,.4);
    }
    .mi-roll-total.is-fumble {
      color: #8a93a0;
      text-shadow: 0 0 18px rgba(120,150,190,.45);
    }
    .mi-roll-flourish {
      font-size: clamp(12px, 3.6vw, 15px);
      letter-spacing: 0.34em; text-transform: uppercase;
    }
    .mi-roll-flourish.is-crit  { color: #f4d28a; }
    .mi-roll-flourish.is-fumble { color: #8a93a0; }
    /* the cheap (GL-off) d20 fallback: a large rolled number on the dark tray */
    .mi-roll-fallback {
      display: flex; align-items: center; justify-content: center;
      width: 100%; height: 100%;
      font-family: 'IM Fell English', Georgia, serif;
      font-size: clamp(96px, 30vw, 200px);
      font-weight: 700; line-height: 1;
      font-variant-numeric: tabular-nums;
      color: ${palette.parchment};
    }
    .mi-roll-fallback.is-crit  { color: #f4d28a; text-shadow: 0 0 28px rgba(244,170,90,.7); }
    .mi-roll-fallback.is-fumble { color: #8a93a0; text-shadow: 0 0 20px rgba(120,150,190,.45); }
  `;
  document.head.appendChild(style);
}

export interface RollRevealProps {
  result: RollResult;
  /** Called with the result id once the reveal has fully dismissed (latest-wins in main.tsx). */
  onDone: (id: string) => void;
}

/** Format the dice + modifier breakdown, e.g. "d20: 17  +3" or "2d6: 4, 5". */
function breakdown(result: RollResult): string {
  const faces = result.dice.join(", ");
  const dieLabel = `d${result.sides}: ${faces}`;
  if (result.modifier === 0) return dieLabel;
  const sign = result.modifier > 0 ? "+" : "−"; // − for negatives
  return `${dieLabel}   ${sign}${Math.abs(result.modifier)}`;
}

export function RollReveal({ result, onDone }: RollRevealProps) {
  const isD20 = result.sides === 20;
  // Only ask for a GL slot when there's actually a d20 to draw.
  const { enabled: glEnabled, tier } = useGLEnabled("roll", isD20);

  const [exiting, setExiting] = useState(false);
  const doneRef = useRef(false);
  const scrimRef = useRef<HTMLDivElement | null>(null);

  // Auto-dismiss after a few seconds (a crit/fumble lingers). A short exit fade,
  // then onDone — mirrors Heartbeat/Flash self-removal.
  useEffect(() => {
    injectStyles();
    const flourish = result.crit || result.fumble;
    const lifetime = flourish ? DISMISS_CRIT_MS : DISMISS_MS;

    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDone(result.id);
    };

    const startExit = window.setTimeout(() => setExiting(true), lifetime);
    // Fall back to a plain timeout if animationend never fires (e.g. no anim support).
    const hardStop = window.setTimeout(finish, lifetime + 700);

    const el = scrimRef.current;
    const onExitEnd = (e: AnimationEvent) => {
      if (e.animationName === "mi-roll-scrim-out") finish();
    };
    el?.addEventListener("animationend", onExitEnd);

    return () => {
      window.clearTimeout(startExit);
      window.clearTimeout(hardStop);
      el?.removeEventListener("animationend", onExitEnd);
    };
    // Fixed per mounted instance (keyed by result id in main.tsx).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flourishClass = result.crit ? "is-crit" : result.fumble ? "is-fumble" : "";

  const dieStyle: CSSProperties = { width: "100%", height: "100%" };

  return (
    <div
      ref={scrimRef}
      className={`mi-roll-scrim${exiting ? " is-out" : ""}`}
      aria-hidden="true"
    >
      {/* The die: a 3D d20 that settles on the natural face, or its cheap fallback.
          Non-d20 rolls (damage etc.) skip the die and show only the readout. */}
      {isD20 && (
        <div className="mi-roll-die">
          {glEnabled ? (
            <Suspense fallback={null}>
              <DiceIsland
                rollKey={1}
                result={result.kept}
                tier={tier}
                style={dieStyle}
              />
            </Suspense>
          ) : (
            <div className={`mi-roll-fallback ${flourishClass}`}>{result.kept}</div>
          )}
        </div>
      )}

      {/* The parchment readout: label (+ character), the die breakdown, the total big. */}
      <div className="mi-roll-readout">
        <span className="mi-roll-label">
          {result.label}
          {result.characterName !== undefined && (
            <span className="mi-roll-char"> {"•"} {result.characterName}</span>
          )}
        </span>
        <span className="mi-roll-breakdown">{breakdown(result)}</span>
        <span className={`mi-roll-total ${flourishClass}`}>{result.total}</span>
        {result.crit && <span className="mi-roll-flourish is-crit">critical</span>}
        {result.fumble && <span className="mi-roll-flourish is-fumble">fumble</span>}
      </div>
    </div>
  );
}
