// Tests for the shared curve-interaction core (curve-canvas): domain<->pixel scaling
// in real (incl. negative) ranges, and the edit reducers — anchor drag with neighbor
// clamping and endpoint pinning, handle drag, add (sorted, seeds tangents), and remove.
// Guards the one interaction codebase that EasingEditor and KeyframeCurveEditor share.
import { describe, expect, it } from "vitest";
import {
  addAnchor,
  dragAnchor,
  dragHandle,
  insertIndexFor,
  makeScale,
  removeAnchor,
  type Axis
} from "../src/timeline-ui/curve-canvas";
import type { EasingCurveKey } from "../src/core";

const keys = (...xs: [number, number][]): EasingCurveKey[] => xs.map(([x, y]) => ({ x, y }));
const WIDE: Axis = { min: -Infinity, max: Infinity };

describe("makeScale", () => {
  it("maps a real (negative) domain to pixels and back", () => {
    const s = makeScale({ min: -5, max: 5 }, 200);
    expect(s.toPx(-5)).toBe(0);
    expect(s.toPx(5)).toBe(200);
    expect(s.toPx(0)).toBe(100);
    expect(s.toValue(100)).toBeCloseTo(0, 9);
    expect(s.toValue(0)).toBeCloseTo(-5, 9);
  });
  it("degenerate (zero-span) domain does not divide by zero", () => {
    const s = makeScale({ min: 3, max: 3 }, 100);
    expect(Number.isFinite(s.toPx(3))).toBe(true);
  });
});

describe("dragAnchor", () => {
  it("clamps an interior anchor between its neighbors", () => {
    const k = keys([0, 0], [1, 1], [2, 0]);
    const out = dragAnchor(k, 1, 5, 0.5, { yBounds: WIDE });
    expect(out[1]!.x).toBeLessThan(2);
    expect(out[1]!.x).toBeGreaterThan(0);
  });
  it("moves an endpoint freely in x/y when unpinned (keyframe semantics)", () => {
    const k = keys([0, 0], [2, 4]);
    const out = dragAnchor(k, 0, -3, -2, { yBounds: WIDE });
    expect(out[0]!.x).toBe(-3);
    expect(out[0]!.y).toBe(-2);
  });
  it("pins endpoints in x and y when asked (easing semantics)", () => {
    const k = keys([0, 0], [0.5, 0.5], [1, 1]);
    const opts = {
      yBounds: { min: -0.5, max: 1.5 },
      pinnedX: (_i: number, f: boolean, l: boolean) => (f ? 0 : l ? 1 : undefined),
      pinnedY: (_i: number, f: boolean, l: boolean) => (f || l ? (f ? 0 : 1) : undefined)
    };
    const first = dragAnchor(k, 0, 0.4, 0.9, opts);
    expect(first[0]).toEqual({ x: 0, y: 0 });
    const last = dragAnchor(k, 2, 0.4, 0.1, opts);
    expect(last[2]).toEqual({ x: 1, y: 1 });
    const mid = dragAnchor(k, 1, 0.6, 0.7, opts);
    expect(mid[1]!.x).toBeCloseTo(0.6, 9);
    expect(mid[1]!.y).toBeCloseTo(0.7, 9);
  });
  it("clamps interior y to yBounds", () => {
    const k = keys([0, 0], [1, 0], [2, 0]);
    const out = dragAnchor(k, 1, 1, 99, { yBounds: { min: -0.5, max: 1.5 } });
    expect(out[1]!.y).toBe(1.5);
  });
});

describe("dragHandle", () => {
  it("sets the dragged side's handle, clamped to its segment", () => {
    const k = keys([0, 0], [1, 1], [2, 0]);
    const out = dragHandle(k, 1, "out", 5, 0.5, WIDE);
    expect(out[1]!.out!.x).toBeLessThanOrEqual(2);
    expect(out[1]!.out!.x).toBeGreaterThanOrEqual(1);
  });
});

describe("addAnchor / removeAnchor / insertIndexFor", () => {
  it("inserts sorted with seeded tangent handles", () => {
    const k = keys([0, 0], [2, 2]);
    const out = addAnchor(k, 1, 1, { min: 0, max: 2 }, WIDE);
    expect(out.map((a) => a.x)).toEqual([0, 1, 2]);
    expect(out[1]!.in || out[1]!.out).toBeTruthy();
  });
  it("clamps the insertion point to the given bounds", () => {
    const k = keys([0, 0], [4, 0]);
    const out = addAnchor(k, 99, 3, { min: 0, max: 4 }, { min: 0, max: 2 });
    const added = out.find((a) => a.x === 4 && a !== k[1]) ?? out[out.length - 1]!;
    expect(added.x).toBeLessThanOrEqual(4);
    expect(added.y).toBeLessThanOrEqual(2);
  });
  it("insertIndexFor counts anchors left of x", () => {
    const k = keys([0, 0], [2, 0], [4, 0]);
    expect(insertIndexFor(k, 3)).toBe(2);
    expect(insertIndexFor(k, -1)).toBe(0);
  });
  it("removeAnchor drops the given index", () => {
    const k = keys([0, 0], [1, 1], [2, 0]);
    expect(removeAnchor(k, 1).map((a) => a.x)).toEqual([0, 2]);
  });
});
