// Regression tests for the demo's pure transform-track math (evaluateTransform):
// per-channel keyframe sampling (hold before first / after last, eased lerp between),
// present-channel-only output, channel-wise merge across tracks, and scrub
// determinism. Plus the span/bounds helpers used by the timeline lane.
import { describe, expect, it } from "vitest";
import { evaluateTransform, transformSpan, transformBlock, maxClipEnd, insertTransformKey, upsertTransformKey, EMPTY_EXTRA_TRACKS, type TransformTrack } from "./extra-tracks";
import type { AxisTangent } from "@huma/path-creator/core";

const track = (over: Partial<TransformTrack> = {}): TransformTrack => ({ type: "transform", id: "t", objectId: "obj", ...over });

describe("evaluateTransform", () => {
  it("holds before the first key and after the last", () => {
    const t = track({ position: [{ time: 1, value: [0, 0, 0] }, { time: 3, value: [10, 0, 0] }] });
    expect(evaluateTransform([t], 0).get("obj")?.position).toEqual([0, 0, 0]);
    expect(evaluateTransform([t], 5).get("obj")?.position).toEqual([10, 0, 0]);
  });

  it("eased-lerps between keys (linear midpoint)", () => {
    const t = track({ position: [{ time: 0, value: [0, 0, 0] }, { time: 4, value: [8, 4, 0], easing: "linear" }] });
    expect(evaluateTransform([t], 2).get("obj")?.position).toEqual([4, 2, 0]);
  });

  it("scale interpolates linearly by default (straight-tangent bezier == lerp)", () => {
    const t = track({ scale: [{ time: 0, value: [1, 1, 1] }, { time: 2, value: [3, 3, 3] }] });
    const s = evaluateTransform([t], 1).get("obj")?.scale;
    expect(s?.[0]).toBeCloseTo(2, 5); // default 1/3-chord tangents -> straight -> lerp(1,3,0.5)=2
  });

  it("curves a position axis via per-axis bezier tangents (x bulges; y/z stay straight)", () => {
    // x's out/in handles lift the control points above the chord -> the curve bulges above
    // the linear 5 at the midpoint. y/z have no tangents -> straight -> 5.
    const t = track({ position: [
      { time: 0, value: [0, 0, 0], tangentsAxes: [{ out: [1, 8] }, {}, {}] },
      { time: 2, value: [10, 10, 10], tangentsAxes: [{ in: [-1, 0] }, {}, {}] }
    ] });
    const p = evaluateTransform([t], 1).get("obj")?.position; // midpoint
    expect(p?.[1]).toBeCloseTo(5, 5); // y: straight -> 5
    expect(p?.[2]).toBeCloseTo(5, 5); // z: straight -> 5
    expect(p?.[0]).toBeGreaterThan(6); // x: lifted tangent bulges above linear
  });

  it("bezier tangents bulge a curve between equal-value keys (impossible with an eased lerp)", () => {
    // Both endpoints are 1, but lifted tangents make the curve rise above 1 mid-segment —
    // the capability an eased lerp (value pinned to [a,b]) fundamentally cannot express.
    const t = track({ scale: [
      { time: 0, value: [1, 1, 1], tangentsAxes: [{ out: [0.7, 1.5] }, {}, {}] },
      { time: 2, value: [1, 1, 1], tangentsAxes: [{ in: [-0.7, 1.5] }, {}, {}] }
    ] });
    const s = evaluateTransform([t], 1).get("obj")?.scale;
    expect(s?.[0]).toBeGreaterThan(1.3); // x bulges above the flat endpoints
    expect(s?.[1]).toBeCloseTo(1, 5); // y: no tangent -> stays flat
  });

  it("rotation ignores tangentsAxes and slerps with the shared easing", () => {
    const t = track({ rotation: [
      { time: 0, value: [0, 0, 0] },
      { time: 2, value: [0, 90, 0], easing: "linear", tangentsAxes: [{ out: [1, 50] }, { out: [1, 50] }, { out: [1, 50] }] }
    ] });
    // If tangentsAxes were (wrongly) applied, the midpoint would be far from a linear slerp.
    const q = evaluateTransform([t], 1).get("obj")?.rotation; // ~45° about Y
    expect(q?.[1]).toBeCloseTo(Math.sin(Math.PI / 8), 4);
  });

  it("emits only the channels that have keys; rotation as a quaternion", () => {
    const t = track({ rotation: [{ time: 0, value: [0, 90, 0] }] });
    const got = evaluateTransform([t], 0).get("obj");
    // 90° about Y -> quaternion (0, sin45, 0, cos45).
    expect(got?.rotation?.[1]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(got?.rotation?.[3]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(got?.position).toBeUndefined();
    expect(got?.scale).toBeUndefined();
  });

  it("slerps rotation the shortest way (350°→10° about Z passes through 0°, not 180°)", () => {
    const t = track({ rotation: [{ time: 0, value: [0, 0, 350], easing: "linear" }, { time: 2, value: [0, 0, 10], easing: "linear" }] });
    const q = evaluateTransform([t], 1).get("obj")?.rotation;
    // Short arc midpoint is ~0° => z≈0, w≈±1. Naive euler-lerp would give 180° => z≈1.
    expect(Math.abs(q![2])).toBeLessThan(0.05);
    expect(Math.abs(q![3])).toBeGreaterThan(0.99);
  });

  it("merges channel-wise across tracks binding the same object (later wins per channel)", () => {
    const a = track({ id: "a", position: [{ time: 0, value: [1, 0, 0] }] });
    const b = track({ id: "b", scale: [{ time: 0, value: [2, 2, 2] }], position: [{ time: 0, value: [9, 0, 0] }] });
    const got = evaluateTransform([a, b], 0).get("obj");
    expect(got?.position).toEqual([9, 0, 0]); // b overrides a's position
    expect(got?.scale).toEqual([2, 2, 2]);
  });

  it("is a pure function of t", () => {
    const t = track({ position: [{ time: 0, value: [0, 0, 0] }, { time: 4, value: [8, 0, 0] }] });
    const at = (x: number) => evaluateTransform([t], x).get("obj")?.position?.[0];
    expect(at(2.5)).toBeCloseTo(at(2.5)!, 9);
    expect(at(1)).toBeCloseTo(2, 6);
  });
});

describe("transformSpan / maxClipEnd", () => {
  it("spans the first..last keyed time across channels", () => {
    const t = track({ position: [{ time: 1, value: [0, 0, 0] }], scale: [{ time: 5, value: [1, 1, 1] }] });
    expect(transformSpan(t)).toEqual({ start: 1, end: 5 });
    expect(transformSpan(track())).toBeNull();
  });

  it("maxClipEnd includes transform key times", () => {
    const tracks = { ...EMPTY_EXTRA_TRACKS, transformTracks: [track({ rotation: [{ time: 7, value: [0, 0, 0] }] })] };
    expect(maxClipEnd(tracks)).toBe(7);
  });
});

describe("transformBlock (timeline lane block)", () => {
  it("is null for an empty track", () => {
    expect(transformBlock(track())).toBeNull();
  });

  it("spans first→last key and marks the union of key times (normalized 0..1)", () => {
    const t = track({ position: [{ time: 2, value: [0, 0, 0] }, { time: 6, value: [8, 0, 0] }], scale: [{ time: 4, value: [1, 1, 1] }] });
    const block = transformBlock(t, 0, 5);
    expect(block?.start).toBe(2);
    expect(block?.end).toBe(6);
    expect(block?.channels).toEqual(["position", "scale"]);
    const markers = block!.series.at(-1)!;
    expect(markers.kind).toBe("markers");
    expect(markers.points).toEqual([0, 0.5, 1]); // times 2,4,6 over span [2,6]
  });

  it("draws position as three per-axis curves (x/y/z) plus the markers series", () => {
    const t = track({ position: [{ time: 0, value: [0, 0, 0] }, { time: 4, value: [10, 0, 0] }] });
    const block = transformBlock(t, 0, 5)!;
    expect(block.series.map((s) => s.kind)).toEqual(["line", "line", "line", "markers"]);
    // Shared value range across x/y/z: x moves 0->10 (fills 0..1), y and z are flat.
    const [x, y, z] = block.series;
    expect(Math.min(...x!.points)).toBeCloseTo(0, 6);
    expect(Math.max(...x!.points)).toBeCloseTo(1, 6);
    expect(y!.points.every((v) => v === 0)).toBe(true); // y constant at shared-range min
    expect(z!.points.every((v) => v === 0)).toBe(true);
    expect(new Set([x!.color, y!.color, z!.color]).size).toBe(3); // distinct RGB tints
  });

  it("draws no curves for a rotation/scale-only track — markers only", () => {
    const block = transformBlock(track({ scale: [{ time: 3, value: [2, 2, 2] }] }), 2, 4)!;
    expect(block.start).toBe(3);
    expect(block.end).toBe(5); // padded 3 -> 3+minWidth
    expect(block.series.map((s) => s.kind)).toEqual(["markers"]); // scale not curve-drawn
    expect(block.series.at(-1)!.points).toEqual([0]); // key at start -> left edge, not centered
  });

  it("pads a short real span up to minWidth and keeps markers aligned to the padded width", () => {
    const t = track({ position: [{ time: 0, value: [0, 0, 0] }, { time: 1, value: [4, 0, 0] }] });
    const block = transformBlock(t, 4, 5)!; // real span 1 -> padded to 4
    expect(block.end).toBe(4);
    expect(block.series.at(-1)!.points).toEqual([0, 0.25]); // times 0,1 over displayed width 4
  });
});

describe("key insertion helpers", () => {
  it("insertTransformKey seeds from the curve so the pose does not move, and no-ops on a duplicate time", () => {
    const keys = [{ time: 0, value: [0, 0, 0] as [number, number, number] }, { time: 4, value: [8, 0, 0] as [number, number, number] }];
    const inserted = insertTransformKey(keys, 2, [1, 1, 1]);
    expect(inserted.map((k) => k.time)).toEqual([0, 2, 4]);
    expect(inserted[1]!.value).toEqual([4, 0, 0]); // what the ramp already reads at t=2 — not the prior key's 0
    expect(evaluateTransform([{ type: "transform", id: "t", objectId: "o", position: inserted }], 2).get("o")!.position)
      .toEqual([4, 0, 0]); // and the curve is unchanged by the insert
    expect(insertTransformKey(keys, 4, [1, 1, 1])).toHaveLength(2); // duplicate time -> no-op
    expect(insertTransformKey(undefined, 1, [5, 5, 5])[0]!.value).toEqual([5, 5, 5]); // fallback when empty
  });

  it("insertTransformKey follows the eased slerp timing on a rotation channel", () => {
    const keys = [{ time: 0, value: [0, 0, 0] as [number, number, number] }, { time: 4, value: [0, 90, 0] as [number, number, number], easing: "linear" as const }];
    expect(insertTransformKey(keys, 2, [0, 0, 0], "rotation")[1]!.value).toEqual([0, 45, 0]);
  });

  it("upsertTransformKey overwrites the value at a time (keeping easing AND tangent handles) or inserts sorted", () => {
    const tangents: [AxisTangent, AxisTangent, AxisTangent] = [{ out: [0.5, 2] }, {}, {}];
    const keys = [{ time: 2, value: [0, 0, 0] as [number, number, number], easing: "easeIn" as const, tangentsAxes: tangents }];
    const over = upsertTransformKey(keys, 2, [9, 9, 9]);
    expect(over).toHaveLength(1);
    expect(over[0]!.value).toEqual([9, 9, 9]);
    expect(over[0]!.easing).toBe("easeIn"); // preserved (rotation's slerp timing)
    expect(over[0]!.tangentsAxes).toEqual(tangents); // preserved — this is what position/scale read
    expect(upsertTransformKey(keys, 0, [1, 1, 1]).map((k) => k.time)).toEqual([0, 2]); // inserted, sorted
  });

  it("plays a pre-v6 key's easing on position when no tangent handles are authored", () => {
    // Documents saved before tangent handles shaped position/scale with `easing`; honouring
    // it here is what keeps them playing as written instead of silently going linear.
    const eased: TransformTrack = {
      type: "transform", id: "t", objectId: "o",
      position: [{ time: 0, value: [0, 0, 0] }, { time: 4, value: [8, 0, 0], easing: "easeIn" }]
    };
    const linear: TransformTrack = {
      type: "transform", id: "t", objectId: "o",
      position: [{ time: 0, value: [0, 0, 0] }, { time: 4, value: [8, 0, 0] }]
    };
    expect(evaluateTransform([eased], 2).get("o")!.position![0]).toBeLessThan(4); // ease-in lags the ramp
    expect(evaluateTransform([linear], 2).get("o")!.position![0]).toBe(4);
  });
});
