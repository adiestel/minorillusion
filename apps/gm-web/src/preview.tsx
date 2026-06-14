/**
 * GM Stage preview — an offscreen harness for eyeballing the live-canvas layout
 * (the draggable phone tiles, sizing to each device's viewport, the table ring).
 * Renders the presentation-only <StageCanvas> with mock players + scenes. Each
 * tile is an <iframe> of the player mirror (/mirror.html), so the running player
 * dev server is needed for the screens to populate.
 *
 *   http://localhost:5173/preview.html
 *
 * Mirrors apps/player/src/preview.tsx — a dev tool, never shipped.
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Player } from "@minorillusion/contract";
import { gmTheme, palette, space, themeVars } from "@minorillusion/design-system";
import { StageCanvas, type SceneMap } from "./Stage";

// Apply the GM CSS vars at :root so var(--text-dim) etc. resolve.
for (const [prop, value] of Object.entries(themeVars(gmTheme))) {
  document.documentElement.style.setProperty(prop, value);
}
document.body.style.margin = "0";
document.body.style.background = gmTheme.bg;
document.body.style.color = gmTheme.text;
document.body.style.fontFamily = gmTheme.font;

// Mock players with varied viewports (phones, a tablet, a wide window).
function mk(
  id: string,
  name: string,
  viewport: { width: number; height: number },
  connected = true,
): Player {
  return {
    id,
    circleId: "preview-circle",
    name,
    connected,
    joinedAt: new Date().toISOString(),
    viewport,
  };
}

const PLAYERS: Player[] = [
  mk("p-aria", "Aria", { width: 390, height: 844 }),
  mk("p-bram", "Bram", { width: 414, height: 736 }),
  mk("p-cole", "Cole", { width: 834, height: 1112 }),
  mk("p-dax", "Dax", { width: 1280, height: 720 }),
  mk("p-esa", "Esa", { width: 360, height: 800 }, false), // disconnected → hidden
];

const SCENES: SceneMap = {
  "p-aria": "storm",
  "p-bram": "rain",
  "p-cole": "ember",
};

function Preview() {
  const [scenes] = useState<SceneMap>(SCENES);
  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: space(6) }}>
      <p style={{ fontSize: "0.8rem", color: palette.parchmentDim, marginTop: 0 }}>
        GM Stage preview — mock players; each screen is the live player mirror
      </p>
      <StageCanvas circleId="preview-circle" players={PLAYERS} sceneByPlayer={scenes} />
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
