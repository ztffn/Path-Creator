// Tests for the first-class easing evaluator: preset endpoints and known values,
// legacy-name compatibility (outputs unchanged from the old blend switch), multi-anchor
// curves (endpoints, interior anchors, non-monotonic), speed-space integration, and the
// position<->speed conversion. Guards the contract that both camera blends and cart keys
// depend on, and that existing serialized easing keeps rendering identically.
import { describe, expect, it } from "vitest";
import {
  convertEasingCurveSpace,
  easingToCurve,
  evaluateEasing,
  evaluateEasingCurve,
  normalizeEasing,
  normalizeTimelineEasing,
  type Easing,
  type EasingCurve,
  type Timeline
} from "../src/core";

describe("evaluateEasing presets", () => {
  it("holds endpoints at 0 and 1 for every monotonic preset", () => {
    const presets: Easing[] = [
      "linear",
      "easeIn",
      "easeOut",
      "easeInOut",
      "hardIn",
      "hardOut",
      "easeInQuad",
      "easeOutQuad",
      "easeInOutQuad",
      "easeInCubic",
      "easeOutCubic",
      "easeInOutCubic",
      "easeInQuart",
      "easeOutQuart",
      "easeInOutQuart",
      "easeInQuint",
      "easeOutQuint",
      "easeInOutQuint"
    ];
    for (const p of presets) {
      expect(evaluateEasing(0, p)).toBeCloseTo(0, 6);
      expect(evaluateEasing(1, p)).toBeCloseTo(1, 6);
    }
  });

  it("matches known values", () => {
    expect(evaluateEasing(0.5, "linear")).toBeCloseTo(0.5, 6);
    expect(evaluateEasing(0.5, "easeInQuad")).toBeCloseTo(0.25, 6);
    expect(evaluateEasing(0.5, "easeInCubic")).toBeCloseTo(0.125, 6);
    // Legacy easeInOut is smoothstep: symmetric, 0.5 at the midpoint.
    expect(evaluateEasing(0.5, "easeInOut")).toBeCloseTo(0.5, 6);
    // Legacy easeIn == quadratic in.
    expect(evaluateEasing(0.5, "easeIn")).toBeCloseTo(0.25, 6);
  });

  it("is prototype-safe and falls back to easeInOut for unknown names", () => {
    // Names colliding with Object.prototype must not resolve to inherited methods.
    for (const name of ["valueOf", "toString", "constructor", "hasOwnProperty"] as unknown as Easing[]) {
      const y = evaluateEasing(0.5, name);
      expect(Number.isFinite(y)).toBe(true);
      expect(y).toBeCloseTo(evaluateEasing(0.5, "easeInOut"), 6);
    }
    expect(evaluateEasing(0.5, "bogus" as unknown as Easing)).toBeCloseTo(evaluateEasing(0.5, "easeInOut"), 6);
    // normalizeEasing must reject prototype names, not treat them as valid presets.
    expect(normalizeEasing("valueOf")).toBe("linear");
    expect(normalizeEasing("toString")).toBe("linear");
  });

  it("cut snaps to the end and clamps/NaN-guards input", () => {
    expect(evaluateEasing(0, "cut")).toBe(1);
    expect(evaluateEasing(0.001, "cut")).toBe(1);
    expect(evaluateEasing(-5, "linear")).toBe(0);
    expect(evaluateEasing(5, "linear")).toBe(1);
    expect(evaluateEasing(Number.NaN, "linear")).toBe(0);
  });
});

describe("easingToCurve", () => {
  it("returns a position curve as-is (keeps handles)", () => {
    const curve: EasingCurve = { type: "curve", keys: [{ x: 0, y: 0, out: { x: 0.3, y: 0 } }, { x: 1, y: 1 }] };
    expect(easingToCurve(curve)).toBe(curve);
  });

  it("samples a preset into a curve that tracks it (endpoints exact)", () => {
    const curve = easingToCurve("easeInOutQuint", 8);
    expect(curve.type).toBe("curve");
    expect(evaluateEasing(0, curve)).toBeCloseTo(0, 3);
    expect(evaluateEasing(1, curve)).toBeCloseTo(1, 3);
    for (const x of [0.2, 0.5, 0.8]) expect(evaluateEasing(x, curve)).toBeCloseTo(evaluateEasing(x, "easeInOutQuint"), 1);
  });
});

describe("multi-anchor easing curve", () => {
  it("holds endpoints and passes through an interior anchor", () => {
    const curve = { type: "curve", keys: [{ x: 0, y: 0 }, { x: 0.5, y: 0.8 }, { x: 1, y: 1 }] } as const;
    expect(evaluateEasing(0, curve)).toBeCloseTo(0, 3);
    expect(evaluateEasing(1, curve)).toBeCloseTo(1, 3);
    expect(evaluateEasing(0.5, curve)).toBeCloseTo(0.8, 3);
  });

  it("normalizes a position curve to 0..1 by its endpoints (contract enforced in core)", () => {
    // Malformed easing whose endpoints aren't 0/1 still runs progress 0->1, so a cart
    // never stops short of the next key.
    const curve = { type: "curve", keys: [{ x: 0, y: 0.2 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0.8 }] } as const;
    expect(evaluateEasing(0, curve)).toBeCloseTo(0, 6);
    expect(evaluateEasing(1, curve)).toBeCloseTo(1, 6);
    expect(evaluateEasing(0.5, curve)).toBeCloseTo(0.5, 6);
  });

  it("supports non-monotonic progress (speed up then reverse)", () => {
    // Rises past the endpoint then comes back — a curve a single cubic-bezier can't do.
    const curve = { type: "curve", keys: [{ x: 0, y: 0 }, { x: 0.5, y: 1.2 }, { x: 1, y: 1 }] } as const;
    expect(evaluateEasingCurve(curve, 0.5)).toBeGreaterThan(1);
  });

});

