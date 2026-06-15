/**
 * LogHistory — the chronicle (M7; docs/M7-PLAN.md item 3, DECISIONS D9).
 *
 * Players own a persistent history of the session summaries the GM delivers to
 * them ("chronicles"). This is the player-side view of that history. It is a
 * MENU / LIMINAL surface, NOT the immersive canvas — so legible text + chrome
 * are allowed here (DESIGN.md: "controls live only on explicit menu/liminal
 * surfaces"), exactly like the compose/PTT surfaces and the consent sheet.
 *
 * Two pieces, both rendered only while joined (wired in main.tsx):
 *
 *   1. A small, unobtrusive, DIEGETIC affordance on the resting canvas — a book/
 *      scroll glyph tucked into the bottom-left corner (the safe-area corner the
 *      recording indicator and the rest leave free). Tapping it opens the
 *      chronicle. A gentle ember glow rides the glyph when a new chronicle has
 *      arrived but not yet been opened (the "a new chronicle arrived" cue).
 *
 *   2. The chronicle panel — a full-screen liminal surface listing the delivered
 *      chronicles as parchment entries (title + text + date), newest first.
 *      Fetched lazily via socket.emit("player:logs", cb) when first opened, then
 *      kept live: main.tsx prepends any log:receive into the same list and the
 *      panel re-renders. Closing returns to the resting ember.
 *
 * Layering (among the existing overlays — ambiance z0, ember z1, idle-catcher
 * z20, sigils z25, Flash z45, RecordingIndicator z46, PlayerInput surfaces z50,
 * RollReveal z55, ParchmentMessage scrim z60, AudioUnlockModal z100):
 *   • the corner glyph affordance  z30  (above the PlayerInput idle tap-catcher
 *                                        z20 so it stays tappable, below every
 *                                        transient overlay — a delivered message
 *                                        / roll / flash always covers it)
 *   • the open chronicle panel     z58  (a liminal menu surface, above the input
 *                                        surfaces + roll, but BELOW the parchment
 *                                        scrim z60 and the audio modal z100 so a
 *                                        freshly delivered message or the sound-
 *                                        unlock prompt still wins over the menu)
 *
 * It never overlaps the safety affordances: the corner glyph sits bottom-left,
 * clear of the top-centre recording indicator; the panel is below the parchment
 * scrim and the audio-unlock modal, so neither a delivered message nor the mic/
 * recording surfaces are ever blocked by an open chronicle.
 *
 * Cheap DOM/CSS path (D7): inline SVG glyph, the shared parchment texture for
 * entries, transform/opacity transitions only.
 */

import { CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import type { PlayerLog, PlayerLogs } from "@minorillusion/contract";
import { palette, space } from "@minorillusion/design-system";

import { socket } from "./socket";

const PARCHMENT_URL = "/textures/parchment.jpg";

// ---------------------------------------------------------------------------
// One-time style injection (panel slide-in, the affordance "new" glow pulse).
// ---------------------------------------------------------------------------

function injectStyles(): void {
  if (document.getElementById("mi-log-styles")) return;
  const style = document.createElement("style");
  style.id = "mi-log-styles";
  style.textContent = `
    @keyframes mi-log-scrim-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes mi-log-panel-in {
      from { opacity: 0; transform: translateY(18px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    /* A slow warm pulse on the glyph while an unread chronicle waits. */
    @keyframes mi-log-glow {
      0%, 100% { box-shadow: 0 0 0 0 ${palette.ember}00; border-color: ${palette.ash}; }
      50%      { box-shadow: 0 0 18px 4px ${palette.ember}88; border-color: ${palette.ember}; }
    }

    .mi-log-scrim   { animation: mi-log-scrim-in .3s ease forwards; }
    .mi-log-panel   { animation: mi-log-panel-in .34s cubic-bezier(.16,.8,.3,1) forwards; }
    .mi-log-glow    { animation: mi-log-glow 2.6s ease-in-out infinite; }

    @media (prefers-reduced-motion: reduce) {
      .mi-log-glow { animation: none; border-color: ${palette.ember}; box-shadow: 0 0 14px 3px ${palette.ember}88; }
    }
  `;
  document.head.appendChild(style);
}

// ---------------------------------------------------------------------------
// Glyph — a restrained open-book / tome sigil in the ember palette (cheap path).
// ---------------------------------------------------------------------------

function BookGlyph({ size = 24 }: { size?: number }) {
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
      {/* an open tome */}
      <path
        d="M12 6.5C10.5 5.4 8.5 5 6 5H3v12h3c2.5 0 4.5.5 6 1.6"
        fill={palette.ember}
        fillOpacity="0.12"
      />
      <path
        d="M12 6.5C13.5 5.4 15.5 5 18 5h3v12h-3c-2.5 0-4.5.5-6 1.6"
        fill={palette.ember}
        fillOpacity="0.12"
      />
      <path d="M12 6.5v12" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Date formatting — a quiet, human "when" for each chronicle entry.
// ---------------------------------------------------------------------------

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return d.toDateString();
  }
}

