/**
 * Stage — the GM's live canvas of connected clients (M2 control rework, layout).
 *
 * One draggable "phone" tile per player, each mirroring what that player is
 * actually seeing: the ambiance scene (storm / rain / ember / clear), live storm
 * lightning flashes, and brief pips for heartbeats, sounds, haptics, and messages.
 * The GM drags the tiles to match how the players are sitting — phones arranged
 * around a virtual table (the faint ring at the canvas centre is the hearth).
 *
 * Two data sources, mirroring the player's own dispatch:
 *   • effects:active (authoritative) → each tile's sustained ambiance scene. This
 *     already reconciles stop / replace / reconnect, so the backgrounds stay
 *     correct without extra bookkeeping.
 *   • effect:mirror (fire-and-forget) → the transient overlays: a white flash for
 *     lightning, and short pips for heartbeat / audio / haptic / message. These
 *     auto-expire; the GM never hears the audio (it's a silent visual mirror).
 *
 * Tile positions are stored as fractions of the canvas (resize-stable) and
 * persisted per circle in localStorage, so an arrangement survives a refresh.
 * Cheap DOM/CSS throughout — no WebGL, no animation libraries.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveEffects as ActiveEffectsPayload,
  AmbianceScene,
  Circle,
  EffectMirror,
  MessageMode,
  Player,
  Target,
  Viewport,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

// ---------------------------------------------------------------------------
// Geometry — each tile is sized to its player's *real* viewport (aspect ratio
// + a gentle relative size), so a phone looks like a phone, a tablet bigger and
// squarer, a desktop window wide. A player that hasn't reported a viewport falls
// back to a typical phone.
// ---------------------------------------------------------------------------

const LABEL_H = 22; // the name label strip below the screen (px)
const DEFAULT_VP: Viewport = { width: 390, height: 844 }; // typical phone

// The bounding box a tile's screen is fit into, before relative-size scaling.
const BOX_W = 116;
const BOX_H = 150;

/** Screen size (px) for a tile: fit the viewport rect into the box, preserving
 *  aspect ratio, then scale gently by the device's larger dimension. */