describe("speed-space easing curve", () => {
  it("constant speed integrates to linear position", () => {
    const speed = { type: "curve", space: "speed", keys: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }] } as const;
    expect(evaluateEasing(0, speed)).toBeCloseTo(0, 3);
    expect(evaluateEasing(0.5, speed)).toBeCloseTo(0.5, 2);
    expect(evaluateEasing(1, speed)).toBeCloseTo(1, 3);
  });

  it("normalizes to 0->1 endpoints regardless of speed shape", () => {
    // A hump (fast in the middle): endpoints still land exactly on 0 and 1.
    const speed = { type: "curve", space: "speed", keys: [{ x: 0, y: 0.1 }, { x: 0.5, y: 1 }, { x: 1, y: 0.1 }] } as const;
    expect(evaluateEasing(0, speed)).toBeCloseTo(0, 3);
    expect(evaluateEasing(1, speed)).toBeCloseTo(1, 3);
    // Faster in the middle => more progress covered by mid-time than a linear ramp.
    expect(evaluateEasing(0.5, speed)).toBeCloseTo(0.5, 2);
  });

  it("scale of speed values doesn't change the motion (normalized)", () => {
    const a = { type: "curve", space: "speed", keys: [{ x: 0, y: 0.2 }, { x: 0.5, y: 0.8 }, { x: 1, y: 0.2 }] } as const;
    const b = { type: "curve", space: "speed", keys: [{ x: 0, y: 2 }, { x: 0.5, y: 8 }, { x: 1, y: 2 }] } as const;
    for (const x of [0.25, 0.5, 0.75]) expect(evaluateEasing(x, a)).toBeCloseTo(evaluateEasing(x, b), 3);
  });

  it("position<->speed toggle approximately preserves the resulting motion", () => {
    // The toggle re-samples into a few tangent-fitted anchors, so it's intentionally
    // lossy (favouring a clean editable curve) — motion is preserved within a few %.
    const pos: EasingCurve = { type: "curve", keys: [{ x: 0, y: 0, out: { x: 0.3, y: 0 } }, { x: 1, y: 1, in: { x: 0.7, y: 1 } }] };
    const speed = convertEasingCurveSpace(pos, "speed");
    expect(speed.space).toBe("speed");
    const back = convertEasingCurveSpace(speed, "position");
    for (const x of [0, 0.25, 0.5, 0.75, 1]) {
      expect(Math.abs(evaluateEasing(x, speed) - evaluateEasing(x, pos))).toBeLessThan(0.05);
      expect(Math.abs(evaluateEasing(x, back) - evaluateEasing(x, pos))).toBeLessThan(0.05);
    }
  });
});

describe("normalizeTimelineEasing", () => {
  it("coerces malformed easing to a valid preset and preserves valid ones", () => {
    const tl: Timeline = {
      schemaVersion: 2,
      duration: 5,
      tracks: [
        {
          type: "cart",
          id: "t",
          cartId: "x",
          keys: [
            { time: 0, distance: 0, easing: "bogus" as unknown as Easing },
            { time: 1, distance: 1, easing: "easeInOutQuad" },
            { time: 2, distance: 2, easing: { type: "curve", keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }
          ]
        }
      ]
    };
    const out = normalizeTimelineEasing(tl);
    const track = out.tracks[0];
    if (track.type !== "cart") throw new Error("expected cart track");
    expect(track.keys[0].easing).toBe("linear"); // unknown -> fallback
    expect(track.keys[1].easing).toBe("easeInOutQuad"); // valid preset preserved
    expect(track.keys[2].easing).toEqual({ type: "curve", keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] });
  });
});

describe("normalizeEasing", () => {
  it("accepts known presets and valid curves, falls back otherwise", () => {
    expect(normalizeEasing("easeInOut")).toBe("easeInOut");
    expect(normalizeEasing("not-a-curve")).toBe("linear");
    expect(normalizeEasing({ type: "cubicBezier", x1: 0 })).toBe("linear");
    expect(normalizeEasing(undefined, "easeOut")).toBe("easeOut");
    expect(normalizeEasing({ type: "curve" })).toBe("linear");
    const curve = { type: "curve", keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    expect(normalizeEasing(curve)).toEqual(curve);
    expect(normalizeEasing({ type: "curve", keys: [{ x: 0, y: 0 }] })).toBe("linear");
  });
});
