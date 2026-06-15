/**
 * Consent-at-join sheet (Inviolable rule D10 / DECISIONS.md).
 *
 * Joining must show a clear disclosure of what the GM can do to the device. This
 * is PRE-circle config, so legible text + chrome are allowed (the skeuomorphic
 * "no UI text" rule applies only to the in-world canvas).
 *
 * Flow (wired in main.tsx): on a valid JoinScreen submit we show this sheet
 * instead of joining immediately. Its primary button is the user gesture that
 * (1) unlocks audio and (2) actually emits circle:join. "Not now" returns to the
 * join screen. The primary handler is passed in as onAccept; this component owns
 * only the presentation.
 */

import { CSSProperties } from "react";
import { palette, space } from "@minorillusion/design-system";

export interface ConsentProps {
  /** Fired by the primary button — the user gesture (unlock audio + join). */
  onAccept: () => void;
  /** Fired by "Not now" — return to the join screen. */
  onDecline: () => void;
  /** Disable the primary button while the join round-trips. */
  busy?: boolean;
}

export function Consent({ onAccept, onDecline, busy = false }: ConsentProps) {
  const screenStyle: CSSProperties = {
    position: "relative",
    zIndex: 1,
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    height: "100%",
    padding: `${space(7)} ${space(5)}`,
    background: "var(--bg)",
  };

  const sheetStyle: CSSProperties = {
    width: "100%",
    maxWidth: 360,
    marginLeft: "auto",
    marginRight: "auto",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: space(5),
    background: palette.ink,
    border: `1px solid ${palette.ash}`,
    borderRadius: "12px",
    padding: `${space(6)} ${space(5)}`,
  };

  const headingStyle: CSSProperties = {
    fontSize: 20,
    fontWeight: 600,
    letterSpacing: "0.02em",
    color: palette.bone,
    textAlign: "center",
  };

  const listStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space(4),
    color: palette.parchment,
    fontSize: 15,
    lineHeight: 1.5,
  };

  const emphasisStyle: CSSProperties = {
    color: palette.bone,
  };

  const actionsStyle: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: space(3),
    marginTop: space(2),
  };

  const primaryStyle: CSSProperties = {
    background: busy ? palette.ink : palette.emberDim,
    border: `1px solid ${busy ? palette.ash : palette.ember}`,
    borderRadius: "8px",
    color: busy ? palette.ash : palette.bone,
    cursor: busy ? "default" : "pointer",
    font: "inherit",
    fontSize: 16,
    fontWeight: 600,
    padding: `${space(4)} ${space(4)}`,
    width: "100%",
    transition: "background 0.2s, color 0.2s, border-color 0.2s",
  };

  const secondaryStyle: CSSProperties = {
    background: "transparent",
    border: "none",
    borderRadius: "8px",
    color: palette.ash,
    cursor: "pointer",
    font: "inherit",
    fontSize: 14,
    letterSpacing: "0.04em",
    padding: `${space(2)} ${space(4)}`,
    width: "100%",
  };

  return (
    <div style={screenStyle}>
      <div style={sheetStyle} role="dialog" aria-modal="true" aria-label="Before you join">
        <h1 style={headingStyle}>Before you join</h1>

        <div style={listStyle}>
          <p>
            During this session the Game Master can{" "}
            <span style={emphasisStyle}>play sounds on your phone, make it vibrate, and change what&rsquo;s on your screen.</span>
          </p>
          <p>
            Your microphone and camera are{" "}
            <span style={emphasisStyle}>never used unless you start them yourself</span>{" "}
            &mdash; and you&rsquo;ll always see an indicator when they&rsquo;re active.
          </p>
          <p>
            If you hold the crystal ball to talk, your voice is{" "}
            <span style={emphasisStyle}>recorded and turned into text for the Game Master</span>
            , only while you hold it, with a recording indicator on screen the whole time.
          </p>
          <p>Leaving is one tap, any time.</p>
        </div>

        <div style={actionsStyle}>
          <button
            type="button"
            onClick={onAccept}
            disabled={busy}
            style={primaryStyle}
          >
            {busy ? "entering…" : "I understand — enter the circle"}
          </button>
          <button type="button" onClick={onDecline} style={secondaryStyle}>
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
