/**
 * Fidelity tiering for GL islands (DESIGN.md D7 / D13).
 *
 * The cheap DOM/CSS path is the default; a WebGL island only mounts when the
 * device can actually afford it. This module picks a coarse tier from capability
 * signals so each island decides: render the real GL version, or fall back to its
 * cheap (= low-end) version. WebGL2 is the baseline (D7) — without it we never go
 * GL. We also respect the user's data-saver + reduced-motion preferences (the
 * accessibility "reduced-effects mode" DESIGN.md calls for).
 *
 * The DETECTION reads the browser once (a probe canvas + navigator) and caches;
 * the SELECTION logic (`selectTier`) is a pure function and is unit-tested.
 */

/** Coarse capability tier an island renders against. */
export type FidelityTier = "high" | "low" | "off";

/** The raw capability signals `selectTier` decides from. */
export interface FidelitySignals {
  /** WebGL2 is available (the hard baseline — without it, no GL island, D7). */
  webgl2: boolean;
  /** navigator.hardwareConcurrency (logical cores); 0 when unknown. */
  cores: number;
  /** navigator.deviceMemory in GB (Chromium only); undefined when unknown. */
  deviceMemoryGB?: number;
  /** prefers-reduced-motion: reduce — damp/avoid heavy animation. */
  reducedMotion: boolean;
  /** navigator.connection.saveData — the user asked to minimize data use. */
  saveData: boolean;
}

/**
 * Pick a tier from capability signals (the pure, unit-tested core):
 *   • no WebGL2            → "off"  (cheap path only — the D7 baseline)
 *   • data-saver on        → "off"  (don't pull the heavy three/R3F chunk)
 *   • reduced-motion, ≤4
 *     cores, or ≤2GB RAM   → "low"  (eligible for GL, but islands damp/simplify)
 *   • otherwise            → "high" (full-fidelity islands)
 * "off" means render the cheap fallback; "low"/"high" both render GL, with "low"
 * asking islands to tone the effect down.
 */
export function selectTier(s: FidelitySignals): FidelityTier {
  if (!s.webgl2) return "off";
  if (s.saveData) return "off";
  const thinCpu = s.cores > 0 && s.cores <= 4;
  const lowMem = s.deviceMemoryGB !== undefined && s.deviceMemoryGB <= 2;
  if (s.reducedMotion || thinCpu || lowMem) return "low";
  return "high";
}

// ---------------------------------------------------------------------------
// Detection (cached; browser-dependent — kept thin so selectTier stays pure).
// ---------------------------------------------------------------------------

let cachedWebGL2: boolean | undefined;

/** Does this device expose a WebGL2 context? Cached after the first probe. */
export function hasWebGL2(): boolean {
  if (cachedWebGL2 !== undefined) return cachedWebGL2;
  try {
    const canvas = document.createElement("canvas");
    cachedWebGL2 = canvas.getContext("webgl2") !== null;
  } catch {
    cachedWebGL2 = false;
  }
  return cachedWebGL2;
}

/** Read the live capability signals from the browser (used by detectFidelityTier). */
export function readSignals(): FidelitySignals {
  const nav: (Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } }) | undefined =
    typeof navigator !== "undefined" ? navigator : undefined;
  const reducedMotion =
    typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    webgl2: hasWebGL2(),
    cores: nav?.hardwareConcurrency ?? 0,
    deviceMemoryGB: nav?.deviceMemory,
    reducedMotion,
    saveData: nav?.connection?.saveData === true,
  };
}

let cachedTier: FidelityTier | undefined;

/** The device's tier (detect once, then cache — capabilities don't change). */
export function detectFidelityTier(): FidelityTier {
  if (cachedTier !== undefined) return cachedTier;
  cachedTier = selectTier(readSignals());
  return cachedTier;
}

/** Test/override seam: clear the detection caches so the next read re-probes. */
export function __resetFidelityCache(): void {
  cachedWebGL2 = undefined;
  cachedTier = undefined;
}
