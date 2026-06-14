import { describe, expect, it } from "vitest";
import { makeGrabBag, makePhraseSequencer } from "./grabbag.js";

/**
 * The grab bag must cover the whole library before repeating and never hand out
 * the same item twice in a row — including across the seam where one shuffled
 * pass ends and the next begins. These are the properties the whisperscape
 * relies on so its spoken lines cycle instead of looping on one phrase.
 */
describe("makeGrabBag", () => {
  it("yields every item exactly once per pass", () => {
    const items = ["a", "b", "c", "d", "e"];
    const draw = makeGrabBag(items);
    const pass = items.map(() => draw());
    expect([...pass].sort()).toEqual([...items].sort());
  });

  it("covers the library across many passes (each item once per window)", () => {
    const items = ["a", "b", "c", "d"];
    const draw = makeGrabBag(items);
    for (let p = 0; p < 50; p++) {
      const seen = new Set(items.map(() => draw()));
      expect(seen.size).toBe(items.length); // a full, non-repeating pass
    }
  });

  it("never repeats the same item back-to-back, even across the bag seam", () => {
    const items = ["a", "b", "c"];
    const draw = makeGrabBag(items);
    let prev = draw();
    for (let i = 0; i < 5000; i++) {
      const next = draw();
      expect(next).not.toBe(prev); // the seam guard holds across reshuffles
      prev = next;
    }
  });

  it("repeats the sole item of a one-element library (nothing else to draw)", () => {
    const draw = makeGrabBag(["only"]);
    expect(draw()).toBe("only");
    expect(draw()).toBe("only");
  });

  it("returns undefined for an empty library", () => {
    const draw = makeGrabBag<string>([]);
    expect(draw()).toBeUndefined();
  });

  it("does not mutate the source array", () => {
    const items = ["a", "b", "c"];
    const draw = makeGrabBag(items);
    for (let i = 0; i < 10; i++) draw();
    expect(items).toEqual(["a", "b", "c"]);
  });
});

/**
 * The sequencer drives the whisperscape's phrase order: sequential walks the
 * library in order; random draws a no-repeat pass; both track the position in
 * the pass and flag the final phrase of a non-looping run so the runner can stop.
 */
describe("makePhraseSequencer", () => {
  it("sequential + loop: walks the library in order, then repeats", () => {
    const next = makePhraseSequencer(["a", "b", "c"], "sequential", true);
    const order = [next(), next(), next(), next(), next()];
    expect(order.map((s) => s?.phrase)).toEqual(["a", "b", "c", "a", "b"]);
    expect(order.map((s) => s?.index)).toEqual([0, 1, 2, 0, 1]);
    expect(order.map((s) => s?.remaining)).toEqual([2, 1, 0, 2, 1]);
    expect(order.every((s) => s?.done === false)).toBe(true); // loops, never done
  });

  it("sequential + no loop: plays each once and flags the last as done", () => {
    const next = makePhraseSequencer(["a", "b", "c"], "sequential", false);
    expect(next()).toMatchObject({ phrase: "a", index: 0, remaining: 2, done: false });
    expect(next()).toMatchObject({ phrase: "b", index: 1, remaining: 1, done: false });
    expect(next()).toMatchObject({ phrase: "c", index: 2, remaining: 0, done: true });
  });

  it("random + no loop: one full no-repeat pass, last flagged done", () => {
    const next = makePhraseSequencer(["a", "b", "c", "d"], "random", false);
    const pass = [next(), next(), next(), next()];
    expect(pass.map((s) => s?.phrase).sort()).toEqual(["a", "b", "c", "d"]); // each once
    expect(pass.map((s) => s?.index)).toEqual([0, 1, 2, 3]);
    expect(pass.slice(0, 3).every((s) => s?.done === false)).toBe(true);
    expect(pass[3]?.done).toBe(true); // final phrase of the only pass
  });

  it("random + loop: passes stay full and the index cycles per pass", () => {
    const next = makePhraseSequencer(["a", "b", "c"], "random", true);
    for (let pass = 0; pass < 20; pass++) {
      const got = [next(), next(), next()];
      expect(got.map((s) => s?.phrase).sort()).toEqual(["a", "b", "c"]); // full pass
      expect(got.map((s) => s?.index)).toEqual([0, 1, 2]);
      expect(got.every((s) => s?.done === false)).toBe(true);
    }
  });

  it("returns null for an empty library", () => {
    const next = makePhraseSequencer([], "sequential", false);
    expect(next()).toBeNull();
  });
});
