/**
 * Hearth — M7 join ritual centerpiece (the GM's full-screen display).
 *
 * A toggle in the CirclePanel opens this as a fixed full-screen overlay meant to
 * be set on the table: a warm, crackling-fire visual (pure CSS/gradient animation
 * — the cheap path, no video), the join code shown large, and a QR code that
 * encodes the player join URL so a phone can tap-to-join by pointing its camera.
 *
 * The QR encodes `${PLAYER_URL}?code=${code}` where PLAYER_URL comes from
 * VITE_PLAYER_URL (falling back to the dev player at :5174) — the same convention
 * the contract notes for the join link. We render it to a PNG data: URL with the
 * `qrcode` library (dark ink on a parchment quiet-zone for scan contrast) and show
 * the URL as a fallback for anything that can't scan.
 *
 * "Exit hearth" (a corner button, plus Escape) returns to the console. This is a
 * presentation-only surface — it holds no socket state of its own.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { palette, radius, space } from "@minorillusion/design-system";

// Where a scanned/clicked join link should land — the player app. Mirrors the
// Stage's PLAYER_BASE resolution so both planes agree on the player origin.
const PLAYER_URL =
  (import.meta.env.VITE_PLAYER_URL as string | undefined) ?? "http://localhost:5174";

/** The full join URL a player opens — carries the circle code as `?code=`. */
export function joinUrl(code: string): string {
  return `${PLAYER_URL.replace(/\/$/, "")}?code=${encodeURIComponent(code)}`;
}

interface HearthProps {
  code: string;
  onExit: () => void;
}

