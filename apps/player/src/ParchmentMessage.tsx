/**
 * ParchmentMessage — M1 parchment text effect.
 *
 * Renders an ink-on-weathered-parchment overlay for GM-sent messages.
 * Three modes keyed on MessageEffect.mode:
 *
 *   acknowledge  — unfurl + ink-in, haptic on arrival, stays until tapped;
 *                  tap → burn-to-ash (charring edges/embers) → emit effect:ack.
 *
 *   auto_dismiss — unfurl + ink-in, auto-refolds/fades after autoDismissMs
 *                  (fallback 6000 ms); no ack emitted.
 *
 *   silent       — no haptic; ambient ember edge-glow; gentle unfurl.
 *                  Fades on its own after autoDismissMs (fallback 8000 ms).
 *
 * Rendering strategy: cheap DOM/CSS path only (DESIGN.md).
 * No WebGL, no external image assets, no new runtime dependencies.
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  CSSProperties,
} from "react";

import type { MessageEffect } from "@minorillusion/contract";
import { palette, space } from "@minorillusion/design-system";
import { haptics } from "./capabilities/index";
import { socket } from "./socket";

// ---------------------------------------------------------------------------
// CSS keyframes injected once
// ---------------------------------------------------------------------------

let stylesInjected = false;

function injectParchmentStyles() {
  if (stylesInjected) return;
  stylesInjected = true;

  const style = document.createElement("style");
  style.id = "mi-parchment-styles";
  style.textContent = `
    /* ---- entrance: the scroll unfurls from a thin rolled sliver ---- */
    @keyframes parchment-unfurl {
      0%   { transform: scaleY(0.04) scaleX(0.85); opacity: 0; }
      30%  { transform: scaleY(0.6)  scaleX(0.96); opacity: 0.7; }
      70%  { transform: scaleY(1.04) scaleX(1.02); }
      100% { transform: scaleY(1)    scaleX(1);    opacity: 1; }
    }

    /* ---- silent variant: softer, slower entrance ---- */
    @keyframes parchment-unfurl-gentle {
      0%   { transform: scaleY(0.1) scaleX(0.9); opacity: 0; }
      100% { transform: scaleY(1)   scaleX(1);   opacity: 1; }
    }

    /* ---- ink reveal: left-to-right unmask ---- */
    @keyframes ink-reveal {
      from { clip-path: inset(0 100% 0 0); }
      to   { clip-path: inset(0 0%   0 0); }
    }

    /* ---- auto-dismiss: refold / fade away ---- */
    @keyframes parchment-refold {
      0%   { transform: scaleY(1)    scaleX(1);    opacity: 1; }
      40%  { transform: scaleY(0.92) scaleX(0.98); opacity: 0.85; }
      100% { transform: scaleY(0.05) scaleX(0.8);  opacity: 0; }
    }

    /* ---- burn: charring edges eaten away with ember glow ---- */
    @keyframes parchment-char {
      0%   {
        filter: brightness(1) sepia(0);
        box-shadow: 0 0 0px transparent inset;
      }
      25%  {
        filter: brightness(0.9) sepia(0.4);
      }
      60%  {
        filter: brightness(0.5) sepia(1) hue-rotate(-15deg);
        box-shadow:
          0 0 18px 10px #ff6b2d55 inset,
          0 0 6px 2px  #ff2200aa inset;
        opacity: 0.8;
      }
      100% {
        filter: brightness(0.1) sepia(1) hue-rotate(-20deg) contrast(2);
        box-shadow:
          0 0 40px 20px #ff2200 inset,
          0 0 80px 40px #ff6b2d inset;
        opacity: 0;
        transform: scaleY(0.15) scaleX(0.9);
      }
    }

    /* ---- floating ember particles that drift upward on burn ---- */
    @keyframes ember-rise-1 {
      0%   { transform: translate(0,    0)   scale(1);   opacity: 1; }
      100% { transform: translate(-18px,-80px) scale(0.3); opacity: 0; }
    }
    @keyframes ember-rise-2 {
      0%   { transform: translate(0,    0)   scale(1);   opacity: 1; }
      100% { transform: translate(22px, -70px) scale(0.2); opacity: 0; }
    }
    @keyframes ember-rise-3 {
      0%   { transform: translate(0,    0)   scale(1);   opacity: 1; }
      100% { transform: translate(-5px, -95px) scale(0.25); opacity: 0; }
    }
    @keyframes ember-rise-4 {
      0%   { transform: translate(0,    0)   scale(1);   opacity: 0.8; }
      100% { transform: translate(30px, -60px) scale(0.15); opacity: 0; }
    }

    /* ---- silent edge glow: slow, ambient pulse on screen rim ---- */
    @keyframes silent-rim-glow {
      0%, 100% { opacity: 0.18; }
      50%      { opacity: 0.42; }
    }

    /* ---- silent parchment: very faint presence pulse ---- */
    @keyframes parchment-silent-pulse {
      0%, 100% { opacity: 0.82; }
      50%      { opacity: 0.95; }
    }

    /* ---- acknowledge tap: haptic ripple visual feedback ---- */
    @keyframes tap-ripple {
      0%   { transform: scale(0.95); box-shadow: 0 0 0 0 ${palette.ember}55; }
      50%  { transform: scale(1.01); box-shadow: 0 0 0 12px ${palette.ember}00; }
      100% { transform: scale(1);   box-shadow: 0 0 0 0   transparent; }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Ember particle (shown during burn-to-ash)
// ---------------------------------------------------------------------------

interface EmberParticleProps {
  x: number;       // horizontal % offset within parchment
  y: number;       // vertical % offset
  delay: number;   // animation delay ms
  anim: string;    // keyframe name
}

function EmberParticle({ x, y, delay, anim }: EmberParticleProps) {
  const style: CSSProperties = {
    position: "absolute",
    left: `${x}%`,
    top: `${y}%`,
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: palette.ember,
    boxShadow: `0 0 6px 2px ${palette.ember}`,
    animation: `${anim} 0.9s ease-out ${delay}ms forwards`,
    pointerEvents: "none",
  };
  return <div style={style} aria-hidden="true" />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase =
  | "entering"   // unfurl animation playing
  | "reading"    // fully visible, waiting for interaction
  | "dismissing" // burn-to-ash or refold playing
  | "gone";      // removed from DOM

// ---------------------------------------------------------------------------
// ParchmentMessage component
// ---------------------------------------------------------------------------

export interface ParchmentMessageProps {
  effect: MessageEffect;
  onDone: () => void;  // call when the message is fully dismissed
}

export function ParchmentMessage({ effect, onDone }: ParchmentMessageProps) {
  injectParchmentStyles();

  const { id, body, mode, autoDismissMs } = effect;
  const [phase, setPhase] = useState<Phase>("entering");
  const [burning, setBurning] = useState(false);
  const burnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Unfurl duration: silent is gentler/longer
  const unfurlDurationMs = mode === "silent" ? 1400 : 900;
  // Ink-in starts slightly after unfurl
  const inkDelayMs = mode === "silent" ? 500 : 300;
  const inkDurationMs = Math.min(Math.max(body.length * 22, 1200), 3600);

  // Transition to "reading" after unfurl animation
  useEffect(() => {
    const t = setTimeout(() => {
      setPhase("reading");
    }, unfurlDurationMs + 80);
    return () => clearTimeout(t);
  }, [unfurlDurationMs]);

  // Haptic on arrival (acknowledge and auto_dismiss only)
  useEffect(() => {
    if (mode === "acknowledge") {
      haptics.vibrate([20, 30, 60]);
    } else if (mode === "auto_dismiss") {
      haptics.vibrate([15, 20, 40]);
    }
    // silent: no haptic
  }, [mode]);

  // Auto-dismiss timer (auto_dismiss and silent modes)
  useEffect(() => {
    if (mode !== "acknowledge") {
      const delay =
        mode === "silent"
          ? (autoDismissMs ?? 8000) + inkDelayMs + inkDurationMs
          : (autoDismissMs ?? 6000);
      autoTimerRef.current = setTimeout(() => {
        setPhase("dismissing");
      }, delay);
    }
    return () => {
      if (autoTimerRef.current !== null) clearTimeout(autoTimerRef.current);
    };
  }, [mode, autoDismissMs, inkDelayMs, inkDurationMs]);

  // After dismiss animation completes, call onDone
  const dismissDurationMs = mode === "acknowledge" ? 950 : 700;
  useEffect(() => {
    if (phase === "dismissing") {
      burnTimerRef.current = setTimeout(() => {
        // Emit ack only for acknowledge mode
        if (mode === "acknowledge") {
          socket.emit("effect:ack", { effectId: id });
        }
        setPhase("gone");
        onDone();
      }, dismissDurationMs);
    }
    return () => {
      if (burnTimerRef.current !== null) clearTimeout(burnTimerRef.current);
    };
  }, [phase, mode, id, onDone, dismissDurationMs]);

  // Tap handler for acknowledge mode
  const handleTap = useCallback(() => {
    if (mode !== "acknowledge" || phase !== "reading") return;
    setBurning(true);
    haptics.vibrate([10, 20, 30, 20, 60]);
    setPhase("dismissing");
  }, [mode, phase]);

  if (phase === "gone") return null;

  // ---------------------------------------------------------------------------
  // Style computation
  // ---------------------------------------------------------------------------

  const isDismissing = phase === "dismissing";

  // Backdrop: near-black scrim (lighter for silent)
  const backdropStyle: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 100,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    // silent: no dark scrim, stays ambient
    background:
      mode === "silent"
        ? "transparent"
        : `${palette.nearBlack}cc`,
    // silent rim glow is applied as a box-shadow on the viewport frame
    boxShadow:
      mode === "silent"
        ? `inset 0 0 80px 30px ${palette.ember}44, inset 0 0 30px 10px ${palette.emberDim}66`
        : "none",
    animation:
      mode === "silent" ? "silent-rim-glow 3.2s ease-in-out infinite" : "none",
    pointerEvents: mode === "acknowledge" ? "auto" : "none",
  };

  // Entrance animation
  let entranceAnim: string;
  if (mode === "silent") {
    entranceAnim = `parchment-unfurl-gentle ${unfurlDurationMs}ms cubic-bezier(0.22,1,0.36,1) forwards`;
  } else {
    entranceAnim = `parchment-unfurl ${unfurlDurationMs}ms cubic-bezier(0.22,1,0.36,1) forwards`;
  }

  // Exit animation
  let exitAnim: string;
  if (isDismissing && burning) {
    exitAnim = `parchment-char ${dismissDurationMs}ms ease-in forwards`;
  } else if (isDismissing) {
    exitAnim = `parchment-refold ${dismissDurationMs}ms ease-in forwards`;
  } else {
    exitAnim = "none";
  }

  const isAnimatingOut = isDismissing;
  const silentPulse =
    mode === "silent" && !isAnimatingOut
      ? "parchment-silent-pulse 3.8s ease-in-out infinite"
      : "none";

  // Parchment panel
  const parchmentStyle: CSSProperties = {
    position: "relative",
    width: "min(82vw, 360px)",
    maxHeight: "72vh",
    overflowY: "auto",
    // Weathered parchment via CSS gradients — no external images
    background: `
      radial-gradient(ellipse at 20% 15%, #f5edce 0%, transparent 55%),
      radial-gradient(ellipse at 80% 80%, #e4d4a8 0%, transparent 50%),
      radial-gradient(ellipse at 50% 50%, #eddfc2 0%, #d9c98d 100%)
    `,
    // Aged texture: subtle noise-like pattern via repeating gradients + filters
    backgroundBlendMode: "multiply",
    // Border — ragged edge suggestion via irregular box-shadow layers
    boxShadow: `
      0 0 0 1px ${palette.ink}88,
      0 2px 12px 0 ${palette.nearBlack}cc,
      inset 0 0 30px 6px #b8a26e44,
      inset 0 0 8px 2px #c9a94a22
    `,
    borderRadius: "3px 5px 4px 3px / 4px 3px 5px 4px",
    padding: `${space(7)} ${space(6)} ${space(6)}`,
    // Apply the filter that ages + softens the surface
    filter: "sepia(0.18) contrast(1.04) brightness(0.97)",
    // Cursor for acknowledge mode
    cursor: mode === "acknowledge" && phase === "reading" ? "pointer" : "default",
    // Stack: entrance first, then exit (exit overwrites when dismissing)
    animation: isAnimatingOut
      ? exitAnim
      : phase === "reading" && silentPulse !== "none"
      ? silentPulse
      : entranceAnim,
    userSelect: "none",
    WebkitUserSelect: "none",
    transformOrigin: "center center",
    // Tap affordance hint for acknowledge
    touchAction: "manipulation",
  };

  // Ink text — serif/handwriting font stack
  const textStyle: CSSProperties = {
    fontFamily:
      '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, "Times New Roman", serif',
    fontSize: 17,
    lineHeight: 1.72,
    color: "#1a1208",
    letterSpacing: "0.012em",
    wordBreak: "break-word",
    // Ink-reveal: left-to-right clip-path animation
    animation:
      !isAnimatingOut
        ? `ink-reveal ${inkDurationMs}ms ease-out ${inkDelayMs}ms both`
        : "none",
    // Very subtle ink bleed simulation
    textShadow: "0 0 1px #1a120888",
  };

  // Decorative top rule — a faint horizontal line suggestive of a seal bar
  const rulerStyle: CSSProperties = {
    display: "block",
    width: "100%",
    height: 1,
    background: `linear-gradient(to right, transparent, ${palette.ink}55, ${palette.ink}88, ${palette.ink}55, transparent)`,
    marginBottom: space(5),
    borderRadius: "1px",
  };

  // Tap hint (acknowledge mode, reading phase only)
  const tapHintStyle: CSSProperties = {
    display: "block",
    textAlign: "center",
    marginTop: space(5),
    fontSize: 10,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: palette.emberDim,
    fontFamily:
      '"Palatino Linotype", Palatino, "Book Antiqua", Georgia, serif',
    opacity: phase === "reading" ? 0.7 : 0,
    transition: "opacity 0.6s ease",
  };

  // Ember particles: only during burn
  const particleData: Array<{ x: number; y: number; delay: number; anim: string }> =
    burning
      ? [
          { x: 15, y: 70, delay: 0,   anim: "ember-rise-1" },
          { x: 50, y: 55, delay: 80,  anim: "ember-rise-2" },
          { x: 75, y: 65, delay: 160, anim: "ember-rise-3" },
          { x: 35, y: 80, delay: 240, anim: "ember-rise-4" },
          { x: 60, y: 40, delay: 120, anim: "ember-rise-1" },
          { x: 25, y: 45, delay: 300, anim: "ember-rise-2" },
        ]
      : [];

  return (
    <div style={backdropStyle} aria-modal={mode !== "silent"} role={mode !== "silent" ? "dialog" : "status"} aria-label="Message from GM">
      <div
        style={parchmentStyle}
        onClick={handleTap}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") handleTap();
        }}
        role={mode === "acknowledge" ? "button" : undefined}
        tabIndex={mode === "acknowledge" ? 0 : undefined}
        aria-label={mode === "acknowledge" ? "Dismiss message" : undefined}
      >
        {/* Decorative top rule */}
        <span style={rulerStyle} aria-hidden="true" />

        {/* The message body — ink writing itself in */}
        <p style={textStyle}>{body}</p>

        {/* Tap-to-dismiss hint for acknowledge mode */}
        {mode === "acknowledge" && (
          <span style={tapHintStyle} aria-hidden="true">
            touch to release
          </span>
        )}

        {/* Ember particles on burn */}
        {particleData.map((p, i) => (
          <EmberParticle key={i} {...p} />
        ))}
      </div>
    </div>
  );
}
