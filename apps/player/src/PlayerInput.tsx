/**
 * PlayerInput — the player's input grammar (M3; docs/DESIGN.md "Input grammar").
 *
 * The player speaking back to the GM. A full-screen overlay over the joined
 * canvas with a small state machine:
 *
 *   idle ──tap──▶ sigils ──quill──▶ compose (textarea → channel:text)
 *                   │     └─ball───▶ ptt    (hold-to-talk → channel:voice)
 *                   └──tap-outside──▶ idle
 *
 * Skeuomorphic rule (INVIOLABLE, DESIGN.md): the resting canvas stays JUST the
 * breathing ember — this layer is an invisible tap-catcher when idle and paints
 * NO chrome. The quill/crystal-ball sigils bloom from the touch point only after
 * a tap; plain text + controls live ONLY on the explicit compose/PTT surfaces
 * that a tap opens (DESIGN.md: "controls live only on explicit menu/liminal
 * surfaces"). A wax-seal "to the GM" token is the universal recipient marker
 * (DM-only for M3 — no picker).
 *
 * Mic rule (INVIOLABLE, D10): voice is captured ONLY while the player holds the
 * crystal ball. A visible "● recording" indicator is on screen the whole time the
 * mic is live; releasing stops the recorder AND releases the mic tracks (see
 * capabilities/mic.ts) so the OS indicator goes dark. If the mic is unsupported
 * or denied, the ball degrades gracefully to "voice isn't available — use the
 * quill" and routes to text (D10 graceful degradation).
 *
 * Layering (so we sit correctly among the existing overlays in main.tsx:
 * ambiance z0, ember z1, Flash z45, ParchmentMessage z60, AudioUnlockModal z100):
 *   • idle tap-catcher       z20  (above the ember, below everything transient)
 *   • blooming sigils        z25
 *   • compose / PTT surface  z50  (above a transient flash; below parchment + the
 *                                  audio modal, so those still win)
 *
 * Cheap DOM/CSS path (D7): glyphs are inline SVG in the ember/parchment palette;
 * transitions are transform/opacity only.
 */

import {
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SendMessageResult } from "@minorillusion/contract";
import { palette, space } from "@minorillusion/design-system";

import { socket } from "./socket";
import { haptics, mic } from "./capabilities/index";
import { HAPTIC_PATTERNS } from "./hapticPatterns";

