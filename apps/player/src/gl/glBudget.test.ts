import { describe, expect, it } from "vitest";
import { createGLBudget } from "./glBudget";

describe("createGLBudget", () => {
  it("admits up to the cap, then refuses (over-budget → caller falls back)", () => {
    const b = createGLBudget(2);
    expect(b.acquire("ball")).toBe(true);
    expect(b.acquire("dice")).toBe(true);
    expect(b.available()).toBe(0);
    expect(b.acquire("third")).toBe(false); // over budget
    expect(b.inUse().sort()).toEqual(["ball", "dice"]);
  });

  it("acquire is idempotent per id (re-mount doesn't consume a second slot)", () => {
    const b = createGLBudget(1);
    expect(b.acquire("ball")).toBe(true);
    expect(b.acquire("ball")).toBe(true); // same id — still granted, no double-count
    expect(b.available()).toBe(0);
    expect(b.inUse()).toEqual(["ball"]);
  });

  it("release frees a slot for the next island", () => {
    const b = createGLBudget(1);
    expect(b.acquire("ball")).toBe(true);
    expect(b.acquire("dice")).toBe(false);
    b.release("ball");
    expect(b.available()).toBe(1);
    expect(b.acquire("dice")).toBe(true);
  });

  it("releasing an unknown id is a no-op", () => {
    const b = createGLBudget(2);
    b.acquire("ball");
    b.release("ghost");
    expect(b.inUse()).toEqual(["ball"]);
    expect(b.available()).toBe(1);
  });

  it("exposes its max", () => {
    expect(createGLBudget(2).max).toBe(2);
    expect(createGLBudget().max).toBe(2); // default cap
  });
});
