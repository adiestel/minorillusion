import { describe, expect, it } from "vitest";
import { makeGrabBag } from "./grabbag.js";

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
