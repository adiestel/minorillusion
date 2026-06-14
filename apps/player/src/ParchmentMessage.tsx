import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageEffect } from "@minorillusion/contract";
import { socket } from "./socket";
import { haptics } from "./capabilities/index";

/**
 * The parchment message — DOM/CSS (the cheap path, done right). A real parchment
 * texture on a layer whose edge is roughened into an organic torn/deckled
 * silhouette by an SVG displacement filter (the drop-shadow follows it; the ink
 * stays crisp on top). Restrained fade-and-rise entrance, ink fades in after the
 * page settles, IM Fell English type. No 3D, no scaling. (Rebuilt after the M1
 * review; see docs/DESIGN.md.) The dismissal is a tasteful fade-and-sink for now;
 * the acknowledge "burn" can be upgraded to a pre-rendered Veo clip later.
 *
 * Contract (see main.tsx): props { effect, onDone }; acknowledge emits effect:ack
 * on dismiss; haptics on arrival/tap.
 */

const PARCHMENT_URL = "/textures/parchment.jpg";
const EXIT_MS = 700;

function injectStyles(): void {
  if (document.getElementById("mi-parchment-styles")) return;

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=IM+Fell+English&display=swap";
  document.head.appendChild(link);

  // feTurbulence + feDisplacementMap roughens the paper edge into a torn/deckled
  // silhouette ("more torn" level from the M1 study). Applied to the bg layer
  // only, so the ink stays crisp; the drop-shadow then follows the torn shape.
  const svg = document.createElement("div");
  svg.id = "mi-parchment-svg";
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  svg.innerHTML =
    '<svg><defs><filter id="mi-torn" x="-25%" y="-25%" width="150%" height="150%">' +
    '<feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="3" seed="19" result="n"/>' +
    '<feDisplacementMap in="SourceGraphic" in2="n" scale="20" xChannelSelector="R" yChannelSelector="G"/>' +
    "</filter></defs></svg>";
  document.body.appendChild(svg);

  const style = document.createElement("style");
  style.id = "mi-parchment-styles";
  style.textContent = `
    @keyframes mi-scrim-in { from { opacity: 0 } to { opacity: 1 } }
    @keyframes mi-page-in {
      from { opacity: 0; transform: translateY(22px) }
      to   { opacity: 1; transform: translateY(0) }
    }
    @keyframes mi-page-out {
      from { opacity: 1; transform: translateY(0);  filter: brightness(1) }
      to   { opacity: 0; transform: translateY(16px); filter: brightness(.35) saturate(.5) }
    }
    @keyframes mi-ink-in { from { opacity: 0 } to { opacity: 1 } }

    .mi-msg-scrim {
      position: fixed; inset: 0; z-index: 60;
      display: flex; align-items: center; justify-content: center;
      animation: mi-scrim-in .55s ease forwards;
    }
    .mi-msg-scrim.is-focus {
      background: radial-gradient(ellipse at center, rgba(0,0,0,.42) 0%, rgba(0,0,0,.8) 100%);
    }
    .mi-msg-scrim.is-quiet {
      background: radial-gradient(ellipse at center, transparent 55%, rgba(120,55,20,.10) 100%);
      pointer-events: none;
    }
    .mi-page {
      position: relative;
      width: min(80vw, 430px); min-height: 220px;
      padding: 58px 52px;
      display: flex; align-items: center; justify-content: center;
      color: #241608;
      animation: mi-page-in .9s cubic-bezier(.16,.8,.3,1) forwards;
      will-change: opacity, transform;
    }
    .mi-page.is-out { animation: mi-page-out ${EXIT_MS}ms ease forwards; }
    .mi-paper {
      position: absolute; inset: 0; z-index: 0;
      background:
        radial-gradient(ellipse at center, transparent 42%, rgba(35,20,8,.5) 100%),
        url('${PARCHMENT_URL}') center / cover;
      filter: url(#mi-torn) drop-shadow(0 24px 58px rgba(0,0,0,.75));
    }
    .mi-ink {
      position: relative; z-index: 1; text-align: center;
      font-family: 'IM Fell English', Georgia, serif;
      font-size: clamp(19px, 5.4vw, 24px); line-height: 1.62;
      text-wrap: balance;
      opacity: 0; animation: mi-ink-in 1.1s ease .5s forwards;
    }
  `;
  document.head.appendChild(style);
}

export interface ParchmentMessageProps {
  effect: MessageEffect;
  onDone: () => void;
}

export function ParchmentMessage({ effect, onDone }: ParchmentMessageProps) {
  const [exiting, setExiting] = useState(false);
  const done = useRef(false);

  useEffect(() => {
    injectStyles();
    if (effect.mode === "acknowledge") haptics.vibrate([18, 30, 50]);
    else if (effect.mode === "auto_dismiss") haptics.vibrate([14, 24]);
    // silent: no haptic
  }, [effect.mode]);

  const finish = useCallback(() => {
    if (done.current) return;
    done.current = true;
    setExiting(true);
    window.setTimeout(() => {
      if (effect.mode === "acknowledge") {
        socket.emit("effect:ack", { effectId: effect.id });
      }
      onDone();
    }, EXIT_MS);
  }, [effect.id, effect.mode, onDone]);

  // auto_dismiss / silent linger, then exit on their own.
  useEffect(() => {
    if (effect.mode === "acknowledge") return;
    const linger =
      effect.autoDismissMs ?? (effect.mode === "silent" ? 8000 : 6000);
    const t = window.setTimeout(finish, linger + 600);
    return () => window.clearTimeout(t);
  }, [effect.mode, effect.autoDismissMs, finish]);

  const acknowledge = effect.mode === "acknowledge";
  const onTap = acknowledge
    ? () => {
        haptics.vibrate([10, 20, 40]);
        finish();
      }
    : undefined;

  return (
    <div
      className={`mi-msg-scrim ${effect.mode === "silent" ? "is-quiet" : "is-focus"}`}
      onClick={onTap}
    >
      <div
        className={`mi-page${exiting ? " is-out" : ""}`}
        onClick={
          onTap
            ? (e) => {
                e.stopPropagation();
                onTap();
              }
            : undefined
        }
      >
        <div className="mi-paper" aria-hidden="true" />
        <p className="mi-ink">{effect.body}</p>
      </div>
    </div>
  );
}
