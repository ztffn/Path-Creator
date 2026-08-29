import { describe, expect, it } from "vitest";
import {
  extraClipKey,
  parseExtraClipKey,
  rippleClips,
  selectionForDrag,
  shiftClips,
  snapMoves,
  toggleSelection,
  type ExtraClipMove
} from "../src/timeline-ui/clip-selection";

const clip = (laneId: string, start: number, end: number): ExtraClipMove => ({
  laneId,
  clipId: "clip",
  start,
  end
});

describe("clip selection keys", () => {
  it("round-trips a lane and clip id", () => {
    expect(parseExtraClipKey(extraClipKey("letters", "clip"))).toEqual({
      laneId: "letters",
      clipId: "clip"
    });
  });

  it("survives a clip id containing the separator", () => {
    // The lane id is read up to the FIRST separator, so only the clip id may contain one.
    expect(parseExtraClipKey(extraClipKey("lane", "a|b"))).toEqual({ laneId: "lane", clipId: "a|b" });
  });

  it("rejects anything that is not a clip key", () => {
    expect(parseExtraClipKey("shot-track")).toBeNull();
    expect(parseExtraClipKey("move-shot1")).toBeNull();
  });
});

describe("selection gestures", () => {
  it("replaces the selection on a plain click", () => {
    expect(toggleSelection(["a", "b"], "c", false)).toEqual(["c"]);
  });

  it("adds and removes on an additive click", () => {
    expect(toggleSelection(["a"], "b", true)).toEqual(["a", "b"]);
    expect(toggleSelection(["a", "b"], "a", true)).toEqual(["b"]);
  });

  it("keeps the whole set when a drag grabs something already selected", () => {
    expect(selectionForDrag(["a", "b", "c"], "b")).toEqual(["a", "b", "c"]);
  });

  it("drops the set when a drag grabs something outside it", () => {
    // Dragging an unselected clip must not move clips the user cannot see selected.
    expect(selectionForDrag(["a", "b"], "z")).toEqual(["z"]);
  });
});

describe("moving a set", () => {
  it("shifts every clip by the same delta, preserving the gaps", () => {
    const moved = shiftClips([clip("a", 1, 1.5), clip("b", 2, 2.2)], 0.5);
    expect(moved.map((m) => [m.start, m.end])).toEqual([
      [1.5, 2],
      [2.5, 2.7]
    ]);
  });

  it("clamps against zero as a rigid body rather than piling clips up on the edge", () => {
    // -5 would put both negative; the earliest stops at 0 and the second keeps its gap.
    const moved = shiftClips([clip("a", 1, 1.5), clip("b", 2, 2.2)], -5);
    const flat = moved.flatMap((m) => [m.start, m.end]);
    [0, 0.5, 1, 1.2].forEach((expected, index) => {
      expect(flat[index]).toBeCloseTo(expected, 9);
    });
  });

  it("does nothing to an empty selection", () => {
    expect(shiftClips([], 1)).toEqual([]);
  });
});

describe("ripple", () => {
  const show = [clip("early", 0, 0.5), clip("straddling", 1, 3), clip("late", 2, 2.4)];

  it("moves only what starts at or after the point", () => {
    const moves = rippleClips(show, 2, 0.5);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ laneId: "late", start: 2.5, end: 2.9 });
  });

  it("includes a clip starting exactly on the point", () => {
    expect(rippleClips(show, 1, 0.25).map((m) => m.laneId)).toEqual(["straddling", "late"]);
  });

  it("leaves a straddling clip alone instead of stretching it", () => {
    // It starts before the point, so a ripple must not touch it — stretching here is how
    // a duration somebody tuned goes missing.
    expect(rippleClips(show, 2, 0.5).some((m) => m.laneId === "straddling")).toBe(false);
  });

  it("removes time with a negative delta", () => {
    expect(rippleClips(show, 2, -0.5)[0]).toMatchObject({ start: 1.5 });
  });
});

describe("snapping a set", () => {
  it("snaps the start and carries the length across", () => {
    // Re-snapping the end independently would resize any clip whose length is not a whole
    // number of steps, as a side effect of moving it.
    const [snapped] = snapMoves([clip("a", 1.03, 1.53)], 0.25);
    expect(snapped).toMatchObject({ start: 1, end: 1.5 });
  });

  it("never snaps a clip before zero", () => {
    expect(snapMoves([clip("a", 0.04, 0.2)], 0.25)[0]?.start).toBe(0);
  });

  it("passes moves through untouched when snapping is off", () => {
    expect(snapMoves([clip("a", 1.037, 1.537)], 0)[0]).toMatchObject({ start: 1.037 });
  });
});
