/**
 * Onboarding — the first-run gesture-teach (M7; docs/M7-PLAN.md item 2).
 *
 * Shown ONCE per device, AFTER the player first joins a circle, teaching the two
 * input gestures the resting (diegetic, chrome-free) canvas would otherwise never
 * announce:
 *
 *   • tap the screen  → the quill (write) / the crystal ball (hold to talk)
 *
 * This is a transient LIMINAL surface, so a little legible text is allowed (the
 * skeuomorphic "no UI text" rule governs the resting in-world canvas, not an
 * explicit teaching overlay — DESIGN.md). It is deliberately restrained and
 * on-theme: a quiet near-black scrim with the quill + crystal-ball sigils (the
 * same glyphs the SigilLayer blooms) and one line each, dismissed with a single
 * "got it".
 *
 * Gated once-per-device on a localStorage flag (`mi.onboarded`) — see
 * onboarding.ts. main.tsx shows it only after a successful join when the flag is
 * unset, and marks it seen on dismiss.
 *
 * Layering (among the existing overlays — ambiance z0, ember z1, idle-catcher
 * z20, sigils z25, Flash z45, RecordingIndicator z46, PlayerInput surfaces z50,
 * RollReveal z55, log panel z58, ParchmentMessage scrim z60, AudioUnlockModal
 * z100): this sits at z52 — above the ember + the PlayerInput surfaces, below the
 * parchment scrim (z60) and the audio modal (z100) so a delivered message or the
 * sound-unlock prompt still wins. It NEVER blocks the safety affordances: it's
 * below the parchment/roll/audio surfaces, and (being one-shot, dismissed before
 * play) doesn't sit over the recording indicator in practice.
 *
 * Cheap DOM/CSS path (D7): inline SVG sigils, a single fade/rise, no 3D.
 */

import { CSSProperties, useEffect } from "react";
import { palette, space } from "@minorillusion/design-system";

// ---------------------------------------------------------------------------
// One-time style injection (the card's fade-and-rise entrance).
// ---------------------------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById("mi-onboard-styles")) return;
  const style = document.createElement("style");
  style.id = "mi-onboard-styles";
  style.textContent = `
    @keyframes mi-onboard-scrim-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes mi-onboard-card-in {
      from { opacity: 0; transform: translateY(16px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    .mi-onboard-scrim { animation: mi-onboard-scrim-in .4s ease forwards; }
    .mi-onboard-card  { animation: mi-onboard-card-in .5s cubic-bezier(.16,.8,.3,1) forwards; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Sigils — the same restrained quill + crystal-ball glyphs the SigilLayer uses,
// so the teach matches what the player will actually see bloom under their tap.
// ---------------------------------------------------------------------------

function QuillGlyph({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={palette.parchment}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 4c-1 6-5 10-11 12l-2 2" />
      <path
        d="M20 4c-5 1-8 3-10 6-1.4 2.1-1.6 4-1.6 5.6 1.6 0 3.5-.2 5.6-1.6 3-2 5-5 6-10z"
        fill={palette.ember}
        fillOpacity="0.18"
      />
      <path d="M7 18l-2 2" />
      <path d="M4 20l2-1" />
    </svg>
  );
}

function BallGlyph({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={palette.parchment}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="10" r="7" fill={palette.ember} fillOpacity="0.16" />
      <path d="M8.5 7.5a4 4 0 0 1 3-1.6" opacity="0.8" />
      <path d="M8 20h8" />
      <path d="M9.5 17.2 9 20" />
      <path d="M14.5 17.2 15 20" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface OnboardingProps {
  /** Fired by "got it" — mark onboarding seen + dismiss. */
  onDismiss: () => void;
}

export function Onboarding({ onDismiss }: OnboardingProps) {
  useEffect(() => {
    injectStyles();
  }, []);

  const scrim: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 52,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: space(6),
    background: "radial-gradient(ellipse at center, rgba(0,0,0,.62) 0%, rgba(0,0,0,.9) 100%)",
  };

  const card: CSSProperties = {
    width: "100%",
    maxWidth: 340,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: space(5),
    padding: `${space(7)} ${space(6)}`,
    borderRadius: "14px",
    background: palette.ink,
    border: `1px solid ${palette.ash}`,
    boxShadow: "0 18px 50px rgba(0,0,0,.6)",
    textAlign: "center",
  };

  const headingStyle: CSSProperties = {
    fontSize: 13,
    letterSpacing: "0.18em",
    textTransform: "uppercase",
    color: palette.ash,
  };

  const rowsStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space(5),
    width: "100%",
  };

  const rowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: space(4),
    textAlign: "left",
  };

  const sigilWrap: CSSProperties = {
    width: 52,
    height: 52,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    border: `1px solid ${palette.ash}`,
    background: `radial-gradient(circle, ${palette.ink} 0%, ${palette.nearBlack} 100%)`,
    boxShadow: `0 0 18px 3px ${palette.ember}22`,
  };

  const rowTextStyle: CSSProperties = {
    color: palette.parchment,
    fontSize: 15,
    lineHeight: 1.45,
  };

  const emphasisStyle: CSSProperties = {
    color: palette.bone,
    fontWeight: 600,
  };

  const buttonStyle: CSSProperties = {
    marginTop: space(1),
    background: palette.emberDim,
    border: `1px solid ${palette.ember}`,
    borderRadius: "8px",
    color: palette.bone,
    cursor: "pointer",
    font: "inherit",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "0.04em",
    padding: `${space(3)} ${space(6)}`,
    width: "100%",
  };

  return (
    <div className="mi-onboard-scrim" style={scrim} role="dialog" aria-modal="true" aria-label="How to speak to the Game Master">
      <div className="mi-onboard-card" style={card}>
        <span style={headingStyle}>tap the screen</span>

        <div style={rowsStyle}>
          <div style={rowStyle}>
            <span style={sigilWrap} aria-hidden="true">
              <QuillGlyph />
            </span>
            <span style={rowTextStyle}>
              The <span style={emphasisStyle}>quill</span> — tap, then write to the Game Master.
            </span>
          </div>

          <div style={rowStyle}>
            <span style={sigilWrap} aria-hidden="true">
              <BallGlyph />
            </span>
            <span style={rowTextStyle}>
              The <span style={emphasisStyle}>crystal ball</span> — hold it to speak.
            </span>
          </div>
        </div>

        <button type="button" style={buttonStyle} onClick={onDismiss}>
          got it
        </button>
      </div>
    </div>
  );
}
