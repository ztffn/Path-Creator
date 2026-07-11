// Regression tests for the demo's pure animation-track math (evaluateAnimation):
// native 1:1 vs retimed (slow-mo / hold / reverse) window mapping, hold-through-gap,
// before-first-clip silence, active-clip / active-track precedence, and scrub
// determinism (same t -> same local time). This is the scrub-safe contract.
import { describe, expect, it } from "vitest";
import { evaluateAnimation, maxClipEnd, EMPTY_EXTRA_TRACKS, type AnimationTrack } from "./extra-tracks";

const track = (clips: AnimationTrack["clips"], over: Partial<AnimationTrack> = {}): AnimationTrack => ({
  type: "animation",
  id: "t",
  objectId: "fox",
  clips,
  ...over
});
const samplesAt = (t: AnimationTrack, time: number) => evaluateAnimation([t], time).get("fox") ?? [];
const sampleAt = (t: AnimationTrack, time: number) => samplesAt(t, time).at(-1);

describe("evaluateAnimation window mapping", () => {
  it("native (no clipEnd) advances clip-local time 1:1 with t inside the window", () => {
    const t = track([{ id: "c", clipName: "Run", start: 2, end: 6 }]);
    expect(evaluateAnimation([t], 2).get("fox")).toEqual([{ clipName: "Run", localTime: 0, weight: 1, loop: true }]);
    expect(sampleAt(t, 4)?.localTime).toBeCloseTo(2, 6);
    expect(sampleAt(t, 6)?.localTime).toBeCloseTo(4, 6);
  });

  it("carries the loop flag (default loop; 'once' => loop:false)", () => {
    const looped = track([{ id: "c", clipName: "Run", start: 0, end: 4 }]);
    const once = track([{ id: "c", clipName: "Run", start: 0, end: 4, loop: "once" }]);
    expect(sampleAt(looped, 1)?.loop).toBe(true);
    expect(sampleAt(once, 1)?.loop).toBe(false);
  });

  it("retimed (clipEnd set) maps the window onto [clipStart, clipEnd]", () => {
    // 4s window plays 1s of clip => slow-mo (quarter speed).
    const slow = track([{ id: "c", clipName: "Walk", start: 0, end: 4, clipStart: 0, clipEnd: 1 }]);
    expect(sampleAt(slow, 2)?.localTime).toBeCloseTo(0.5, 6);
    // clipStart == clipEnd => hold on a single frame.
    const hold = track([{ id: "c", clipName: "Walk", start: 0, end: 4, clipStart: 0.7, clipEnd: 0.7 }]);
    expect(sampleAt(hold, 3)?.localTime).toBeCloseTo(0.7, 6);
    // clipEnd < clipStart => reverse.
    const rev = track([{ id: "c", clipName: "Walk", start: 0, end: 4, clipStart: 1, clipEnd: 0 }]);
    expect(sampleAt(rev, 1)?.localTime).toBeCloseTo(0.75, 6);
  });

  it("holds the window-end frame through a following gap (like camera 'hold' gapMode)", () => {
    const t = track([{ id: "c", clipName: "Run", start: 0, end: 3 }]);
    expect(sampleAt(t, 10)?.localTime).toBeCloseTo(3, 6); // native: clamped to span
    const retimed = track([{ id: "c", clipName: "Run", start: 0, end: 3, clipStart: 0, clipEnd: 2 }]);
    expect(sampleAt(retimed, 10)?.localTime).toBeCloseTo(2, 6); // clamped to clipEnd
  });

  it("leaves the model un-driven before its first clip", () => {
    const t = track([{ id: "c", clipName: "Run", start: 5, end: 8 }]);
    expect(evaluateAnimation([t], 2).has("fox")).toBe(false);
  });

  it("crossfades overlapping clips with complementary weights", () => {
    const t = track([
      { id: "a", clipName: "Walk", start: 0, end: 4 },
      { id: "b", clipName: "Run", start: 2, end: 6 }
    ]);
    expect(samplesAt(t, 2).map(({ clipName, weight }) => [clipName, weight])).toEqual([["Walk", 1], ["Run", 0]]);
    expect(samplesAt(t, 3).map(({ clipName, weight }) => [clipName, weight])).toEqual([["Walk", 0.5], ["Run", 0.5]]);
    expect(sampleAt(t, 4)?.clipName).toBe("Run");
    expect(sampleAt(t, 1)?.clipName).toBe("Walk");
  });

  it("uses the incoming time when the same baked clip overlaps itself", () => {
    const t = track([
      { id: "a", clipName: "Walk", start: 0, end: 4 },
      { id: "b", clipName: "Walk", start: 2, end: 6 }
    ]);
    expect(samplesAt(t, 3)).toEqual([{ clipName: "Walk", localTime: 1, weight: 1, loop: true }]);
  });

  it("a later track binding the same model wins", () => {
    const a = track([{ id: "c", clipName: "Walk", start: 0, end: 4 }], { id: "a" });
    const b = track([{ id: "c", clipName: "Run", start: 0, end: 4 }], { id: "b" });
    expect(sampleAt(b, 1)?.clipName).toBe("Run");
    expect(evaluateAnimation([a, b], 1).get("fox")?.at(-1)?.clipName).toBe("Run");
  });

  it("is a pure function of t (scrub == play == replay)", () => {
    const t = track([{ id: "c", clipName: "Run", start: 0, end: 4 }]);
    const at = (x: number) => sampleAt(t, x)?.localTime;
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
