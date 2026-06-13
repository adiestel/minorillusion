/**
 * Design tokens — one design language, themed per plane.
 * GM plane = "console" (dense, legible). Player plane = "in-world" (the near-black
 * circle canvas, parchment, the breathing ember). See docs/DESIGN.md. M0 keeps this
 * minimal; the parchment/handwriting treatment arrives with M1's message UI.
 */

export const palette = {
  nearBlack: "#0a0908",
  ink: "#2b2118",
  parchment: "#e8dcc0",
  parchmentDim: "#cdbf9e",
  ember: "#ff6b2d",
  emberDim: "#7a3517",
  ash: "#3a3530",
  bone: "#f4efe3",
} as const;

export const font = {
  ui: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, monospace',
} as const;

export const radius = { sm: "4px", md: "10px", pill: "999px" } as const;
export const space = (n: number): string => `${n * 4}px`;

export interface Theme {
  name: "gm" | "player";
  bg: string;
  surface: string;
  text: string;
  textDim: string;
  accent: string;
  font: string;
}

/** GM control surface — a readable dark console. */
export const gmTheme: Theme = {
  name: "gm",
  bg: "#14110e",
  surface: "#1f1a15",
  text: palette.bone,
  textDim: palette.parchmentDim,
  accent: palette.ember,
  font: font.ui,
};

/** Player — the near-black circle canvas. */
export const playerTheme: Theme = {
  name: "player",
  bg: palette.nearBlack,
  surface: "#141210",
  text: palette.parchment,
  textDim: palette.parchmentDim,
  accent: palette.ember,
  font: font.ui,
};

/** Flatten a theme into CSS custom properties for a root element. */
export function themeVars(theme: Theme): Record<string, string> {
  return {
    "--bg": theme.bg,
    "--surface": theme.surface,
    "--text": theme.text,
    "--text-dim": theme.textDim,
    "--accent": theme.accent,
    "--font": theme.font,
  };
}

// Minimal back-compat export.
export const tokens = { color: palette } as const;
export type Tokens = typeof tokens;