function screenDims(vp: Viewport | undefined): { w: number; h: number } {
  const v = vp ?? DEFAULT_VP;
  const aspect = v.width / v.height;
  // Gentle relative size: a small phone ~0.85×, a big tablet/desktop up to ~1.3×.
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

// Transient overlay lifetimes (ms) — how long a mirrored pip lingers on a tile.
const FLASH_MS = 950;
const PIP_MS = 1600;

// ---------------------------------------------------------------------------
// Per-tile transient state (driven by effect:mirror)
// ---------------------------------------------------------------------------

interface Pip {
  id: string;
  icon: string;
  label: string;
  at: number;
}

/**
 * A mirrored parchment message on a tile — persists like the player's own does
 * (so the Stage is a true mirror, not a blink): acknowledge stays until the
 * player taps (effect:acked) or a newer message supersedes it; auto_dismiss and
 * silent stay for their linger window.
 */
interface TileMessage {
  id: string;
  text: string;
  mode: MessageMode;
  at: number;
  /** ms timestamp it auto-clears; undefined = persists until acked/superseded. */
  expiresAt?: number;
}

export interface Transient {
  flash?: { id: string; at: number };
  pip?: Pip;
  message?: TileMessage;
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
    // storage unavailable — arrangement just won't persist
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

// ---------------------------------------------------------------------------
// Target → does it cover a given player?
// ---------------------------------------------------------------------------

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
// Main component
// ---------------------------------------------------------------------------

interface StageProps {
  circle: Circle;
  players: Player[];
}

/**
 * Stage — wires the live socket streams into per-player visual state, then hands
 * it to the (presentation-only) StageCanvas. Splitting the subscription from the
 * rendering keeps the canvas previewable with mock data (see preview.tsx).
 */
export function Stage({ circle, players }: StageProps) {
  // --- Ambiance scene per player (authoritative; from effects:active) ---
  const [sceneByPlayer, setSceneByPlayer] = useState<SceneMap>({});

  useEffect(() => {
    function onActive(payload: ActiveEffectsPayload) {
      if (payload.circleId !== circle.id) return;
      const ambiances = payload.effects.filter(
        (e) => e.kind === "ambiance" && e.scene && e.scene !== "clear",
      );
      setSceneByPlayer(() => {
        const next: SceneMap = {};
        for (const p of players) {
          // Last matching ambiance wins (one-per-target keeps this unambiguous).
          for (const a of ambiances) {
            if (a.scene && targetCovers(a.target, p.id)) next[p.id] = a.scene;
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

  // --- Transient overlays per player (from effect:mirror) ---
  const [transients, setTransients] = useState<TransientMap>({});

  useEffect(() => {
    function onMirror({ playerIds, effect }: EffectMirror) {
      const now = Date.now();
      const patch = mirrorToPatch(effect, now);
      if (!patch) return; // ambiance handled via effects:active; nothing to pip
      setTransients((prev) => {
        const next = { ...prev };
        for (const pid of playerIds) {
          next[pid] = { ...next[pid], ...patch };
        }
        return next;
      });
    }
    socket.on("effect:mirror", onMirror);
    return () => {
      socket.off("effect:mirror", onMirror);
    };
  }, []);

  // When a player acks a message, clear it from that tile (mirrors the player
  // tapping the parchment away — acknowledge messages have no auto-expiry).
  useEffect(() => {
    function onAcked({ effectId, playerId }: { effectId: string; playerId: string }) {
      setTransients((prev) => {
        const t = prev[playerId];
        if (!t?.message || t.message.id !== effectId) return prev;
        const { message: _cleared, ...rest } = t;
        return { ...prev, [playerId]: rest };
      });
    }
    socket.on("effect:acked", onAcked);
    return () => {
      socket.off("effect:acked", onAcked);
    };
  }, []);

  // Prune expired transients on a light interval, but only while some exist.
  const hasTransient = Object.keys(transients).length > 0;
  useEffect(() => {
    if (!hasTransient) return;
    const id = setInterval(() => {
      setTransients((prev) => pruneTransients(prev, Date.now()));
    }, 200);
    return () => clearInterval(id);
  }, [hasTransient]);

  return (
    <StageCanvas
      circleId={circle.id}
      players={players}
      sceneByPlayer={sceneByPlayer}
      transients={transients}
    />
  );
}

/** Drop expired flash/pip/msg overlays; returns the same ref if nothing changed. */
function pruneTransients(prev: TransientMap, now: number): TransientMap {
  let changed = false;
  const next: TransientMap = {};
  for (const [pid, t] of Object.entries(prev)) {
    const nt: Transient = {};
    if (t.flash && now - t.flash.at < FLASH_MS) nt.flash = t.flash;
    else if (t.flash) changed = true;
    if (t.pip && now - t.pip.at < PIP_MS) nt.pip = t.pip;
    else if (t.pip) changed = true;
    // A message stays until its expiry; acknowledge (no expiry) persists until
    // the player acks it (cleared by the effect:acked handler) or it's replaced.
    if (t.message && (t.message.expiresAt === undefined || now < t.message.expiresAt)) {
      nt.message = t.message;
    } else if (t.message) changed = true;
    if (nt.flash || nt.pip || nt.message) next[pid] = nt;
    else if (Object.keys(t).length > 0) changed = true;
  }
  return changed ? next : prev;
}

// ---------------------------------------------------------------------------
// StageCanvas — presentation only: the table, draggable tiles, and layout.
// Driven by props so it can be previewed with mock data (preview.tsx).
// ---------------------------------------------------------------------------

export type SceneMap = Record<string, AmbianceScene>;
export type TransientMap = Record<string, Transient>;

export interface StageCanvasProps {
  circleId: string;
  players: Player[];
  sceneByPlayer: SceneMap;
  transients: TransientMap;
}

export function StageCanvas({
  circleId,
  players,
  sceneByPlayer,
  transients,
}: StageCanvasProps) {
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const { w, h } = useElementSize(canvasRef);

  // Only connected clients appear on the table (a disconnected player keeps its
  // saved position but isn't shown until it returns).
  const shown = useMemo(() => players.filter((p) => p.connected), [players]);

  // --- Per-player tile box (from each connected player's reported viewport) ---
  const dimsByPlayer = useMemo(() => {
    const m = new Map<string, { w: number; h: number }>();
    for (const p of shown) m.set(p.id, tileBox(p.viewport));
    return m;
  }, [shown]);
  const dimsRef = useRef(dimsByPlayer);
  dimsRef.current = dimsByPlayer;
  const boxOf = (id: string) => dimsRef.current.get(id) ?? tileBox(undefined);

  // --- Layout (fractions) ---
  const [layout, setLayout] = useState<Layout>(() => loadLayout(circleId));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Reload when the circle changes.
  useEffect(() => {
    setLayout(loadLayout(circleId));
  }, [circleId]);

  // Ensure every shown player has a position; auto-place newcomers around the table.
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

  const onTilePointerDown = useCallback(
    (e: React.PointerEvent, playerId: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const frac = layoutRef.current[playerId] ?? { fx: 0.5, fy: 0.5 };
      const box = boxOf(playerId);
      const left = frac.fx * Math.max(1, rect.width - box.w);
      const top = frac.fy * Math.max(1, rect.height - box.h);
      // Offset between the pointer and the tile origin, so the tile doesn't jump.
      dragState.current = {
        id: playerId,
        dx: e.clientX - rect.left - left,
        dy: e.clientY - rect.top - top,
      };
      setDraggingId(playerId);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      e.preventDefault();
    },
    [],
  );

  const onTilePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragState.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const box = dimsRef.current.get(drag.id) ?? tileBox(undefined);
    const left = clampPx(e.clientX - rect.left - drag.dx, rect.width - box.w);
    const top = clampPx(e.clientY - rect.top - drag.dy, rect.height - box.h);
    const frac: Frac = {
      fx: left / Math.max(1, rect.width - box.w),
      fy: top / Math.max(1, rect.height - box.h),
    };
    setLayout((prev) => ({ ...prev, [drag.id]: frac }));
  }, []);

  const endDrag = useCallback(() => {
    if (!dragState.current) return;
    dragState.current = null;
    setDraggingId(null);
    saveLayout(circleId, layoutRef.current);
  }, [circleId]);

  // --- Render ---
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
        {/* The hearth — a faint ring + ember at the centre (the virtual table). */}
        <div style={tableRingStyle} aria-hidden="true" />

        {shown.length === 0 ? (
          <p style={emptyHintStyle}>Waiting for players to join…</p>
        ) : (
          shown.map((p) => {
            const frac = layout[p.id] ?? { fx: 0.5, fy: 0.5 };
            const box = dimsByPlayer.get(p.id) ?? tileBox(undefined);
            const screen = screenDims(p.viewport);
            const left = frac.fx * Math.max(0, w - box.w);
            const top = frac.fy * Math.max(0, h - box.h);
            return (
              <PhoneTile
                key={p.id}
                player={p}
                scene={sceneByPlayer[p.id] ?? "clear"}
                transient={transients[p.id]}
                left={left}
                top={top}
                screenW={screen.w}
                screenH={screen.h}
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
// effect:mirror → a transient patch (or null to ignore, e.g. ambiance)
// ---------------------------------------------------------------------------

function mirrorToPatch(
  effect: EffectMirror["effect"],
  now: number,
): Transient | null {
  switch (effect.kind) {
    case "flash":
      return { flash: { id: effect.id, at: now } };
    case "heartbeat":
      return { pip: { id: effect.id, icon: "♥", label: "Heartbeat", at: now } };
    case "haptic":
      return {
        pip: { id: effect.id, icon: "≋", label: cap(effect.pattern), at: now },
      };
    case "audio": {
      const label =
        effect.source.via === "cue" ? cueLabel(effect.source.cue) : "Speak";
      return { pip: { id: effect.id, icon: "♪", label, at: now } };
    }
    case "message": {
      // Mirror the player's parchment lifetime (see ParchmentMessage):
      // acknowledge persists until tapped; auto_dismiss/silent linger then fold.
      let expiresAt: number | undefined;
      if (effect.mode === "auto_dismiss") {
        expiresAt = now + (effect.autoDismissMs ?? 6000) + 1500;
      } else if (effect.mode === "silent") {
        expiresAt = now + 8000 + 1500;
      }
      return {
        message: { id: effect.id, text: effect.body, mode: effect.mode, at: now, expiresAt },
      };
    }
    case "ambiance":
      // Backgrounds come from effects:active (authoritative) — nothing to pip.
      return null;
  }
}

function cueLabel(cue: string): string {
  if (cue === "thunder") return "Thunder";
  return cap(cue);
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// PhoneTile — one player's mini mirror screen
// ---------------------------------------------------------------------------

interface PhoneTileProps {
  player: Player;
  scene: AmbianceScene;
  transient: Transient | undefined;
  left: number;
  top: number;
  /** Mini-screen size (px), derived from the player's real viewport. */
  screenW: number;
  screenH: number;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}

function PhoneTile({
  player,
  scene,
  transient,
  left,
  top,
  screenW,
  screenH,
  dragging,
  onPointerDown,
}: PhoneTileProps) {
  const live = player.connected;
  const flash = live ? transient?.flash : undefined;
  const pip = live ? transient?.pip : undefined;
  const message = live ? transient?.message : undefined;
  // Ember scales with the screen so it reads right on tiny or wide tiles.
  const emberSize = Math.round(Math.min(screenW, screenH) * 0.32);

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
        opacity: live ? 1 : 0.4,
        filter: dragging ? "brightness(1.08)" : "none",
      }}
    >
      {/* The phone screen — sized to the device's real aspect ratio. */}
      <div
        style={{
          position: "relative",
          width: screenW,
          height: screenH,
          borderRadius: Math.max(8, Math.round(Math.min(screenW, screenH) * 0.12)),
          overflow: "hidden",
          background: palette.nearBlack,
          border: `1.5px solid ${live ? palette.ash : "#241f1a"}`,
          boxShadow: dragging
            ? `0 10px 24px rgba(0,0,0,0.5)`
            : `0 3px 10px rgba(0,0,0,0.35)`,
        }}
      >
        <SceneBackdrop scene={live ? scene : "clear"} />

        {/* Resting hearth ember — always present, dimmer under weather. */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "54%",
            width: emberSize,
            height: emberSize,
            marginLeft: -emberSize / 2,
            marginTop: -emberSize / 2,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${palette.ember}55 0%, ${palette.emberDim}33 45%, transparent 70%)`,
            opacity: scene === "storm" ? 0.35 : 0.8,
          }}
        />

        {/* Message — a centred parchment card that PERSISTS like the player's
            (acknowledge until tapped; auto_dismiss/silent until they fold), so
            the tile mirrors what's actually on the player's screen. */}
        {message && (
          <div
            key={message.id}
            className="mi-stage-msg"
            style={{
              ...msgCardStyle,
              opacity: message.mode === "silent" ? 0.9 : 1,
            }}
          >
            {truncate(message.text, 88)}
          </div>
        )}

        {/* Transient pip — top-centre badge (heartbeat / sound / haptic). */}
        {pip && (
          <div key={pip.id} style={pipStyle} className="mi-stage-fade">
            <span style={{ fontSize: "0.72rem" }}>{pip.icon}</span>
            <span>{pip.label}</span>
          </div>
        )}

        {/* Lightning flash — a white bloom, keyed so each strike re-animates. */}
        {flash && (
          <div key={flash.id} style={flashStyle} className="mi-stage-flash" />
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
          color: live ? "var(--text)" : "var(--text-dim)",
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
            background: live ? palette.ember : palette.ash,
            flexShrink: 0,
          }}
        />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {player.name}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SceneBackdrop — a compact echo of the player's AmbianceLayer (cheap CSS).
// Mirrors the look (not the exact layers) of storm / rain / ember / clear.
// ---------------------------------------------------------------------------

function SceneBackdrop({ scene }: { scene: AmbianceScene }) {
  if (scene === "clear") return null;

  if (scene === "ember") {
    return (
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(ellipse at 50% 62%, rgba(120,52,18,0.55) 0%, rgba(70,28,10,0.34) 45%, transparent 72%)",
        }}
      />
    );
  }

  // storm + rain share the rain streaks; storm adds the cold vignette.
  return (
    <>
      {scene === "storm" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background:
              "radial-gradient(ellipse at 50% 38%, rgba(38,50,74,0.6) 0%, rgba(16,22,34,0.72) 55%, rgba(6,8,12,0.92) 100%)",
          }}
        />
      )}
      <div className="mi-stage-rain" style={{ position: "absolute", inset: "-20% 0" }} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Styles + one-time stylesheet (flash bloom, rain streaks, pip fade)
// ---------------------------------------------------------------------------

const STYLE_ID = "mi-stage-styles";
function injectStageStyles(): void {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes mi-stage-flash {
      0%   { opacity: 0; }
      18%  { opacity: 0.92; }
      100% { opacity: 0; }
    }
    .mi-stage-flash { animation: mi-stage-flash ${FLASH_MS}ms ease-out forwards; }

    @keyframes mi-stage-fade {
      0%   { opacity: 0; transform: translateY(2px); }
      14%  { opacity: 1; transform: translateY(0); }
      80%  { opacity: 1; }
      100% { opacity: 0; }
    }
    .mi-stage-fade { animation: mi-stage-fade ${PIP_MS}ms ease-out forwards; }

    /* Messages persist (no fade-out) — just a gentle rise-in, like the parchment. */
    @keyframes mi-stage-msg-in {
      from { opacity: 0; transform: translate(-50%, calc(-50% + 6px)); }
      to   { opacity: 1; transform: translate(-50%, -50%); }
    }
    .mi-stage-msg { animation: mi-stage-msg-in 340ms ease-out both; }

    .mi-stage-rain {
      background-image: repeating-linear-gradient(
        100deg,
        transparent 0px, transparent 6px,
        rgba(180,200,230,0.08) 6px, rgba(180,200,230,0.08) 7px
      );
      background-size: auto 110px;
      animation: mi-stage-rainfall 0.7s linear infinite;
      opacity: 0.55;
    }
    @keyframes mi-stage-rainfall {
      from { background-position: 0 0; }
      to   { background-position: -22px 110px; }
    }
  `;
  document.head.appendChild(style);
}
injectStageStyles();

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
  boxShadow: `inset 0 0 40px rgba(0,0,0,0.4)`,
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

const flashStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  background:
    "radial-gradient(ellipse at 50% 42%, rgba(255,255,255,1) 0%, rgba(236,243,255,1) 66%, rgba(208,224,255,1) 100%)",
  pointerEvents: "none",
};

const pipStyle: React.CSSProperties = {
  position: "absolute",
  top: 6,
  left: "50%",
  transform: "translateX(-50%)",
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "2px 7px",
  borderRadius: radius.pill,
  background: "rgba(10,9,8,0.72)",
  border: `1px solid ${palette.emberDim}`,
  color: palette.bone,
  fontSize: "0.62rem",
  fontWeight: 600,
  whiteSpace: "nowrap",
  pointerEvents: "none",
};

// A centred parchment card (the animation positions it via translate(-50%,-50%)).
const msgCardStyle: React.CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  width: "80%",
  maxHeight: "82%",
  overflow: "hidden",
  padding: "7px 8px",
  borderRadius: radius.sm,
  background: palette.parchment,
  color: "#241608",
  fontFamily: "Georgia, 'Times New Roman', serif",
  fontSize: "0.62rem",
  lineHeight: 1.34,
  textAlign: "center",
  textWrap: "balance" as React.CSSProperties["textWrap"],
  pointerEvents: "none",
  boxShadow: "0 4px 14px rgba(0,0,0,0.6)",
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function clampPx(v: number, max: number): number {
  return Math.min(Math.max(0, v), Math.max(0, max));
}
