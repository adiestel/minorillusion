import { describe, expect, it } from "vitest";
import { transcriptStateSchema } from "@minorillusion/contract";
import {
  addEntry,
  deleteEntry,
  editEntry,
  emptyTranscript,
  renderTranscript,
  selectEntries,
  setRecording,
  summarySystemPrompt,
} from "./transcript.js";

/**
 * Pure-helper unit tests for the room transcript/log — no I/O, no socket. We
 * exercise the add/edit/delete rules directly (each returns a NEW state, never
 * mutating the input), plus the selection + render + prompt helpers. The socket
 * layer just holds the per-circle TranscriptState and feeds it through these.
 */

const CIRCLE = "00000000-0000-0000-0000-000000000010";

describe("addEntry", () => {
  it("appends a stamped entry carrying the circle id + source, and returns it", () => {
    const { state, entry } = addEntry(emptyTranscript(CIRCLE), {
      text: "The door creaks open.",
      source: "capture",
    });
    expect(state.entries).toHaveLength(1);
    expect(entry.text).toBe("The door creaks open.");
    expect(entry.circleId).toBe(CIRCLE);
    expect(entry.source).toBe("capture");
    expect(entry.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(typeof entry.at).toBe("string");
    // No speaker was given -> the optional field is omitted (not undefined).
    expect(entry).not.toHaveProperty("speaker");
  });

  it("carries a speaker through when provided, and omits a blank one", () => {
    const withSpeaker = addEntry(emptyTranscript(CIRCLE), {
      text: "Hold the line!",
      speaker: "Bram",
      source: "manual",
    });
    expect(withSpeaker.entry.speaker).toBe("Bram");

    const blankSpeaker = addEntry(emptyTranscript(CIRCLE), {
      text: "Anonymous murmur.",
      speaker: "",
      source: "manual",
    });
    expect(blankSpeaker.entry).not.toHaveProperty("speaker");
  });

  it("does not mutate the input state", () => {
    const before = emptyTranscript(CIRCLE);
    const snapshot = JSON.parse(JSON.stringify(before));
    addEntry(before, { text: "x", source: "manual" });
    expect(before).toEqual(snapshot);
  });

  it("preserves order across several appends", () => {
    let s = emptyTranscript(CIRCLE);
    s = addEntry(s, { text: "one", source: "manual" }).state;
    s = addEntry(s, { text: "two", source: "manual" }).state;
    s = addEntry(s, { text: "three", source: "agent" }).state;
    expect(s.entries.map((e) => e.text)).toEqual(["one", "two", "three"]);
  });

  it("produces a state that satisfies the contract schema", () => {
    const { state } = addEntry(emptyTranscript(CIRCLE), {
      text: "A valid line.",
      speaker: "GM",
      source: "manual",
    });
    expect(transcriptStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("editEntry", () => {
  it("replaces the text of a matching entry, keeping its id/source", () => {
    const added = addEntry(emptyTranscript(CIRCLE), {
      text: "teh gobln attaks",
      source: "capture",
    });
    const id = added.entry.id;
    const { state, changed } = editEntry(added.state, id, "The goblin attacks.");
    expect(changed).toBe(true);
    expect(state.entries[0]?.text).toBe("The goblin attacks.");
    expect(state.entries[0]?.id).toBe(id);
    expect(state.entries[0]?.source).toBe("capture");
  });

  it("reports changed:false (and an unchanged state) for an unknown id", () => {
    const added = addEntry(emptyTranscript(CIRCLE), {
      text: "keep me",
      source: "manual",
    });
    const { state, changed } = editEntry(added.state, "no-such-id", "nope");
    expect(changed).toBe(false);
    expect(state).toBe(added.state); // same reference -> untouched
  });

  it("does not mutate the input state", () => {
    const added = addEntry(emptyTranscript(CIRCLE), {
      text: "original",
      source: "manual",
    });
    const snapshot = JSON.parse(JSON.stringify(added.state));
    editEntry(added.state, added.entry.id, "edited");
    expect(added.state).toEqual(snapshot);
  });
});

describe("deleteEntry", () => {
  it("removes a matching entry and reports removed:true", () => {
    let s = emptyTranscript(CIRCLE);
    const a = addEntry(s, { text: "one", source: "manual" });
    s = a.state;
    const b = addEntry(s, { text: "two", source: "manual" });
    s = b.state;

    const { state, removed } = deleteEntry(s, a.entry.id);
    expect(removed).toBe(true);
    expect(state.entries.map((e) => e.text)).toEqual(["two"]);
  });

  it("reports removed:false (and an unchanged state) for an unknown id", () => {
    const added = addEntry(emptyTranscript(CIRCLE), {
      text: "stays",
      source: "manual",
    });
    const { state, removed } = deleteEntry(added.state, "no-such-id");
    expect(removed).toBe(false);
    expect(state).toBe(added.state);
  });
});

describe("setRecording", () => {
  it("flips the recording flag without touching entries", () => {
    const added = addEntry(emptyTranscript(CIRCLE), {
      text: "line",
      source: "manual",
    });
    const on = setRecording(added.state, true);
    expect(on.recording).toBe(true);
    expect(on.entries).toHaveLength(1);
    const off = setRecording(on, false);
    expect(off.recording).toBe(false);
  });
});

describe("selectEntries", () => {
  it("returns the whole transcript when no ids are given", () => {
    let s = emptyTranscript(CIRCLE);
    s = addEntry(s, { text: "a", source: "manual" }).state;
    s = addEntry(s, { text: "b", source: "manual" }).state;
    expect(selectEntries(s).map((e) => e.text)).toEqual(["a", "b"]);
  });

  it("restricts to the selected ids in transcript order, ignoring unknown ids", () => {
    let s = emptyTranscript(CIRCLE);
    const a = addEntry(s, { text: "a", source: "manual" });
    s = a.state;
    const b = addEntry(s, { text: "b", source: "manual" });
    s = b.state;
    const c = addEntry(s, { text: "c", source: "manual" });
    s = c.state;

    // Select c + a (out of order) + a stale id -> result is [a, c] (doc order).
    const picked = selectEntries(s, [c.entry.id, a.entry.id, "stale"]);
    expect(picked.map((e) => e.text)).toEqual(["a", "c"]);
  });
});

describe("renderTranscript", () => {
  it("renders one line per entry, prefixing a tagged speaker", () => {
    let s = emptyTranscript(CIRCLE);
    s = addEntry(s, { text: "The wind howls.", source: "capture" }).state;
    s = addEntry(s, { text: "I draw my sword.", speaker: "Vex", source: "manual" }).state;
    const text = renderTranscript(s.entries);
    expect(text).toBe("The wind howls.\nVex: I draw my sword.");
  });

  it("is empty for no lines", () => {
    expect(renderTranscript([])).toBe("");
  });
});

describe("summarySystemPrompt", () => {
  it("always instructs to filter out-of-character cross-talk", () => {
    for (const style of ["recap", "bullets", "dramatic"] as const) {
      const p = summarySystemPrompt(style);
      expect(p.toLowerCase()).toContain("cross-talk");
      expect(p.toLowerCase()).toContain("filter");
    }
  });

  it("varies the directive per style", () => {
    expect(summarySystemPrompt("bullets").toLowerCase()).toContain("bullet");
    expect(summarySystemPrompt("dramatic").toLowerCase()).toContain("in-world");
    expect(summarySystemPrompt("recap").toLowerCase()).toContain("recap");
  });
});
