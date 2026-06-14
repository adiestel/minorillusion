/**
 * AudioUnlockModal — shown ONLY when the AudioContext is suspended (autoplay
 * policy, the browser idled it, or the app returned from the background). A
 * single tap resumes audio; the modal then clears itself (main.tsx listens to
 * audio.onLockChange). Never shown when sound is already playing.
 *
 * On-theme: a quiet near-black card with a breathing ember behind a sound glyph
 * — the hearth has gone silent and a tap wakes it. The whole scrim is tappable.
 */
import { CSSProperties } from "react";
import { palette, space } from "@minorillusion/design-system";
import { audio } from "./capabilities/index";

export function AudioUnlockModal() {
  const wake = () => audio.unlock();

  return (
    <div
      role="button"
      aria-label="Enable sound"
      tabIndex={0}
      onClick={wake}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") wake();
      }}
      style={scrimStyle}
    >
      <div style={cardStyle} onClick={(e) => e.stopPropagation()}>
        <div style={glyphWrapStyle} aria-hidden="true">
          <span className="ember-glow" style={emberStyle} />
          <SpeakerGlyph />
        </div>
        <p style={titleStyle}>Sound is paused</p>
        <p style={subStyle}>Tap to let the circle be heard again.</p>
        <button style={buttonStyle} onClick={wake} type="button">
          Enable sound
        </button>
      </div>
    </div>
  );
}

function SpeakerGlyph() {
  return (
    <svg
      width="34"
      height="34"
      viewBox="0 0 24 24"
      fill="none"
      stroke={palette.ember}
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ position: "relative", zIndex: 1 }}
    >
      <path d="M11 5 6 9H3v6h3l5 4V5z" fill={palette.ember} fillOpacity="0.15" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 6a9 9 0 0 1 0 12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const scrimStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 100, // above the parchment scrim (z 60)
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: space(6),
  background: "rgba(6, 5, 4, 0.82)",
  backdropFilter: "blur(3px)",
  WebkitBackdropFilter: "blur(3px)",
  cursor: "pointer",
  animation: "fade-in 0.4s ease-out",
};

const cardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: space(3),
  maxWidth: 300,
  width: "100%",
  padding: `${space(7)} ${space(6)}`,
  background: "#100d0b",
  border: `1px solid ${palette.emberDim}`,
  borderRadius: 14,
  textAlign: "center",
  boxShadow: "0 18px 50px rgba(0,0,0,0.6)",
  cursor: "default",
};

const glyphWrapStyle: CSSProperties = {
  position: "relative",
  width: 64,
  height: 64,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  marginBottom: space(1),
};

const emberStyle: CSSProperties = {
  position: "absolute",
  inset: -8,
  borderRadius: "50%",
  background: `radial-gradient(circle, ${palette.ember}55 0%, ${palette.emberDim}33 45%, transparent 70%)`,
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  fontWeight: 700,
  color: palette.parchment,
  letterSpacing: "0.01em",
};

const subStyle: CSSProperties = {
  margin: 0,
  fontSize: "0.88rem",
  lineHeight: 1.5,
  color: palette.parchmentDim,
};

const buttonStyle: CSSProperties = {
  marginTop: space(2),
  padding: `${space(3)} ${space(6)}`,
  background: palette.ember,
  color: palette.nearBlack,
  border: "none",
  borderRadius: 8,
  fontWeight: 700,
  fontSize: "0.95rem",
  letterSpacing: "0.04em",
  cursor: "pointer",
};
