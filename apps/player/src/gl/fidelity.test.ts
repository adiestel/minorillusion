import { describe, expect, it } from "vitest";
import { selectTier, type FidelitySignals } from "./fidelity";

/** A capable high-end device; tests override one field at a time. */
const CAPABLE: FidelitySignals = {
  webgl2: true,
  cores: 8,
  deviceMemoryGB: 8,
  reducedMotion: false,
  saveData: false,
};

describe("selectTier", () => {
  it("a capable device gets the high tier", () => {
    expect(selectTier(CAPABLE)).toBe("high");
  });

  it("no WebGL2 forces off (the cheap path only — D7 baseline)", () => {
    expect(selectTier({ ...CAPABLE, webgl2: false })).toBe("off");
    // …even on otherwise-beefy hardware.
    expect(selectTier({ ...CAPABLE, webgl2: false, cores: 16, deviceMemoryGB: 32 })).toBe("off");
  });

  it("data-saver forces off (don't pull the heavy three/R3F chunk)", () => {
    expect(selectTier({ ...CAPABLE, saveData: true })).toBe("off");
  });

  it("reduced-motion drops to low (eligible for GL, but damped)", () => {
    expect(selectTier({ ...CAPABLE, reducedMotion: true })).toBe("low");
  });

  it("thin CPU (≤4 cores) drops to low", () => {
    expect(selectTier({ ...CAPABLE, cores: 4 })).toBe("low");
    expect(selectTier({ ...CAPABLE, cores: 2 })).toBe("low");
    // 0 = unknown core count is NOT treated as thin (don't punish missing data).
    expect(selectTier({ ...CAPABLE, cores: 0 })).toBe("high");
  });

  it("low memory (≤2GB) drops to low; unknown memory does not", () => {
    expect(selectTier({ ...CAPABLE, deviceMemoryGB: 2 })).toBe("low");
    expect(selectTier({ ...CAPABLE, deviceMemoryGB: 1 })).toBe("low");
    expect(selectTier({ ...CAPABLE, deviceMemoryGB: undefined })).toBe("high");
  });

  it("off wins over low (no-WebGL2 beats a thin-CPU signal)", () => {
    expect(selectTier({ ...CAPABLE, webgl2: false, cores: 2 })).toBe("off");
  });
});
