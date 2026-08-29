import { describe, expect, it } from "vitest";
import { EASING_SAMPLES, bezierEasing, easingToCss } from "./easing-css";
import type { Easing } from "@huma/path-creator/core";

describe("easing to CSS", () => {
  it("spells linear directly, since that one is exact", () => {
    expect(easingToCss("linear")).toBe("linear");
  });

  it("SAMPLES easeIn/easeOut/easeInOut rather than using the CSS keywords", () => {
    // Measured: the package's polynomials differ from the CSS keywords of the same name by
    // up to 0.069 of progress. Emitting `ease-out` for the preset would render a curve the
    // editor never drew.
    for (const preset of ["easeIn", "easeOut", "easeInOut"] as const) {
      expect(easingToCss(preset).startsWith("linear(")).toBe(true);
    }
  });

  it("makes `cut` an honest step rather than a very steep curve", () => {
    expect(easingToCss("cut")).toBe("steps(1, end)");
  });

  it("samples a preset CSS has no name for", () => {
    const css = easingToCss("easeOutQuint");
    expect(css.startsWith("linear(")).toBe(true);
    expect(css.split(",")).toHaveLength(EASING_SAMPLES + 1);
  });

  it("pins the endpoints, which is what stops a piece popping at either end", () => {
    const css = easingToCss("easeInOutCubic");
    const values = css.slice("linear(".length, -1).split(", ").map(Number);
    expect(values[0]).toBe(0);
    expect(values[values.length - 1]).toBe(1);
  });

  it("carries a multi-anchor curve CSS could not express as one cubic-bezier", () => {
    // A hold in the middle: progress stalls, then completes. One cubic-bezier has a
    // single S and cannot describe it; sampling can.
    const curve: Easing = {
      type: "curve",
      keys: [{ x: 0, y: 0 }, { x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, { x: 1, y: 1 }]
    };
    const values = easingToCss(curve).slice("linear(".length, -1).split(", ").map(Number);
    const middle = values[Math.round(EASING_SAMPLES / 2)];
    expect(middle).toBeGreaterThan(0.35);
    expect(middle).toBeLessThan(0.65);
  });
});

describe("single cubic-bezier curves", () => {
  it("keeps their exact CSS spelling instead of sampling them", () => {
    expect(easingToCss(bezierEasing(0.16, 1, 0.3, 1))).toBe("cubic-bezier(0.16,1,0.3,1)");
  });

  it("round-trips a handle that overshoots, which the logo's mountains rely on", () => {
    expect(easingToCss(bezierEasing(0.2, 0.8, 0.3, 1.05))).toBe("cubic-bezier(0.2,0.8,0.3,1.05)");
  });

  it("samples a curve with more than two keys, which CSS cannot spell", () => {
    const held = { type: "curve" as const, keys: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] };
    expect(easingToCss(held).startsWith("linear(")).toBe(true);
  });
});
