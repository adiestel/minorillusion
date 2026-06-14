/**
 * Stage — the GM's live canvas of connected clients (full-fidelity mirror).
 *
 * Each player is a draggable "phone" tile whose screen is an <iframe> running the
 * player app in MIRROR mode (/mirror.html) — the REAL PWA components (ambiance,
 * torn parchment, lightning, heartbeat, the breathing ember), silent and read-
 * only. So a tile is a true pixel mirror of what that player sees, not a
 * lookalike. We feed each iframe the same per-player effect stream via
 * postMessage:
 *   • scene (from effects:active, authoritative) → mi-scene
 *   • transient effects (from effect:mirror)     → mi-effect
 * The iframe renders at the device's native viewport size and is scaled to fit
 * the tile, so the aspect ratio and layout match the real device exactly.
 *
 * Tiles sit around a faint table ring (the hearth); drag to arrange — layout
 * persists per circle. Only connected clients are shown.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ActiveEffects as ActiveEffectsPayload,
  AmbianceScene,
  Circle,
  EffectMirror,
  Player,
  Target,
  Viewport,
  WhisperProgress,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

// The player app's mirror entry (a sibling deploy in prod; localhost:5174 dev).
const PLAYER_BASE =
  (import.meta.env.VITE_PLAYER_URL as string | undefined) ?? "http://localhost:5174";
const MIRROR_URL = `${PLAYER_BASE.replace(/\/$/, "")}/mirror.html`;
const MIRROR_ORIGIN = new URL(MIRROR_URL).origin;

// ---------------------------------------------------------------------------
// Geometry — each tile is sized to its player's REAL viewport (aspect ratio +
// a gentle relative size). A player that hasn't reported one falls back to a
// typical phone.
// ---------------------------------------------------------------------------

const LABEL_H = 22; // the name label strip below the screen (px)
const DEFAULT_VP: Viewport = { width: 390, height: 844 };
const BOX_W = 116;
const BOX_H = 150;

/** Screen size (px) for a tile: fit the viewport rect into the box, preserving
 *  aspect ratio, then scale gently by the device's larger dimension. */
function screenDims(vp: Viewport | undefined): { w: number; h: number } {
  const v = vp ?? DEFAULT_VP;
  const aspect = v.width / v.height;
  const scale = clamp(Math.max(v.width, v.height) / 900, 0.82, 1.3);
  const boxW = BOX_W * scale;
  const boxH = BOX_H * scale;
  let h = boxH;
  let w = h * aspect;
  if (w > boxW) {
    w = boxW;
    h = w / aspect;
  }
  return { w: Math.round(w), h: Math.round(h) };
}

/** Full tile box (the screen plus its name label) — used for layout + clamping. */
function tileBox(vp: Viewport | undefined): { w: number; h: number } {
  const s = screenDims(vp);
  return { w: s.w, h: s.h + LABEL_H };
}

// ---------------------------------------------------------------------------
// Layout persistence (fractions of the usable canvas, 0..1)
// ---------------------------------------------------------------------------

interface Frac {
  fx: number;
  fy: number;
}
type Layout = Record<string, Frac>;

