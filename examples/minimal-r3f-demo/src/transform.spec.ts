// Regression tests for the demo's pure transform-track math (evaluateTransform):
// per-channel keyframe sampling (hold before first / after last, eased lerp between),
// present-channel-only output, channel-wise merge across tracks, and scrub
// determinism. Plus the span/bounds helpers used by the timeline lane.
import { describe, expect, it } from "vitest";
import { evaluateTransform, transformSpan, maxClipEnd, insertTransformKey, upsertTransformKey, EMPTY_EXTRA_TRACKS, type TransformTrack } from "./extra-tracks";

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

  it("applies the segment easing (easeInOut symmetric at midpoint = 0.5)", () => {
    const t = track({ scale: [{ time: 0, value: [1, 1, 1] }, { time: 2, value: [3, 3, 3], easing: "easeInOut" }] });
    const s = evaluateTransform([t], 1).get("obj")?.scale;
    expect(s?.[0]).toBeCloseTo(2, 5); // easeInOut(0.5)=0.5 -> lerp(1,3,0.5)=2
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

describe("key insertion helpers", () => {
  it("insertTransformKey holds the prior value and no-ops on a duplicate time", () => {
    const keys = [{ time: 0, value: [0, 0, 0] as [number, number, number] }, { time: 4, value: [8, 0, 0] as [number, number, number] }];
    const inserted = insertTransformKey(keys, 2, [1, 1, 1]);
    expect(inserted.map((k) => k.time)).toEqual([0, 2, 4]);
    expect(inserted[1]!.value).toEqual([0, 0, 0]); // held from the prior key, not the fallback
    expect(insertTransformKey(keys, 4, [1, 1, 1])).toHaveLength(2); // duplicate time -> no-op
    expect(insertTransformKey(undefined, 1, [5, 5, 5])[0]!.value).toEqual([5, 5, 5]); // fallback when empty
  });

  it("upsertTransformKey overwrites the value at a time (keeping easing) or inserts sorted", () => {
    const keys = [{ time: 2, value: [0, 0, 0] as [number, number, number], easing: "easeIn" as const }];
    const over = upsertTransformKey(keys, 2, [9, 9, 9]);
    expect(over).toHaveLength(1);
    expect(over[0]!.value).toEqual([9, 9, 9]);
    expect(over[0]!.easing).toBe("easeIn"); // preserved
    expect(upsertTransformKey(keys, 0, [1, 1, 1]).map((k) => k.time)).toEqual([0, 2]); // inserted, sorted
  });
});
