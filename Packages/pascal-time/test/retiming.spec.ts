// Whole-track retiming (the lane dock's drag/resize gesture): a shift moves every channel's
// keys uniformly; a resize scales times about the new start AND scales each tangent handle's
// time component — a tangent is a real (Δtime, Δvalue) control point, and an unscaled Δtime
// would reshape every curve as a side effect of retiming. Purity is load-bearing (Pascal's
// undo snapshot aliases the old arrays), so no-mutation is asserted, not assumed.
import { describe, expect, it } from "vitest";
import { retimeTransformTrack, transformTrackSpan, type PersistedTrack } from "../src/index";

type TransformTrack = Extract<PersistedTrack, { type: "transform" }>;

const TRACK: TransformTrack = {
  type: "transform",
  id: "t",
  objectId: "obj",
  position: [
    { time: 2, value: [0, 0, 0], tangentsAxes: [{ out: [0.5, 1] }, null, null] as never },
    { time: 6, value: [0, 3, 0], easing: "easeInOut" }
  ],
  rotation: [{ time: 4, value: [0, 1, 0] }]
};

describe("transformTrackSpan", () => {
  it("spans first to last key across ALL channels", () => {
    expect(transformTrackSpan(TRACK)).toEqual({ start: 2, end: 6 });
  });

  it("is null for a track with no keys", () => {
    expect(transformTrackSpan({ type: "transform", id: "e", objectId: "o" })).toBeNull();
  });
});

describe("retimeTransformTrack", () => {
  it("a same-length move shifts every channel uniformly and keeps tangents untouched", () => {
    const next = retimeTransformTrack(TRACK, 5, 9);
    expect(next.position?.map((k) => k.time)).toEqual([5, 9]);
    expect(next.rotation?.map((k) => k.time)).toEqual([7]);
    expect(next.position?.[0]?.tangentsAxes?.[0]).toEqual({ out: [0.5, 1] });
    expect(next.position?.[1]?.easing).toBe("easeInOut");
  });

  it("a resize scales key times about the start AND each tangent's time component", () => {
    const next = retimeTransformTrack(TRACK, 2, 10); // span 4 -> 8, factor 2
    expect(next.position?.map((k) => k.time)).toEqual([2, 10]);
    expect(next.rotation?.map((k) => k.time)).toEqual([6]);
    // Δtime doubles, Δvalue stays.
    expect(next.position?.[0]?.tangentsAxes?.[0]).toEqual({ out: [1, 1] });
  });

  it("a single-key track shifts and never scales", () => {
    const single: TransformTrack = {
      type: "transform",
      id: "s",
      objectId: "obj",
      position: [{ time: 3, value: [1, 1, 1] }]
    };
    const next = retimeTransformTrack(single, 7, 7.25);
    expect(next.position?.[0]?.time).toBe(7);
    expect(next.position?.[0]?.value).toEqual([1, 1, 1]);
  });

  it("never mutates its input — the undo snapshot aliases these arrays", () => {
    Object.freeze(TRACK);
    Object.freeze(TRACK.position);
    Object.freeze(TRACK.position![0]);
    Object.freeze(TRACK.rotation);
    const next = retimeTransformTrack(TRACK, 0, 4);
    expect(next).not.toBe(TRACK);
    expect(TRACK.position?.[0]?.time).toBe(2);
  });
});
