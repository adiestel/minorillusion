/**
 * Effect preview harness (dev-only — NOT in the production build; vite builds
 * index.html only). Mounts the REAL M2 effect components in deterministic states
 * so they can be screenshotted offscreen with headless Chrome and reviewed —
 * the "iterate hero visuals with a screenshot feedback loop" practice (rendering
 * memory; DECISIONS D13). Served by the running dev server at:
 *
 *   /preview.html?view=storm|ember|heartbeat|consent  [&flash=1] [&freeze=1]
 *
 * flash=1  overlays a storm lightning Flash, frozen at peak (deterministic still).
 *          Lightning is now its own <Flash> component (server-driven in prod),
 *          not part of the storm ambiance, so the preview composes them here.
 * freeze=1 freezes the heartbeat pulse at peak (deterministic still).
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { palette, playerTheme, themeVars } from "@minorillusion/design-system";
import { AmbianceLayer } from "./AmbianceLayer";
import { Heartbeat } from "./Heartbeat";
import { Flash } from "./Flash";
import { Consent } from "./Consent";
import { audio } from "./capabilities/index";

// In the offscreen screenshot harness, neutralise audio: a real <audio> media
// load (the rain bed) keeps Chrome's --virtual-time-budget from ever settling,
// so storm/ember never capture. The visuals we're reviewing are pure CSS.
audio.play = () => ({ stop: () => {} });
audio.stopAll = () => {};
audio.unlock = () => {};

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "storm";

const base = document.createElement("style");
base.textContent = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body, #root { height: 100%; width: 100%; overflow: hidden; background: ${palette.nearBlack}; }
  body { font-family: var(--font), system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--text); -webkit-font-smoothing: antialiased; }
  /* a stand-in for the resting ember, for compositional context */
  .mi-preview-ember {
    position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: 200px; height: 200px; border-radius: 50%; z-index: 1; pointer-events: none;
    background: radial-gradient(circle, ${palette.ember}66 0%, ${palette.emberDim}33 45%, transparent 70%);
  }
`;
document.head.appendChild(base);

if (params.get("freeze") === "1") {
  const o = document.createElement("style");
  o.textContent = `.mi-heartbeat { opacity: .85 !important; transform: scale(1) !important; animation: none !important; }`;
  document.head.appendChild(o);
}
const showFlash = params.get("flash") === "1";
if (showFlash) {
  const o = document.createElement("style");
  // Freeze the new <Flash> overlay at a visible peak for a deterministic still.
  o.textContent = `.mi-flash { opacity: .5 !important; animation: none !important; }`;
  document.head.appendChild(o);
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
// Apply the theme vars at :root so they inherit to body too (matches the fix in
// main.tsx — a var set only on #root never reaches body's font-family rule).
for (const [prop, value] of Object.entries(themeVars(playerTheme))) {
  document.documentElement.style.setProperty(prop, value);
}
rootEl.style.height = "100%";
rootEl.style.width = "100%";

function View() {
  switch (view) {
    case "consent":
      return <Consent onAccept={() => {}} onDecline={() => {}} />;
    case "flash":
      // Flash over a STATIC storm-ish backdrop (no infinite rain animation, so
      // headless --virtual-time-budget settles reliably). Pair with &flash=1.
      return (
        <>
          <div
            style={{
              position: "fixed",
              inset: 0,
              background:
                "radial-gradient(ellipse at 50% 38%, rgba(38,50,74,0.55) 0%, rgba(16,22,34,0.7) 55%, rgba(6,8,12,0.92) 100%)",
            }}
          />
          <div className="mi-preview-ember" />
          <Flash onDone={() => {}} />
        </>
      );
    case "ember":
      return (
        <>
          <AmbianceLayer scene="ember" />
          <div className="mi-preview-ember" />
        </>
      );
    case "heartbeat":
      return (
        <>
          <div className="mi-preview-ember" />
          <Heartbeat bpm={72} beats={3} onDone={() => {}} />
        </>
      );
    case "storm":
    default:
      return (
        <>
          <AmbianceLayer scene="storm" />
          <div className="mi-preview-ember" />
          {/* Lightning is now a separate overlay; the flash=1 CSS freezes it. */}
          {showFlash && <Flash onDone={() => {}} />}
        </>
      );
  }
}

createRoot(rootEl).render(
  <StrictMode>
    <View />
  </StrictMode>,
);
