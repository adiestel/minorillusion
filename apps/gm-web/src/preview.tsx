/**
 * GM Stage preview — an offscreen harness for eyeballing the live-canvas visuals
 * (the draggable phone tiles, scene backdrops, lightning flash, pips, message
 * strip, and the table ring) WITHOUT a running circle. Renders the presentation-
 * only <StageCanvas> with mock players + scenes/transients, so no socket is used.
 *
 *   http://localhost:5173/preview.html            → live demo (flashes/pips cycle)
 *   http://localhost:5173/preview.html?freeze=1   → a static frame (clean shot;
 *                                                    pauses animations + pins the
 *                                                    flash/pip/message visible)
 *
 * Mirrors apps/player/src/preview.tsx — a dev tool, never shipped to players.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Player } from "@minorillusion/contract";
import { gmTheme, palette, space, themeVars } from "@minorillusion/design-system";
import { StageCanvas, type SceneMap, type TransientMap } from "./Stage";

// --- Theme: apply the GM CSS vars at :root so var(--text-dim) etc. resolve. ---
const vars = themeVars(gmTheme);
for (const [prop, value] of Object.entries(vars)) {
  document.documentElement.style.setProperty(prop, value);
}
document.body.style.margin = "0";
document.body.style.background = gmTheme.bg;
document.body.style.color = gmTheme.text;
document.body.style.fontFamily = gmTheme.font;

const params = new URLSearchParams(location.search);
const FREEZE = params.get("freeze") === "1";

// In freeze mode, pause the looping rain and pin the otherwise-animated flash /
// pip / message to a visible state, so a single screenshot shows everything.
if (FREEZE) {
  const s = document.createElement("style");
  s.textContent = `
    .mi-stage-rain { animation-play-state: paused !important; }
    .mi-stage-flash { animation: none !important; opacity: 0.5 !important; }
    .mi-stage-fade { animation: none !important; opacity: 1 !important; transform: none !important; }
  `;
  document.head.appendChild(s);
}

// --- Mock players (around a virtual table). ---
function mk(id: string, name: string, connected = true): Player {
  return {
    id,
    circleId: "preview-circle",
    name,
    connected,
    joinedAt: new Date().toISOString(),
  };
}

const PLAYERS: Player[] = [
  mk("p-aria", "Aria"),
  mk("p-bram", "Bram"),
  mk("p-cole", "Cole"),
  mk("p-dax", "Dax"),
  mk("p-esa", "Esa", false), // disconnected → dimmed tile
];

// A representative opening frame: weather on three tiles, a strike + pips.
const BASE_SCENES: SceneMap = {
  "p-aria": "storm",
  "p-bram": "rain",
  "p-cole": "ember",
};

function makeTransients(now: number): TransientMap {
  return {
    "p-aria": { flash: { id: `f-${now}`, at: now } },
    "p-bram": { pip: { id: `t-${now}`, icon: "♪", label: "Thunder", at: now } },
    "p-cole": {
      msg: { text: "The embers flare — a shadow crosses the wall.", at: now },
    },
    "p-dax": { pip: { id: `h-${now}`, icon: "♥", label: "Heartbeat", at: now } },
  };
}

function Preview() {
  const [scenes] = useState<SceneMap>(BASE_SCENES);
  const [transients, setTransients] = useState<TransientMap>(() =>
    makeTransients(Date.now()),
  );

  // Live mode: re-fire flashes/pips every few seconds so the page feels alive.
  useEffect(() => {
    if (FREEZE) return;
    const id = setInterval(() => {
      setTransients(makeTransients(Date.now()));
    }, 2600);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: space(6) }}>
      <p style={{ fontSize: "0.8rem", color: palette.parchmentDim, marginTop: 0 }}>
        GM Stage preview {FREEZE ? "(frozen)" : "(live)"} — mock data, no circle
      </p>
      <StageCanvas
        circleId="preview-circle"
        players={PLAYERS}
        sceneByPlayer={scenes}
        transients={transients}
      />
    </div>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
createRoot(rootEl).render(
  <StrictMode>
    <Preview />
  </StrictMode>,
);
