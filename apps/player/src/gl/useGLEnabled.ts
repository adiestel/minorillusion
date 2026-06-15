/**
 * useGLEnabled — the gate every GL island asks before rendering (DESIGN.md D7).
 *
 * Combines the two guardrails: the device's fidelity tier must allow GL (not
 * "off") AND a GL-budget slot must be free. While `want` is true and both hold,
 * the island holds a budget slot; it releases on unmount or when `want` goes
 * false. The boolean it returns is the island's render decision:
 *   true  → mount the real (lazy-loaded) GL island
 *   false → render the cheap DOM/CSS fallback (= the low-end tier)
 *
 * Keeping this hook tiny and three-free means the main bundle never imports R3F:
 * a consumer renders `enabled ? <Suspense><LazyGLIsland/></Suspense> : <Fallback/>`,
 * so three/R3F only enter the bundle as a lazy chunk when an island actually mounts.
 */
import { useEffect, useState } from "react";
import { detectFidelityTier, type FidelityTier } from "./fidelity";
import { glBudget } from "./glBudget";

export interface GLDecision {
  /** Render the GL island (true) or the cheap fallback (false). */
  enabled: boolean;
  /** The device tier, so an island can damp itself at "low". */
  tier: FidelityTier;
}

/**
 * Decide whether the island `id` should render in GL. `want` lets a consumer
 * defer acquisition until the island is actually needed (e.g. only while the
 * crystal ball is open), freeing the slot the moment it isn't.
 */
export function useGLEnabled(id: string, want = true): GLDecision {
  const tier = detectFidelityTier();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (!want || tier === "off") {
      setEnabled(false);
      return;
    }
    const granted = glBudget.acquire(id);
    setEnabled(granted);
    return () => {
      glBudget.release(id);
    };
  }, [id, want, tier]);

  return { enabled, tier };
}