// ---------------------------------------------------------------------------
// One-time style injection (sigil bloom, PTT thrum, the recording pulse).
// ---------------------------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById("mi-input-styles")) return;
  const style = document.createElement("style");
  style.id = "mi-input-styles";
  style.textContent = `
    @keyframes mi-sigil-bloom {
      from { opacity: 0; transform: scale(0.5); }
      to   { opacity: 1; transform: scale(1); }
    }
    @keyframes mi-surface-in {
      from { opacity: 0; transform: translateY(14px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    @keyframes mi-rec-pulse {
      0%, 100% { opacity: 0.55; transform: scale(1); }
      50%      { opacity: 1;    transform: scale(1.25); }
    }
    /* The crystal ball glows + thrums while the player holds to talk. */
    @keyframes mi-ball-thrum {
      0%, 100% { transform: scale(1);    box-shadow: 0 0 28px 6px ${palette.ember}55; }
      50%      { transform: scale(1.06); box-shadow: 0 0 54px 16px ${palette.ember}aa; }
    }
    @keyframes mi-fade-in { from { opacity: 0; } to { opacity: 1; } }

    .mi-sigil-bloom   { animation: mi-sigil-bloom .26s cubic-bezier(.16,.8,.3,1) forwards; }
    .mi-surface-in    { animation: mi-surface-in .3s cubic-bezier(.16,.8,.3,1) forwards; }
    .mi-rec-dot       { animation: mi-rec-pulse 1s ease-in-out infinite; }
    .mi-ball-live     { animation: mi-ball-thrum 1.1s ease-in-out infinite; }
    .mi-fade-in       { animation: mi-fade-in .25s ease forwards; }

    .mi-input-textarea::placeholder { color: ${palette.ash}; }
    .mi-input-textarea:focus-visible { outline: 2px solid ${palette.ember}; outline-offset: 2px; }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Glyphs — restrained inline SVG sigils in the ember palette (cheap path).
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
      {/* a feather quill nib drawn diagonally */}
      <path d="M20 4c-1 6-5 10-11 12l-2 2" />
      <path d="M20 4c-5 1-8 3-10 6-1.4 2.1-1.6 4-1.6 5.6 1.6 0 3.5-.2 5.6-1.6 3-2 5-5 6-10z" fill={palette.ember} fillOpacity="0.18" />
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
      {/* the crystal ball on a small stand */}
      <circle cx="12" cy="10" r="7" fill={palette.ember} fillOpacity="0.16" />
      {/* a refracted highlight */}
      <path d="M8.5 7.5a4 4 0 0 1 3-1.6" opacity="0.8" />
      <path d="M8 20h8" />
      <path d="M9.5 17.2 9 20" />
      <path d="M14.5 17.2 15 20" />
    </svg>
  );
}

/** The wax-seal recipient token — the universal "who" marker (DESIGN.md). */
function WaxSeal({ size = 34 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" fill={palette.emberDim} stroke={palette.ember} strokeWidth="1" />
      {/* a simple sigil impressed into the wax */}
      <path
        d="M12 7.5l1.3 2.7 3 .4-2.1 2.1.5 3-2.7-1.4-2.7 1.4.5-3-2.1-2.1 3-.4z"
        fill={palette.ember}
        fillOpacity="0.55"
        stroke={palette.bone}
        strokeWidth="0.7"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Mode = "idle" | "sigils" | "compose" | "ptt";

/** A short fading toast on an explicit surface (e.g. "sent", a degrade note). */
interface Toast {
  text: string;
}

/** Where the player tapped, so the sigils bloom from that point. */
interface Origin {
  x: number;
  y: number;
}

export function PlayerInput() {
  const [mode, setMode] = useState<Mode>("idle");
  const [origin, setOrigin] = useState<Origin>({ x: 0, y: 0 });
  // Compose state.
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  // A brief confirmation / notice shown on the open surface.
  const [toast, setToast] = useState<Toast | null>(null);
  // PTT state.
  const [recording, setRecording] = useState(false);
  // True once the mic is known unsupported / denied — the ball goes to a
  // "use the quill" fallback rather than attempting capture (D10).
  const [voiceBlocked, setVoiceBlocked] = useState(false);

  const toastTimer = useRef<number | undefined>(undefined);
  // Guards a stop()/send already in flight so a pointerup + pointerleave on the
  // same release don't both send.
  const pttStopping = useRef(false);
  // True between a PTT pointerdown and its release — so a release that lands
  // WHILE mic.start() is still resolving (permission prompt) can immediately
  // abort the capture once it opens, rather than leaving the mic live.
  const heldRef = useRef(false);

  useEffect(() => {
    injectStyles();
  }, []);

  // On unmount (e.g. the player is ejected mid-record), ALWAYS release the mic.
  useEffect(() => {
    return () => {
      if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
      if (mic.isRecording()) mic.cancel();
    };
  }, []);

  /** Flash a short message on the current surface, auto-clearing. */
  const showToast = useCallback((text: string, ms = 1400) => {
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
    setToast({ text });
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  /** Return to the resting ember: clear the draft + any toast. */
  const dismiss = useCallback(() => {
    // Defensive (INVIOLABLE D10): never leave the mic live on any exit path —
    // if a capture is somehow still running, abort + release it (no clip).
    heldRef.current = false;
    if (mic.isRecording()) mic.cancel();
    setMode("idle");
    setDraft("");
    setSending(false);
    setRecording(false);
    setToast(null);
    if (toastTimer.current !== undefined) window.clearTimeout(toastTimer.current);
  }, []);

  // --- idle → sigils: capture the tap point and bloom the sigils there. ---
  const handleIdleTap = useCallback((e: ReactPointerEvent) => {
    setOrigin({ x: e.clientX, y: e.clientY });
    setMode("sigils");
  }, []);

  const openQuill = useCallback(() => {
    setMode("compose");
  }, []);

  const openBall = useCallback(() => {
    // Feature-detect up front (D10): if the mic can't work at all, open the PTT
    // surface in its blocked state with the quill offered, rather than letting a
    // hold attempt fail silently.
    setVoiceBlocked(!mic.isSupported());
    setRecording(false);
    pttStopping.current = false;
    setMode("ptt");
  }, []);

  // --- quill compose: send typed text. ---
  const sendText = useCallback(() => {
    const text = draft.trim();
    if (text.length === 0 || sending) return; // ignore empty
    setSending(true);
    socket.emit("channel:text", { text }, (res: SendMessageResult) => {
      setSending(false);
      if (res.ok) {
        haptics.vibrate(HAPTIC_PATTERNS.success);
        setDraft("");
        showToast("sent");
        // Let the "sent" beat land, then fall back to the resting ember.
        window.setTimeout(dismiss, 700);
      } else {
        showToast(res.error || "couldn’t send — try again", 2200);
      }
    });
  }, [draft, sending, showToast, dismiss]);

  // --- crystal-ball PTT: hold to record, release to stop + send. ---
  const beginHold = useCallback(
    async (e: ReactPointerEvent) => {
      if (recording || voiceBlocked) return;
      // Keep receiving pointer events even if the finger slides off the ball, so
      // we always get the matching release.
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        /* capture is best-effort */
      }
      pttStopping.current = false;
      heldRef.current = true;
      try {
        await mic.start();
        // If the player already released while the permission prompt was up,
        // don't go live — abort + release the mic immediately (no clip).
        if (!heldRef.current) {
          mic.cancel();
          return;
        }
        setRecording(true);
        haptics.vibrate(HAPTIC_PATTERNS.buzz); // a felt "you're live" tick
      } catch {
        // Unsupported / permission denied / hardware error → degrade to text.
        setVoiceBlocked(true);
        setRecording(false);
      }
    },
    [recording, voiceBlocked],
  );

  const endHold = useCallback(async () => {
    heldRef.current = false;
    if (!recording || pttStopping.current) return;
    pttStopping.current = true;
    setRecording(false);
    setSending(true);
    let clip: { dataUrl: string; mimeType: string; durationMs: number };
    try {
      clip = await mic.stop();
    } catch {
      // Capture produced nothing usable; release already happened in mic.stop().
      setSending(false);
      showToast("didn’t catch that — hold to talk", 1800);
      return;
    }
    // A too-short clip is almost certainly an accidental tap — drop it quietly.
    if (clip.durationMs < 350) {
      setSending(false);
      return;
    }
    socket.emit(
      "channel:voice",
      { audio: clip.dataUrl, mimeType: clip.mimeType, durationMs: clip.durationMs },
      (res: SendMessageResult) => {
        setSending(false);
        if (res.ok) {
          haptics.vibrate(HAPTIC_PATTERNS.success);
          showToast("sent");
          window.setTimeout(dismiss, 700);
        } else {
          showToast(res.error || "couldn’t send — try again", 2400);
        }
      },
    );
  }, [recording, showToast, dismiss]);

  // ---------------------------------------------------------------------------
  // Render — one of four layers depending on the mode.
  // ---------------------------------------------------------------------------

  if (mode === "idle") {
    // Invisible tap-catcher over the resting canvas — NO chrome (skeuomorphic).
    const catcher: CSSProperties = {
      position: "fixed",
      inset: 0,
      zIndex: 20,
      background: "transparent",
      // Don't swallow the audio-unlock modal / parchment (higher z); this only
      // catches taps on the bare ember.
      touchAction: "manipulation",
    };
    return (
      <div
        style={catcher}
        onPointerDown={handleIdleTap}
        role="button"
        aria-label="Open the quill or crystal ball to message the Game Master"
      />
    );
  }

  if (mode === "sigils") {
    return (
      <SigilLayer
        origin={origin}
        onQuill={openQuill}
        onBall={openBall}
        onDismiss={dismiss}
      />
    );
  }

  if (mode === "compose") {
    return (
      <ComposeSurface
        draft={draft}
        sending={sending}
        toast={toast}
        onChange={setDraft}
        onSend={sendText}
        onClose={dismiss}
      />
    );
  }

  // mode === "ptt"
  return (
    <PttSurface
      recording={recording}
      sending={sending}
      voiceBlocked={voiceBlocked}
      toast={toast}
      onHoldStart={beginHold}
      onHoldEnd={endHold}
      onUseQuill={openQuill}
      onClose={dismiss}
    />
  );
}

// ---------------------------------------------------------------------------
// Sigil layer — the quill + crystal-ball glyphs bloom from the touch point.
// ---------------------------------------------------------------------------

interface SigilLayerProps {
  origin: Origin;
  onQuill: () => void;
  onBall: () => void;
  onDismiss: () => void;
}

function SigilLayer({ origin, onQuill, onBall, onDismiss }: SigilLayerProps) {
  // Bloom the two sigils from the tap point, side by side, clamped to stay on
  // screen near edges.
  const spread = 64; // px from centre to each sigil
  const margin = 56;
  const cx = Math.max(margin + spread, Math.min(window.innerWidth - margin - spread, origin.x));
  const cy = Math.max(margin, Math.min(window.innerHeight - margin, origin.y));

  const scrim: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 25,
    background: "transparent",
  };

  const sigilBtn: CSSProperties = {
    position: "absolute",
    width: 66,
    height: 66,
    transform: "translate(-50%, -50%)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space(1),
    borderRadius: "50%",
    border: `1px solid ${palette.ash}`,
    background: `radial-gradient(circle, ${palette.ink} 0%, ${palette.nearBlack} 100%)`,
    boxShadow: `0 0 22px 4px ${palette.ember}33`,
    cursor: "pointer",
    color: palette.parchment,
  };

  // The wax seal rides just below the two sigils as the recipient marker.
  const sealWrap: CSSProperties = {
    position: "absolute",
    left: cx,
    top: cy + 62,
    transform: "translateX(-50%)",
    display: "flex",
    alignItems: "center",
    gap: space(2),
    padding: `${space(1)} ${space(3)}`,
    borderRadius: "999px",
    background: `${palette.ink}cc`,
    border: `1px solid ${palette.ash}`,
    color: palette.parchmentDim,
    fontSize: 12,
    letterSpacing: "0.04em",
    whiteSpace: "nowrap",
  };

  return (
    <div
      style={scrim}
      onPointerDown={onDismiss}
      role="button"
      aria-label="Dismiss"
    >
      <button
        type="button"
        className="mi-sigil-bloom"
        aria-label="Write to the Game Master (quill)"
        style={{ ...sigilBtn, left: cx - spread, top: cy }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onQuill();
        }}
      >
        <QuillGlyph />
      </button>

      <button
        type="button"
        className="mi-sigil-bloom"
        aria-label="Speak to the Game Master (crystal ball)"
        style={{ ...sigilBtn, left: cx + spread, top: cy }}
        onPointerDown={(e) => {
          e.stopPropagation();
          onBall();
        }}
      >
        <BallGlyph />
      </button>

      <div className="mi-sigil-bloom" style={sealWrap} aria-hidden="true">
        <WaxSeal size={22} />
        <span>to the GM</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compose surface — a parchment-styled panel with a textarea + send. This is an
// explicit input surface, so legible text + controls are allowed (DESIGN.md).
// ---------------------------------------------------------------------------

interface ComposeSurfaceProps {
  draft: string;
  sending: boolean;
  toast: Toast | null;
  onChange: (v: string) => void;
  onSend: () => void;
  onClose: () => void;
}

function ComposeSurface({
  draft,
  sending,
  toast,
  onChange,
  onSend,
  onClose,
}: ComposeSurfaceProps) {
  const canSend = draft.trim().length > 0 && !sending;
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Focus the textarea once the surface has mounted + begun animating in.
  useEffect(() => {
    const t = window.setTimeout(() => textareaRef.current?.focus(), 60);
    return () => window.clearTimeout(t);
  }, []);

  const scrim: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: space(4),
    background: "radial-gradient(ellipse at center, rgba(0,0,0,.5) 0%, rgba(0,0,0,.8) 100%)",
  };

  const panel: CSSProperties = {
    width: "100%",
    maxWidth: 460,
    display: "flex",
    flexDirection: "column",
    gap: space(3),
    padding: `${space(4)} ${space(4)} ${space(5)}`,
    borderRadius: "12px",
    // A warm parchment-ink panel (the page turned up to write).
    background: `linear-gradient(${palette.parchment}, ${palette.parchmentDim})`,
    boxShadow: "0 24px 58px rgba(0,0,0,.7)",
    color: palette.ink,
  };

  const topRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  };

  const sealRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: space(2),
    fontSize: 13,
    color: palette.emberDim,
    letterSpacing: "0.03em",
  };

  const closeBtn: CSSProperties = {
    background: "transparent",
    border: "none",
    color: palette.ink,
    fontSize: 22,
    lineHeight: 1,
    cursor: "pointer",
    padding: space(1),
  };

  const textareaStyle: CSSProperties = {
    width: "100%",
    minHeight: 96,
    resize: "none",
    background: "rgba(255,255,255,0.35)",
    border: `1px solid ${palette.emberDim}55`,
    borderRadius: "8px",
    color: palette.ink,
    font: "inherit",
    fontFamily: "'IM Fell English', Georgia, serif",
    fontSize: 18,
    lineHeight: 1.5,
    padding: `${space(3)} ${space(3)}`,
  };

  const sendBtn: CSSProperties = {
    alignSelf: "flex-end",
    background: canSend ? palette.emberDim : "transparent",
    border: `1px solid ${canSend ? palette.ember : palette.emberDim + "66"}`,
    borderRadius: "8px",
    color: canSend ? palette.bone : palette.emberDim,
    cursor: canSend ? "pointer" : "default",
    font: "inherit",
    fontSize: 15,
    fontWeight: 600,
    letterSpacing: "0.04em",
    padding: `${space(2)} ${space(5)}`,
    transition: "background .2s, color .2s, border-color .2s",
  };

  const toastStyle: CSSProperties = {
    fontSize: 14,
    color: palette.emberDim,
    minHeight: 18,
    textAlign: "center",
  };

  return (
    <div style={scrim} onPointerDown={onClose}>
      <div
        className="mi-surface-in"
        style={panel}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div style={topRow}>
          <div style={sealRow}>
            <WaxSeal size={26} />
            <span>to the Game Master</span>
          </div>
          <button type="button" aria-label="Close" style={closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        <textarea
          ref={textareaRef}
          className="mi-input-textarea"
          aria-label="Message to the Game Master"
          style={textareaStyle}
          value={draft}
          maxLength={2000}
          placeholder="write to the GM…"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            // ⌘/Ctrl+Enter sends; plain Enter inserts a newline.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSend();
            }
          }}
        />

        <button type="button" style={sendBtn} disabled={!canSend} onClick={onSend}>
          {sending ? "sending…" : "send"}
        </button>

        <div aria-live="polite" role="status" style={toastStyle}>
          {toast?.text ?? ""}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PTT surface — press-and-hold the crystal ball to talk. While the mic is live a
// "● recording" indicator is visible and the screen thrums (INVIOLABLE D10).
// ---------------------------------------------------------------------------

interface PttSurfaceProps {
  recording: boolean;
  sending: boolean;
  voiceBlocked: boolean;
  toast: Toast | null;
  onHoldStart: (e: ReactPointerEvent) => void;
  onHoldEnd: () => void;
  onUseQuill: () => void;
  onClose: () => void;
}

function PttSurface({
  recording,
  sending,
  voiceBlocked,
  toast,
  onHoldStart,
  onHoldEnd,
  onUseQuill,
  onClose,
}: PttSurfaceProps) {
  const scrim: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 50,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: space(5),
    padding: space(5),
    // While holding, the rest of the screen dims/thrums; otherwise a soft scrim.
    background: recording
      ? "radial-gradient(ellipse at center, rgba(0,0,0,.35) 0%, rgba(0,0,0,.92) 100%)"
      : "radial-gradient(ellipse at center, rgba(0,0,0,.45) 0%, rgba(0,0,0,.82) 100%)",
    transition: "background .25s",
  };

  // The recipient marker rides at the top.
  const sealRow: CSSProperties = {
    position: "absolute",
    top: space(7),
    display: "flex",
    alignItems: "center",
    gap: space(2),
    padding: `${space(1)} ${space(3)}`,
    borderRadius: "999px",
    background: `${palette.ink}cc`,
    border: `1px solid ${palette.ash}`,
    color: palette.parchmentDim,
    fontSize: 12,
    letterSpacing: "0.04em",
  };

  const closeBtn: CSSProperties = {
    position: "absolute",
    top: space(5),
    right: space(5),
    background: "transparent",
    border: "none",
    color: palette.parchmentDim,
    fontSize: 26,
    lineHeight: 1,
    cursor: "pointer",
    padding: space(2),
  };

  const ballBtn: CSSProperties = {
    width: 168,
    height: 168,
    borderRadius: "50%",
    border: `1px solid ${recording ? palette.ember : palette.ash}`,
    background: `radial-gradient(circle at 38% 32%, ${palette.parchment}22 0%, ${palette.emberDim}66 38%, ${palette.ink} 100%)`,
    boxShadow: recording ? undefined : `0 0 28px 6px ${palette.ember}33`,
    cursor: voiceBlocked ? "default" : "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    touchAction: "none", // we own the press; don't let the browser scroll/zoom
    userSelect: "none",
    WebkitUserSelect: "none",
    opacity: voiceBlocked ? 0.4 : 1,
  };

  const recIndicator: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: space(2),
    color: palette.bone,
    fontSize: 15,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    minHeight: 22,
  };

  const recDot: CSSProperties = {
    width: 12,
    height: 12,
    borderRadius: "50%",
    background: "#ff3b30",
    boxShadow: "0 0 10px 2px #ff3b30aa",
  };

  const hintStyle: CSSProperties = {
    color: palette.parchmentDim,
    fontSize: 14,
    letterSpacing: "0.04em",
    textAlign: "center",
    minHeight: 20,
  };

  // --- graceful degradation: voice unavailable → offer the quill (D10). ---
  if (voiceBlocked) {
    const fallbackBtn: CSSProperties = {
      display: "flex",
      alignItems: "center",
      gap: space(2),
      background: palette.emberDim,
      border: `1px solid ${palette.ember}`,
      borderRadius: "10px",
      color: palette.bone,
      cursor: "pointer",
      font: "inherit",
      fontSize: 15,
      fontWeight: 600,
      padding: `${space(3)} ${space(5)}`,
    };
    return (
      <div className="mi-fade-in" style={scrim} onPointerDown={onClose}>
        <button type="button" aria-label="Close" style={closeBtn} onClick={onClose}>
          ×
        </button>
        <p style={{ ...hintStyle, color: palette.parchment, fontSize: 16, maxWidth: 300 }}>
          Voice isn’t available — use the quill.
        </p>
        <button
          type="button"
          style={fallbackBtn}
          onPointerDown={(e) => {
            e.stopPropagation();
            onUseQuill();
          }}
        >
          <QuillGlyph size={22} />
          <span>write instead</span>
        </button>
      </div>
    );
  }

  return (
    <div className="mi-fade-in" style={scrim} onPointerDown={onClose}>
      <div style={sealRow} aria-hidden="true">
        <WaxSeal size={20} />
        <span>to the GM</span>
      </div>
      <button type="button" aria-label="Close" style={closeBtn} onClick={onClose}>
        ×
      </button>

      {/* The REQUIRED visible recording indicator (D10): on screen the entire
          time the mic is live. A pulsing red dot + the word "recording". */}
      <div style={recIndicator} aria-live="assertive" role="status">
        {recording ? (
          <>
            <span className="mi-rec-dot" style={recDot} aria-hidden="true" />
            <span>recording</span>
          </>
        ) : (
          <span aria-hidden="true">&nbsp;</span>
        )}
      </div>

      <button
        type="button"
        className={recording ? "mi-ball-live" : undefined}
        aria-label="Hold to talk to the Game Master"
        aria-pressed={recording}
        style={ballBtn}
        onPointerDown={(e) => {
          e.stopPropagation();
          onHoldStart(e);
        }}
        onPointerUp={(e) => {
          e.stopPropagation();
          onHoldEnd();
        }}
        // Releasing OR the pointer leaving the element stops + sends (and, via
        // pointer capture in beginHold, we still receive the up if it slid off).
        onPointerLeave={onHoldEnd}
        onPointerCancel={onHoldEnd}
        onContextMenu={(e) => e.preventDefault()}
      >
        <BallGlyph size={56} />
      </button>

      <p style={hintStyle}>
        {recording
          ? "release to send"
          : sending
            ? "sending…"
            : "hold to talk"}
      </p>

      <div aria-live="polite" role="status" style={{ ...hintStyle, minHeight: 18 }}>
        {toast?.text ?? ""}
      </div>
    </div>
  );
}
