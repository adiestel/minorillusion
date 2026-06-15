import { describe, expect, it } from "vitest";
import type { Character } from "@minorillusion/contract";
import { resolveRoll, type Rng } from "./rolls.js";

/** An RNG that yields the given die faces in order (so rolls are deterministic).
 *  face k on a d`sides` needs rng() in [(k-1)/sides, k/sides) — we use the midpoint. */
function rngForFaces(faces: Array<{ face: number; sides: number }>): Rng {
  let i = 0;
  return () => {
    const f = faces[i++];
    if (!f) throw new Error("RNG ran out of queued faces");
    return (f.face - 0.5) / f.sides;
  };
}
const d20 = (face: number) => ({ face, sides: 20 });
const d6 = (face: number) => ({ face, sides: 6 });

const BRAM: Character = {
  id: "00000000-0000-0000-0000-000000000001",
  circleId: "00000000-0000-0000-0000-000000000002",
  name: "Bram",
  level: 5, // proficiency bonus +3
  abilities: { str: 16, dex: 14, con: 14, int: 10, wis: 12, cha: 8 },
  skillProficiencies: ["stealth"],
  saveProficiencies: ["dex", "con"],
  source: "manual",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

describe("resolveRoll — derived d20 with correct modifiers", () => {
  it("ability check: STR check uses just the ability modifier (+3)", () => {
    const r = resolveRoll({ spec: { kind: "check", ability: "str" }, mode: "normal", public: false }, BRAM, rngForFaces([d20(10)]));
    expect(r.modifier).toBe(3); // str 16 → +3
    expect(r.kept).toBe(10);
    expect(r.total).toBe(13);
    expect(r.label).toBe("Strength Check");
    expect(r.characterName).toBe("Bram");
  });

  it("save: a proficient save adds the proficiency bonus (dex 14 → +2, prof +3 = +5)", () => {
    const r = resolveRoll({ spec: { kind: "save", ability: "dex" }, mode: "normal", public: false }, BRAM, rngForFaces([d20(11)]));
    expect(r.modifier).toBe(5);
    expect(r.total).toBe(16);
    expect(r.label).toBe("Dexterity Save");
  });

  it("save: a non-proficient save is just the ability mod (int 10 → +0)", () => {
    const r = resolveRoll({ spec: { kind: "save", ability: "int" }, mode: "normal", public: false }, BRAM, rngForFaces([d20(8)]));
    expect(r.modifier).toBe(0);
    expect(r.total).toBe(8);
  });

  it("skill: a proficient skill adds proficiency (Stealth: dex +2, prof +3 = +5)", () => {
    const r = resolveRoll({ spec: { kind: "skill", skill: "stealth" }, mode: "normal", public: false }, BRAM, rngForFaces([d20(12)]));
    expect(r.modifier).toBe(5);
    expect(r.total).toBe(17);
    expect(r.label).toBe("Stealth");
  });

  it("skill: a non-proficient skill is just the governing ability (Arcana: int +0)", () => {
    const r = resolveRoll({ spec: { kind: "skill", skill: "arcana" }, mode: "normal", public: false }, BRAM, rngForFaces([d20(15)]));
    expect(r.modifier).toBe(0);
    expect(r.total).toBe(15);
  });
});

describe("resolveRoll — advantage / disadvantage", () => {
  it("advantage rolls two d20 and keeps the higher", () => {
    const r = resolveRoll({ spec: { kind: "check", ability: "dex" }, mode: "advantage", public: false }, BRAM, rngForFaces([d20(7), d20(18)]));
    expect(r.dice).toEqual([7, 18]);
    expect(r.kept).toBe(18);
    expect(r.total).toBe(20); // +2 dex
    expect(r.label).toBe("Dexterity Check (Adv)");
  });

  it("disadvantage keeps the lower", () => {
    const r = resolveRoll({ spec: { kind: "check", ability: "dex" }, mode: "disadvantage", public: false }, BRAM, rngForFaces([d20(7), d20(18)]));
    expect(r.kept).toBe(7);
    expect(r.total).toBe(9);
  });
});

describe("resolveRoll — crit / fumble (on the kept d20)", () => {
  it("a natural 20 flags crit", () => {
    const r = resolveRoll({ spec: { kind: "check", ability: "str" }, mode: "normal", public: false }, BRAM, rngForFaces([d20(20)]));
    expect(r.crit).toBe(true);
    expect(r.fumble).toBe(false);
  });
  it("a natural 1 flags fumble", () => {
    const r = resolveRoll({ spec: { kind: "save", ability: "dex" }, mode: "normal", public: false }, BRAM, rngForFaces([d20(1)]));
    expect(r.fumble).toBe(true);
    expect(r.crit).toBe(false);
  });
});

describe("resolveRoll — raw NdS + modifier", () => {
  it("sums all dice + the flat modifier, no crit", () => {
    const r = resolveRoll({ spec: { kind: "raw", count: 2, sides: 6, modifier: 3 }, mode: "normal", public: false }, undefined, rngForFaces([d6(4), d6(5)]));
    expect(r.dice).toEqual([4, 5]);
    expect(r.kept).toBe(9);
    expect(r.total).toBe(12);
    expect(r.sides).toBe(6);
    expect(r.crit).toBe(false);
    expect(r.label).toBe("2d6 + 3");
  });

  it("formats a negative modifier", () => {
    const r = resolveRoll({ spec: { kind: "raw", count: 1, sides: 20, modifier: -1 }, mode: "normal", public: false }, undefined, rngForFaces([d20(10)]));
    expect(r.total).toBe(9);
    expect(r.label).toContain("1d20");
  });
});

describe("resolveRoll — no character sheet", () => {
  it("derived rolls fall back to a +0 modifier and no name", () => {
    const r = resolveRoll({ spec: { kind: "save", ability: "wis" }, mode: "normal", public: false }, undefined, rngForFaces([d20(14)]));
    expect(r.modifier).toBe(0);
    expect(r.total).toBe(14);
    expect(r.characterName).toBeUndefined();
  });

  it("respects an explicit label override", () => {
    const r = resolveRoll({ spec: { kind: "save", ability: "con" }, mode: "normal", label: "Death Save", public: false }, BRAM, rngForFaces([d20(10)]));
    expect(r.label).toBe("Death Save");
  });
});