export function Hearth({ code, onExit }: HearthProps) {
  const url = joinUrl(code);

  // QR rendered to a data: URL. Regenerated only when the join URL changes.
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [qrError, setQrError] = useState(false);

  useEffect(() => {
    let alive = true;
    setQrError(false);
    QRCode.toDataURL(url, {
      errorCorrectionLevel: "M",
      margin: 2,
      scale: 10,
      color: { dark: palette.ink, light: palette.bone },
    })
      .then((dataUrl) => {
        if (alive) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (alive) setQrError(true);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  // Escape exits the hearth (matches the on-screen affordance).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onExit();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  return (
    <div role="dialog" aria-label="Hearth — join the circle" style={overlayStyle}>
      {/* The fire — layered flickering gradients (cheap path, no media). */}
      <FireBackdrop />

      {/* Exit affordance — always reachable in the corner. */}
      <button onClick={onExit} style={exitButtonStyle} aria-label="Exit hearth">
        Exit hearth
      </button>

      {/* Centerpiece — code + QR sit above the fire. */}
      <div style={contentStyle}>
        <span style={kickerStyle}>Gather round the fire</span>

        <div style={codeWrapStyle}>
          <span style={codeLabelStyle}>Join code</span>
          <span style={codeStyle}>{code}</span>
        </div>

        <div style={qrCardStyle}>
          {qrError ? (
            <span style={qrErrorStyle}>Could not render the QR — use the link below.</span>
          ) : qrDataUrl ? (
            <img src={qrDataUrl} alt={`QR code to join with code ${code}`} style={qrImageStyle} />
          ) : (
            <div style={qrPlaceholderStyle} aria-hidden="true" />
          )}
        </div>

        <span style={scanHintStyle}>Point your phone's camera to join</span>
        <span style={urlStyle}>{url}</span>
      </div>

      {/* Self-contained keyframes — no global CSS edit (mirrors Lore's pattern). */}
      <style>{FIRE_KEYFRAMES}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FireBackdrop — a warm crackling fire from layered animated gradients.
// Three drifting/flickering radial layers over an ember-to-black base, plus a
// brightness flicker on the whole stack — reads as a living fire, cheaply.
// ---------------------------------------------------------------------------

function FireBackdrop() {
  return (
    <div aria-hidden="true" style={fireRootStyle}>
      <div style={{ ...fireLayerStyle, ...fireLayerA }} />
      <div style={{ ...fireLayerStyle, ...fireLayerB }} />
      <div style={{ ...fireLayerStyle, ...fireLayerC }} />
      {/* A dark vignette so the centerpiece text stays legible. */}
      <div style={vignetteStyle} />
    </div>
  );
}

// ===========================================================================
// Styles
// ===========================================================================

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 1000,
  overflow: "hidden",
  background: palette.nearBlack,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const fireRootStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  // Base glow: hot ember floor fading up into the dark.
  background:
    "radial-gradient(ellipse 120% 80% at 50% 118%, #ff8a3d 0%, #c23b10 26%, #5a1c08 52%, #1a0d07 78%, #0a0908 100%)",
  animation: "mi-fire-breathe 3.4s ease-in-out infinite",
};

const fireLayerStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  mixBlendMode: "screen",
  pointerEvents: "none",
};

// Three offset tongues of flame, each flickering on its own cadence.
const fireLayerA: React.CSSProperties = {
  background:
    "radial-gradient(ellipse 50% 60% at 38% 112%, rgba(255,150,40,0.9) 0%, rgba(255,90,20,0.35) 38%, transparent 66%)",
  animation: "mi-fire-flicker-a 1.7s ease-in-out infinite",
};
const fireLayerB: React.CSSProperties = {
  background:
    "radial-gradient(ellipse 46% 66% at 62% 116%, rgba(255,120,30,0.85) 0%, rgba(220,60,15,0.3) 40%, transparent 68%)",
  animation: "mi-fire-flicker-b 2.3s ease-in-out infinite",
};
const fireLayerC: React.CSSProperties = {
  background:
    "radial-gradient(ellipse 34% 52% at 50% 120%, rgba(255,210,120,0.85) 0%, rgba(255,140,40,0.3) 42%, transparent 64%)",
  animation: "mi-fire-flicker-c 1.3s ease-in-out infinite",
};

const vignetteStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "radial-gradient(ellipse 80% 70% at 50% 42%, transparent 0%, transparent 46%, rgba(0,0,0,0.55) 100%)",
  pointerEvents: "none",
};

const FIRE_KEYFRAMES = `
@keyframes mi-fire-breathe {
  0%,100% { filter: brightness(1); }
  50%     { filter: brightness(1.12); }
}
@keyframes mi-fire-flicker-a {
  0%,100% { opacity: 0.85; transform: translateY(0) scaleY(1); }
  30%     { opacity: 1;    transform: translateY(-2%) scaleY(1.06); }
  60%     { opacity: 0.7;  transform: translateY(1%) scaleY(0.97); }
}
@keyframes mi-fire-flicker-b {
  0%,100% { opacity: 0.7;  transform: translateY(0) scaleY(1); }
  40%     { opacity: 0.95; transform: translateY(-3%) scaleY(1.08); }
  70%     { opacity: 0.6;  transform: translateY(1%) scaleY(0.96); }
}
@keyframes mi-fire-flicker-c {
  0%,100% { opacity: 0.9;  transform: translateY(0) scaleX(1); }
  25%     { opacity: 1;    transform: translateY(-2%) scaleX(1.05); }
  55%     { opacity: 0.75; transform: translateY(2%) scaleX(0.94); }
}`;

const contentStyle: React.CSSProperties = {
  position: "relative",
  zIndex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: space(5),
  padding: space(8),
  textAlign: "center",
  maxWidth: "min(92vw, 560px)",
};

const kickerStyle: React.CSSProperties = {
  fontSize: "0.82rem",
  fontWeight: 700,
  letterSpacing: "0.22em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
  textShadow: "0 2px 12px rgba(0,0,0,0.7)",
};

const codeWrapStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: space(1),
};

const codeLabelStyle: React.CSSProperties = {
  fontSize: "0.7rem",
  fontWeight: 700,
  letterSpacing: "0.2em",
  textTransform: "uppercase",
  color: palette.bone,
  opacity: 0.85,
  textShadow: "0 2px 10px rgba(0,0,0,0.8)",
};

const codeStyle: React.CSSProperties = {
  fontSize: "clamp(3rem, 13vw, 6rem)",
  fontWeight: 800,
  letterSpacing: "0.16em",
  lineHeight: 1,
  color: palette.bone,
  fontVariantNumeric: "tabular-nums",
  textShadow: "0 0 28px rgba(255,140,60,0.65), 0 4px 18px rgba(0,0,0,0.8)",
};

const qrCardStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: "clamp(168px, 42vw, 248px)",
  height: "clamp(168px, 42vw, 248px)",
  padding: space(3),
  background: palette.bone,
  borderRadius: radius.md,
  boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
};

const qrImageStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  imageRendering: "pixelated",
  display: "block",
};

const qrPlaceholderStyle: React.CSSProperties = {
  width: "100%",
  height: "100%",
  borderRadius: radius.sm,
  background: "rgba(0,0,0,0.06)",
};

const qrErrorStyle: React.CSSProperties = {
  fontSize: "0.82rem",
  color: palette.ink,
  padding: space(3),
};

const scanHintStyle: React.CSSProperties = {
  fontSize: "0.92rem",
  color: palette.bone,
  opacity: 0.9,
  textShadow: "0 2px 10px rgba(0,0,0,0.8)",
};

const urlStyle: React.CSSProperties = {
  fontSize: "0.78rem",
  color: palette.parchmentDim,
  wordBreak: "break-all",
  opacity: 0.8,
  textShadow: "0 1px 6px rgba(0,0,0,0.8)",
};

const exitButtonStyle: React.CSSProperties = {
  position: "absolute",
  top: space(5),
  right: space(5),
  zIndex: 2,
  padding: `${space(2)} ${space(4)}`,
  background: "rgba(10,9,8,0.55)",
  color: palette.bone,
  border: `1px solid ${palette.parchmentDim}`,
  borderRadius: radius.pill,
  fontWeight: 600,
  fontSize: "0.85rem",
  letterSpacing: "0.04em",
  cursor: "pointer",
  backdropFilter: "blur(4px)",
};