function layoutKey(circleId: string): string {
  return `mi.gm.stage.${circleId}`;
}
function loadLayout(circleId: string): Layout {
  try {
    const raw = localStorage.getItem(layoutKey(circleId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Layout;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveLayout(circleId: string, layout: Layout): void {
  try {
    localStorage.setItem(layoutKey(circleId), JSON.stringify(layout));
  } catch {
    /* storage unavailable */
  }
}
/** Auto-place the i-th of n players around the table (an ellipse), clamped. */
function autoPlace(i: number, n: number): Frac {
  if (n <= 1) return { fx: 0.5, fy: 0.46 };
  const theta = -Math.PI / 2 + (i / n) * Math.PI * 2;
  return {
    fx: clamp01(0.5 + 0.34 * Math.cos(theta)),
    fy: clamp01(0.5 + 0.38 * Math.sin(theta)),
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
function clampPx(v: number, max: number): number {
  return Math.min(Math.max(0, v), Math.max(0, max));
}

function targetCovers(target: Target, playerId: string): boolean {
  return target.kind === "broadcast" || target.playerIds.includes(playerId);
}

// ---------------------------------------------------------------------------
// Canvas size hook
// ---------------------------------------------------------------------------

function useElementSize<T extends HTMLElement>(ref: React.RefObject<T | null>) {
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

// ---------------------------------------------------------------------------
// Stage — derives the authoritative ambiance scene per player from
// effects:active, then renders the (presentation-only) StageCanvas.
// ---------------------------------------------------------------------------

export type SceneMap = Record<string, AmbianceScene>;
export type WhisperMap = Record<string, WhisperProgress | undefined>;

interface StageProps {
  circle: Circle;
  players: Player[];
}

export function Stage({ circle, players }: StageProps) {
  const [sceneByPlayer, setSceneByPlayer] = useState<SceneMap>({});
  const [whisperByPlayer, setWhisperByPlayer] = useState<WhisperMap>({});

  useEffect(() => {
    function onActive(payload: ActiveEffectsPayload) {
      if (payload.circleId !== circle.id) return;
      const ambiances = payload.effects.filter(
        (e) => e.kind === "ambiance" && e.scene,
      );
      // Whisperscapes carrying live phrase progress, for the per-tile badge.
      const whispers = payload.effects.filter((e) => e.whisper);
      setSceneByPlayer(() => {
        const next: SceneMap = {};
        for (const p of players) {
          let scene: AmbianceScene = "clear";
          for (const a of ambiances) {
            if (a.scene && targetCovers(a.target, p.id)) scene = a.scene;
          }
          next[p.id] = scene;
        }
        return next;
      });
      setWhisperByPlayer(() => {
        const next: WhisperMap = {};
        for (const p of players) {
          for (const w of whispers) {
            if (targetCovers(w.target, p.id)) next[p.id] = w.whisper;
          }
        }
        return next;
      });
    }
    socket.on("effects:active", onActive);
    return () => {
      socket.off("effects:active", onActive);
    };
  }, [circle.id, players]);

  return (
    <StageCanvas
      circleId={circle.id}
      players={players}
      sceneByPlayer={sceneByPlayer}
      whisperByPlayer={whisperByPlayer}
    />
  );
}

// ---------------------------------------------------------------------------
// StageCanvas — the table, draggable tiles, and layout. Driven by props so it
// can be previewed with mock data (preview.tsx).
// ---------------------------------------------------------------------------

export interface StageCanvasProps {
  circleId: string;
  players: Player[];
  sceneByPlayer: SceneMap;
  whisperByPlayer?: WhisperMap;
}

export function StageCanvas({
  circleId,
  players,
  sceneByPlayer,
  whisperByPlayer = {},
}: StageCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const { w, h } = useElementSize(canvasRef);

  // Only connected clients appear on the table.
  const shown = useMemo(() => players.filter((p) => p.connected), [players]);

  // Per-player tile box (from each connected player's reported viewport).
  const dimsByPlayer = useMemo(() => {
    const m = new Map<string, { w: number; h: number }>();
    for (const p of shown) m.set(p.id, tileBox(p.viewport));
    return m;
  }, [shown]);
  const dimsRef = useRef(dimsByPlayer);
  dimsRef.current = dimsByPlayer;
  const boxOf = (id: string) => dimsRef.current.get(id) ?? tileBox(undefined);

  // --- Layout ---
  const [layout, setLayout] = useState<Layout>(() => loadLayout(circleId));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  useEffect(() => {
    setLayout(loadLayout(circleId));
  }, [circleId]);

  useEffect(() => {
    const current = layoutRef.current;
    const missing = shown.filter((p) => current[p.id] === undefined);
    if (missing.length === 0) return;
    const n = shown.length;
    const next: Layout = { ...current };
    shown.forEach((p, i) => {
      if (next[p.id] === undefined) next[p.id] = autoPlace(i, n);
    });
    setLayout(next);
    saveLayout(circleId, next);
  }, [shown, circleId]);

  // --- Dragging ---
  const dragState = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const onTilePointerDown = useCallback((e: React.PointerEvent, playerId: string) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const frac = layoutRef.current[playerId] ?? { fx: 0.5, fy: 0.5 };
    const box = dimsRef.current.get(playerId) ?? tileBox(undefined);
    const left = frac.fx * Math.max(1, rect.width - box.w);
    const top = frac.fy * Math.max(1, rect.height - box.h);
    dragState.current = {
      id: playerId,
      dx: e.clientX - rect.left - left,
      dy: e.clientY - rect.top - top,
    };
    setDraggingId(playerId);
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }, []);

  const onTilePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragState.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const box = dimsRef.current.get(drag.id) ?? tileBox(undefined);
    const left = clampPx(e.clientX - rect.left - drag.dx, rect.width - box.w);
    const top = clampPx(e.clientY - rect.top - drag.dy, rect.height - box.h);
    setLayout((prev) => ({
      ...prev,
      [drag.id]: {
        fx: left / Math.max(1, rect.width - box.w),
        fy: top / Math.max(1, rect.height - box.h),
      },
    }));
  }, []);

  const endDrag = useCallback(() => {
    if (!dragState.current) return;
    dragState.current = null;
    setDraggingId(null);
    saveLayout(circleId, layoutRef.current);
  }, [circleId]);

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h2 style={headingStyle}>The table</h2>
        <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
          drag to arrange · {shown.length} live
        </span>
      </div>

      <div
        ref={canvasRef}
        style={canvasStyle}
        onPointerMove={onTilePointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
      >
        <div style={tableRingStyle} aria-hidden="true" />

        {shown.length === 0 ? (
          <p style={emptyHintStyle}>Waiting for players to join…</p>
        ) : (
          shown.map((p) => {
            const frac = layout[p.id] ?? { fx: 0.5, fy: 0.5 };
            const box = dimsByPlayer.get(p.id) ?? tileBox(undefined);
            const screen = screenDims(p.viewport);
            return (
              <PhoneTile
                key={p.id}
                player={p}
                scene={sceneByPlayer[p.id] ?? "clear"}
                whisper={whisperByPlayer[p.id]}
                screenW={screen.w}
                screenH={screen.h}
                left={frac.fx * Math.max(0, w - box.w)}
                top={frac.fy * Math.max(0, h - box.h)}
                dragging={draggingId === p.id}
                onPointerDown={(e) => onTilePointerDown(e, p.id)}
              />
            );
          })
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// PhoneTile — a draggable phone whose screen is the real player app in mirror
// mode (an iframe), fed scene + transient effects via postMessage.
// ---------------------------------------------------------------------------

interface PhoneTileProps {
  player: Player;
  scene: AmbianceScene;
  whisper?: WhisperProgress;
  screenW: number;
  screenH: number;
  left: number;
  top: number;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}

function PhoneTile({
  player,
  scene,
  whisper,
  screenW,
  screenH,
  left,
  top,
  dragging,
  onPointerDown,
}: PhoneTileProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [ready, setReady] = useState(false);

  const vp = player.viewport ?? DEFAULT_VP;
  const scale = screenW / vp.width; // aspect-preserved, so == screenH / vp.height

  const post = useCallback((msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, MIRROR_ORIGIN);
  }, []);

  // The iframe announces itself ready (its message listener is live).
  useEffect(() => {
    function onReady(ev: MessageEvent) {
      if (
        ev.source &&
        ev.source === iframeRef.current?.contentWindow &&
        (ev.data as { type?: string } | undefined)?.type === "mi-ready"
      ) {
        setReady(true);
      }
    }
    window.addEventListener("message", onReady);
    return () => window.removeEventListener("message", onReady);
  }, []);

  // Push the authoritative scene whenever it changes (and once ready).
  useEffect(() => {
    if (ready) post({ type: "mi-scene", scene });
  }, [ready, scene, post]);

  // Forward this player's transient effects (flash / heartbeat / message) into
  // the mirror. Ambiance is handled via the scene above; audio/haptic have no
  // visual on the player, so the mirror ignores them too.
  useEffect(() => {
    function onMirror({ playerIds, effect }: EffectMirror) {
      if (!playerIds.includes(player.id)) return;
      if (effect.kind === "ambiance") return;
      post({ type: "mi-effect", effect });
    }
    socket.on("effect:mirror", onMirror);
    return () => {
      socket.off("effect:mirror", onMirror);
    };
  }, [player.id, post]);

  // When this player dismisses (acks) a message on their real device, clear it
  // in the mirror too — the mirror can't be tapped, so it would otherwise linger.
  useEffect(() => {
    function onAcked({ effectId, playerId }: { effectId: string; playerId: string }) {
      if (playerId !== player.id) return;
      post({ type: "mi-ack", effectId });
    }
    socket.on("effect:acked", onAcked);
    return () => {
      socket.off("effect:acked", onAcked);
    };
  }, [player.id, post]);

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left,
        top,
        width: screenW,
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
        userSelect: "none",
        zIndex: dragging ? 5 : 2,
        transition: dragging ? "none" : "left 0.12s ease, top 0.12s ease",
      }}
    >
      {/* The phone screen — the real player app, scaled to the tile. */}
      <div
        style={{
          position: "relative",
          width: screenW,
          height: screenH,
          borderRadius: Math.max(8, Math.round(Math.min(screenW, screenH) * 0.12)),
          overflow: "hidden",
          background: palette.nearBlack,
          border: `1.5px solid ${palette.ash}`,
          boxShadow: dragging ? "0 10px 24px rgba(0,0,0,0.5)" : "0 3px 10px rgba(0,0,0,0.35)",
        }}
      >
        <iframe
          ref={iframeRef}
          src={MIRROR_URL}
          title={`${player.name} screen`}
          tabIndex={-1}
          scrolling="no"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: vp.width,
            height: vp.height,
            border: "none",
            transform: `scale(${scale})`,
            transformOrigin: "top left",
            pointerEvents: "none", // a mirror — never interactive
            background: palette.nearBlack,
          }}
        />
        {/* Whisperscape badge — the phrase this phone is hearing + its progress.
            The mirror is silent, so this is the only sign a whisper is sounding. */}
        {whisper && (
          <div style={whisperBadgeStyle}>
            <span
              style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              title={whisper.phrase}
            >
              “{whisper.phrase}”
            </span>
            <span style={{ flexShrink: 0, fontStyle: "normal", opacity: 0.85, fontVariantNumeric: "tabular-nums" }}>
              {whisper.index + 1}/{whisper.total}
            </span>
          </div>
        )}
      </div>

      {/* Name label */}
      <div
        style={{
          height: LABEL_H,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: space(1),
          fontSize: "0.72rem",
          color: "var(--text)",
          fontWeight: 600,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: palette.ember,
            flexShrink: 0,
          }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{player.name}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const headingStyle: React.CSSProperties = {
  margin: 0,
  fontSize: "0.78rem",
  fontWeight: 700,
  letterSpacing: "0.12em",
  textTransform: "uppercase",
  color: palette.parchmentDim,
};

const canvasStyle: React.CSSProperties = {
  position: "relative",
  width: "100%",
  height: "min(62vh, 560px)",
  minHeight: 360,
  background:
    "radial-gradient(ellipse at 50% 50%, #161210 0%, #100d0b 70%, #0b0908 100%)",
  border: `1px solid ${palette.ash}`,
  borderRadius: radius.md,
  overflow: "hidden",
  touchAction: "none",
};

const tableRingStyle: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  width: "46%",
  height: "42%",
  transform: "translate(-50%, -50%)",
  borderRadius: "50%",
  border: `1px solid ${palette.ash}`,
  background: `radial-gradient(ellipse at 50% 50%, ${palette.ember}14 0%, transparent 62%)`,
  boxShadow: "inset 0 0 40px rgba(0,0,0,0.4)",
};

const whisperBadgeStyle: React.CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 5px",
  background: "linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0))",
  color: palette.ember,
  fontSize: 9,
  lineHeight: 1.25,
  fontStyle: "italic",
  pointerEvents: "none",
  zIndex: 1,
};

const emptyHintStyle: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  transform: "translate(-50%, -50%)",
  margin: 0,
  fontSize: "0.9rem",
  color: "var(--text-dim)",
};
