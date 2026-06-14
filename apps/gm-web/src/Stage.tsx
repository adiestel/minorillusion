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
  Player,
  Target,
} from "@minorillusion/contract";
import { palette, radius, space } from "@minorillusion/design-system";
import { socket } from "./socket";

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

const TILE_W = 96; // phone tile width (px)
const SCREEN_H = 132; // the mini phone screen height (px)
const LABEL_H = 22; // the name label strip below the screen (px)
const TILE_H = SCREEN_H + LABEL_H;

// Transient overlay lifetimes (ms) — how long a mirrored pip lingers on a tile.
const FLASH_MS = 950;
const PIP_MS = 1600;
const MSG_MS = 3200;

// ---------------------------------------------------------------------------
// Per-tile transient state (driven by effect:mirror)
// ---------------------------------------------------------------------------

interface Pip {
  id: string;
  icon: string;
  label: string;
  at: number;
}

export interface Transient {
  flash?: { id: string; at: number };
  pip?: Pip;
  msg?: { text: string; at: number };
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
    if (t.msg && now - t.msg.at < MSG_MS) nt.msg = t.msg;
    else if (t.msg) changed = true;
    if (nt.flash || nt.pip || nt.msg) next[pid] = nt;
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

  // --- Layout (fractions) ---
  const [layout, setLayout] = useState<Layout>(() => loadLayout(circleId));
  const layoutRef = useRef(layout);
  layoutRef.current = layout;

  // Reload when the circle changes.
  useEffect(() => {
    setLayout(loadLayout(circleId));
  }, [circleId]);

  // Ensure every player has a position; auto-place newcomers around the table.
  useEffect(() => {
    const current = layoutRef.current;
    const missing = players.filter((p) => current[p.id] === undefined);
    if (missing.length === 0) return;
    const n = players.length;
    const next: Layout = { ...current };
    players.forEach((p, i) => {
      if (next[p.id] === undefined) next[p.id] = autoPlace(i, n);
    });
    setLayout(next);
    saveLayout(circleId, next);
  }, [players, circleId]);

  // --- Dragging ---
  const dragState = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const onTilePointerDown = useCallback(
    (e: React.PointerEvent, playerId: string) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const frac = layoutRef.current[playerId] ?? { fx: 0.5, fy: 0.5 };
      const left = frac.fx * Math.max(1, rect.width - TILE_W);
      const top = frac.fy * Math.max(1, rect.height - TILE_H);
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
    const left = clampPx(e.clientX - rect.left - drag.dx, rect.width - TILE_W);
    const top = clampPx(e.clientY - rect.top - drag.dy, rect.height - TILE_H);
    const frac: Frac = {
      fx: left / Math.max(1, rect.width - TILE_W),
      fy: top / Math.max(1, rect.height - TILE_H),
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
  const connectedCount = useMemo(
    () => players.filter((p) => p.connected).length,
    [players],
  );

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: space(3) }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
        <h2 style={headingStyle}>The table</h2>
        <span style={{ fontSize: "0.78rem", color: "var(--text-dim)" }}>
          drag to arrange · {connectedCount} live
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

        {players.length === 0 ? (
          <p style={emptyHintStyle}>Waiting for players to join…</p>
        ) : (
          players.map((p) => {
            const frac = layout[p.id] ?? { fx: 0.5, fy: 0.5 };
            const left = frac.fx * Math.max(0, w - TILE_W);
            const top = frac.fy * Math.max(0, h - TILE_H);
            return (
              <PhoneTile
                key={p.id}
                player={p}
                scene={sceneByPlayer[p.id] ?? "clear"}
                transient={transients[p.id]}
                left={left}
                top={top}
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
    case "message":
      return { msg: { text: effect.body, at: now } };
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
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
}

function PhoneTile({
  player,
  scene,
  transient,
  left,
  top,
  dragging,
  onPointerDown,
}: PhoneTileProps) {
  const live = player.connected;
  const flash = live ? transient?.flash : undefined;
  const pip = live ? transient?.pip : undefined;
  const msg = live ? transient?.msg : undefined;

  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        left,
        top,
        width: TILE_W,
        cursor: dragging ? "grabbing" : "grab",
        touchAction: "none",
        userSelect: "none",
        zIndex: dragging ? 5 : 2,
        transition: dragging ? "none" : "left 0.12s ease, top 0.12s ease",
        opacity: live ? 1 : 0.4,
        filter: dragging ? "brightness(1.08)" : "none",
      }}
    >
      {/* The phone screen */}
      <div
        style={{
          position: "relative",
          height: SCREEN_H,
          borderRadius: 14,
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
            width: 34,
            height: 34,
            marginLeft: -17,
            marginTop: -17,
            borderRadius: "50%",
            background: `radial-gradient(circle, ${palette.ember}55 0%, ${palette.emberDim}33 45%, transparent 70%)`,
            opacity: scene === "storm" ? 0.35 : 0.8,
          }}
        />

        {/* Message strip — a small parchment card near the bottom. */}
        {msg && (
          <div style={msgStripStyle} className="mi-stage-fade">
            {truncate(msg.text, 38)}
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

const msgStripStyle: React.CSSProperties = {
  position: "absolute",
  left: 6,
  right: 6,
  bottom: 8,
  padding: "5px 7px",
  borderRadius: radius.sm,
  background: palette.parchment,
  color: palette.ink,
  fontSize: "0.6rem",
  lineHeight: 1.3,
  fontWeight: 600,
  textAlign: "center",
  pointerEvents: "none",
  boxShadow: "0 2px 6px rgba(0,0,0,0.4)",
};

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function clampPx(v: number, max: number): number {
  return Math.min(Math.max(0, v), Math.max(0, max));
}
