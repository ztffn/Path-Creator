// Regression tests for the demo's pure animation-track math (evaluateAnimation):
// native 1:1 vs retimed (slow-mo / hold / reverse) window mapping, hold-through-gap,
// before-first-clip silence, active-clip / active-track precedence, and scrub
// determinism (same t -> same local time). This is the scrub-safe contract.
import { describe, expect, it } from "vitest";
import { evaluateAnimation, maxClipEnd, EMPTY_EXTRA_TRACKS, type AnimationTrack } from "./extra-tracks";

const track = (clips: AnimationTrack["clips"], over: Partial<AnimationTrack> = {}): AnimationTrack => ({
  id: "t",
  objectId: "fox",
  clips,
  ...over
});

describe("evaluateAnimation window mapping", () => {
  it("native (no clipEnd) advances clip-local time 1:1 with t inside the window", () => {
    const t = track([{ id: "c", clipName: "Run", start: 2, end: 6 }]);
    expect(evaluateAnimation([t], 2).get("fox")).toEqual({ clipName: "Run", localTime: 0, weight: 1, loop: true });
    expect(evaluateAnimation([t], 4).get("fox")?.localTime).toBeCloseTo(2, 6);
    expect(evaluateAnimation([t], 6).get("fox")?.localTime).toBeCloseTo(4, 6);
  });

  it("carries the loop flag (default loop; 'once' => loop:false)", () => {
    const looped = track([{ id: "c", clipName: "Run", start: 0, end: 4 }]);
    const once = track([{ id: "c", clipName: "Run", start: 0, end: 4, loop: "once" }]);
    expect(evaluateAnimation([looped], 1).get("fox")?.loop).toBe(true);
    expect(evaluateAnimation([once], 1).get("fox")?.loop).toBe(false);
  });

  it("retimed (clipEnd set) maps the window onto [clipStart, clipEnd]", () => {
    // 4s window plays 1s of clip => slow-mo (quarter speed).
    const slow = track([{ id: "c", clipName: "Walk", start: 0, end: 4, clipStart: 0, clipEnd: 1 }]);
    expect(evaluateAnimation([slow], 2).get("fox")?.localTime).toBeCloseTo(0.5, 6);
    // clipStart == clipEnd => hold on a single frame.
    const hold = track([{ id: "c", clipName: "Walk", start: 0, end: 4, clipStart: 0.7, clipEnd: 0.7 }]);
    expect(evaluateAnimation([hold], 3).get("fox")?.localTime).toBeCloseTo(0.7, 6);
    // clipEnd < clipStart => reverse.
    const rev = track([{ id: "c", clipName: "Walk", start: 0, end: 4, clipStart: 1, clipEnd: 0 }]);
    expect(evaluateAnimation([rev], 1).get("fox")?.localTime).toBeCloseTo(0.75, 6);
  });

  it("holds the window-end frame through a following gap (like camera 'hold' gapMode)", () => {
    const t = track([{ id: "c", clipName: "Run", start: 0, end: 3 }]);
    expect(evaluateAnimation([t], 10).get("fox")?.localTime).toBeCloseTo(3, 6); // native: clamped to span
    const retimed = track([{ id: "c", clipName: "Run", start: 0, end: 3, clipStart: 0, clipEnd: 2 }]);
    expect(evaluateAnimation([retimed], 10).get("fox")?.localTime).toBeCloseTo(2, 6); // clamped to clipEnd
  });

  it("leaves the model un-driven before its first clip", () => {
    const t = track([{ id: "c", clipName: "Run", start: 5, end: 8 }]);
    expect(evaluateAnimation([t], 2).has("fox")).toBe(false);
  });

  it("the last started clip wins when clips overlap", () => {
    const t = track([
      { id: "a", clipName: "Walk", start: 0, end: 4 },
      { id: "b", clipName: "Run", start: 2, end: 6 }
    ]);
    expect(evaluateAnimation([t], 3).get("fox")?.clipName).toBe("Run");
    expect(evaluateAnimation([t], 1).get("fox")?.clipName).toBe("Walk");
  });

  it("a later track binding the same model wins", () => {
    const a = track([{ id: "c", clipName: "Walk", start: 0, end: 4 }], { id: "a" });
    const b = track([{ id: "c", clipName: "Run", start: 0, end: 4 }], { id: "b" });
    expect(evaluateAnimation([a, b], 1).get("fox")?.clipName).toBe("Run");
  });

  it("is a pure function of t (scrub == play == replay)", () => {
    const t = track([{ id: "c", clipName: "Run", start: 0, end: 4 }]);
    const at = (x: number) => evaluateAnimation([t], x).get("fox")?.localTime;
    for (const x of [0, 1.3, 2.7, 3.9]) expect(at(x)).toBeCloseTo(at(x)!, 9);
    expect(at(2.7)).toBeCloseTo(2.7, 6);
  });
});

describe("maxClipEnd", () => {
  it("includes animation-track clip ends", () => {
    const tracks = { ...EMPTY_EXTRA_TRACKS, animationTracks: [track([{ id: "c", clipName: "Run", start: 1, end: 9 }])] };
    expect(maxClipEnd(tracks)).toBe(9);
  });
});