// ---------------------------------------------------------------------------
// The corner affordance — opens the chronicle; glows when a chronicle is unread.
// ---------------------------------------------------------------------------

interface LogAffordanceProps {
  /** Pulse the glyph (a chronicle arrived and hasn't been opened since). */
  unread: boolean;
  /** Open the chronicle panel. */
  onOpen: () => void;
}

export function LogAffordance({ unread, onOpen }: LogAffordanceProps) {
  useEffect(() => {
    injectStyles();
  }, []);

  // Bottom-left, safe-area aware — clear of the top-centre recording indicator
  // and the rest of the (empty) resting canvas. z30: above the PlayerInput idle
  // tap-catcher (z20) so it stays tappable, below every transient overlay.
  const wrapStyle: CSSProperties = {
    position: "fixed",
    left: "calc(env(safe-area-inset-left, 0px) + 14px)",
    bottom: "calc(env(safe-area-inset-bottom, 0px) + 14px)",
    zIndex: 30,
  };

  const btnStyle: CSSProperties = {
    width: 44,
    height: 44,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "50%",
    border: `1px solid ${palette.ash}`,
    background: `radial-gradient(circle, ${palette.ink} 0%, ${palette.nearBlack} 100%)`,
    color: palette.parchment,
    cursor: "pointer",
    // A faint resting presence so it reads as "tuck-away", not chrome.
    opacity: 0.62,
    transition: "opacity .25s",
    WebkitTapHighlightColor: "transparent",
  };

  return (
    <div style={wrapStyle}>
      <button
        type="button"
        className={unread ? "mi-log-glow" : undefined}
        style={unread ? { ...btnStyle, opacity: 1 } : btnStyle}
        aria-label={unread ? "Open your chronicle (a new chronicle arrived)" : "Open your chronicle"}
        onClick={onOpen}
      >
        <BookGlyph />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The chronicle panel — the liminal menu surface listing delivered chronicles.
// ---------------------------------------------------------------------------

interface LogPanelProps {
  /** The player's chronicles, newest-first (owned by main.tsx). */
  logs: PlayerLog[];
  /** True while the initial fetch is in flight (no logs loaded yet). */
  loading: boolean;
  /** Close the panel, returning to the resting ember. */
  onClose: () => void;
}

export function LogPanel({ logs, loading, onClose }: LogPanelProps) {
  useEffect(() => {
    injectStyles();
  }, []);

  const scrim: CSSProperties = {
    position: "fixed",
    inset: 0,
    zIndex: 58,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    background: "radial-gradient(ellipse at center, rgba(0,0,0,.62) 0%, rgba(0,0,0,.9) 100%)",
  };

  const panel: CSSProperties = {
    position: "relative",
    width: "100%",
    maxWidth: 560,
    height: "100%",
    display: "flex",
    flexDirection: "column",
    paddingTop: "calc(env(safe-area-inset-top, 0px) + 18px)",
    paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 18px)",
    paddingLeft: space(4),
    paddingRight: space(4),
  };

  const header: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: space(3),
    paddingBottom: space(4),
  };

  const titleRow: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: space(3),
  };

  const titleStyle: CSSProperties = {
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: palette.bone,
  };

  const closeBtn: CSSProperties = {
    background: "transparent",
    border: `1px solid ${palette.ash}`,
    borderRadius: "999px",
    color: palette.parchmentDim,
    fontSize: 22,
    lineHeight: 1,
    cursor: "pointer",
    width: 38,
    height: 38,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  };

  const list: CSSProperties = {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: space(4),
    WebkitOverflowScrolling: "touch",
  };

  const emptyStyle: CSSProperties = {
    flex: 1,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    textAlign: "center",
    color: palette.parchmentDim,
    fontSize: 15,
    lineHeight: 1.6,
    padding: space(6),
  };

  return (
    <div className="mi-log-scrim" style={scrim} onPointerDown={onClose}>
      <div
        className="mi-log-panel"
        style={panel}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Your chronicle"
      >
        <div style={header}>
          <div style={titleRow}>
            <BookGlyph size={22} />
            <span style={titleStyle}>your chronicle</span>
          </div>
          <button type="button" aria-label="Close" style={closeBtn} onClick={onClose}>
            ×
          </button>
        </div>

        {loading && logs.length === 0 ? (
          <div style={emptyStyle}>gathering your chronicle…</div>
        ) : logs.length === 0 ? (
          <div style={emptyStyle}>
            Nothing written yet. When a session ends, its chronicle will appear here.
          </div>
        ) : (
          <div style={list}>
            {logs.map((log) => (
              <LogEntry key={log.id} log={log} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// A single chronicle — a parchment-styled entry (title + text + date).
// ---------------------------------------------------------------------------

function LogEntry({ log }: { log: PlayerLog }) {
  const card: CSSProperties = {
    position: "relative",
    borderRadius: "10px",
    padding: `${space(5)} ${space(5)}`,
    color: "#241608",
    // The shared warm parchment texture (the cheap-path page), with a soft inner
    // vignette so long text stays legible toward the edges.
    background: `
      radial-gradient(ellipse at center, transparent 45%, rgba(35,20,8,.34) 100%),
      url('${PARCHMENT_URL}') center / cover`,
    boxShadow: "0 12px 30px rgba(0,0,0,.5)",
  };

  const titleStyle: CSSProperties = {
    fontFamily: "'IM Fell English', Georgia, serif",
    fontSize: 20,
    fontWeight: 600,
    lineHeight: 1.3,
    marginBottom: space(2),
    color: "#1c1206",
  };

  const dateStyle: CSSProperties = {
    fontFamily: "'IM Fell English', Georgia, serif",
    fontSize: 12,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: palette.emberDim,
    marginBottom: space(3),
  };

  const bodyStyle: CSSProperties = {
    fontFamily: "'IM Fell English', Georgia, serif",
    fontSize: 16,
    lineHeight: 1.6,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  };

  const when = formatWhen(log.createdAt);

  return (
    <article style={card}>
      {log.title !== undefined && log.title.length > 0 && (
        <h2 style={titleStyle}>{log.title}</h2>
      )}
      {when.length > 0 && <div style={dateStyle}>{when}</div>}
      <p style={bodyStyle}>{log.text}</p>
    </article>
  );
}

// ---------------------------------------------------------------------------
// useChronicle — the hook that owns the player's chronicle state for main.tsx.
//
// Holds the in-memory list (newest-first), the open/closed state, the unread
// cue, and the lazy fetch. It listens for log:receive itself (prepending +
// flagging unread / opening-aware), so main.tsx only has to mount <LogAffordance>
// + <LogPanel> and gate them on `joined`. The list is de-duplicated by id so a
// log that arrives via log:receive AND is later included in a player:logs fetch
// (or vice-versa) never doubles up.
// ---------------------------------------------------------------------------

export interface ChronicleApi {
  logs: PlayerLog[];
  open: boolean;
  loading: boolean;
  /** A delivered chronicle is waiting and hasn't been seen (drives the glow). */
  unread: boolean;
  openPanel: () => void;
  closePanel: () => void;
}

export function useChronicle(joined: boolean): ChronicleApi {
  const [logs, setLogs] = useState<PlayerLog[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [unread, setUnread] = useState(false);
  // Whether we've done the lazy initial fetch yet (per joined session).
  const fetched = useRef(false);
  // Mirror `open` for the log:receive listener (added once) without re-binding.
  const openRef = useRef(open);
  openRef.current = open;

  /** Merge new logs in, newest-first, de-duplicated by id. */
  const mergeLogs = useCallback((incoming: PlayerLog[]) => {
    setLogs((prev) => {
      const byId = new Map<string, PlayerLog>();
      for (const l of [...incoming, ...prev]) byId.set(l.id, l);
      return [...byId.values()].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    });
  }, []);

  // Reset everything when we leave the circle (a fresh join re-fetches).
  useEffect(() => {
    if (joined) return;
    setLogs([]);
    setOpen(false);
    setLoading(false);
    setUnread(false);
    fetched.current = false;
  }, [joined]);

  // Listen for a freshly delivered chronicle: prepend it, and — unless the panel
  // is already open — raise the unread cue (the glyph glows).
  useEffect(() => {
    function onLogReceive(log: PlayerLog) {
      mergeLogs([log]);
      if (!openRef.current) setUnread(true);
    }
    socket.on("log:receive", onLogReceive);
    return () => {
      socket.off("log:receive", onLogReceive);
    };
  }, [mergeLogs]);

  const openPanel = useCallback(() => {
    setOpen(true);
    setUnread(false); // opening clears the "new chronicle" cue
    // Lazy fetch the first time it's opened this session.
    if (!fetched.current) {
      fetched.current = true;
      setLoading(true);
      socket.emit("player:logs", (res: PlayerLogs) => {
        setLoading(false);
        mergeLogs(res.logs);
      });
    }
  }, [mergeLogs]);

  const closePanel = useCallback(() => {
    setOpen(false);
  }, []);

  return { logs, open, loading, unread, openPanel, closePanel };
}
