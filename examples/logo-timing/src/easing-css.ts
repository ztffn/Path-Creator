// Bridge between the package's Easing model and what the Web Animations API accepts.
// `Easing` is a named preset or a multi-anchor curve; WAAPI takes a CSS timing function.
// Sampling into CSS `linear()` covers both exactly enough to be indistinguishable, which
// a single cubic-bezier cannot do for a curve with more than one inflection.
import { evaluateEasing, isEasingCurve, type Easing, type EasingCurve } from "@huma/path-creator/core";

/**
 * Samples per emitted `linear()` function. 32 puts the worst-case error on the shipped
 * curves under a thousandth of the animation's progress — well below one frame of
 * movement at any duration this is used for, and short enough to stay readable in the
 * timing file.
 */
export const EASING_SAMPLES = 32;

/**
 * Presets whose CSS spelling is EXACT. Only `linear` qualifies: the package's easeIn,
 * easeOut and easeInOut are its own polynomials, and they differ from the CSS keywords of
 * the same name by up to 0.069 of progress — measured, and pinned by a test. Mapping them
 * onto the keywords would render a curve the editor never drew, so they are sampled.
 */
const DIRECT: Partial<Record<string, string>> = { linear: "linear" };

/** The CSS keywords as their exact cubic-beziers, for authoring against CSS's own curves. */
export const CSS_EASE_OUT = { x1: 0, y1: 0, x2: 0.58, y2: 1 } as const;
export const CSS_EASE_IN_OUT = { x1: 0.42, y1: 0, x2: 0.58, y2: 1 } as const;

/** The CSS `cubic-bezier` a two-key curve came from, or null if it is not one. */
function asCubicBezier(curve: EasingCurve): string | null {
  const [first, second] = curve.keys;
  if (curve.keys.length !== 2 || curve.space === "speed") return null;
  if (!first?.out || !second?.in) return null;
  if (first.x !== 0 || first.y !== 0 || second.x !== 1 || second.y !== 1) return null;
  return `cubic-bezier(${first.out.x},${first.out.y},${second.in.x},${second.in.y})`;
}

/**
 * A curve authored as one cubic-bezier, in the package's own model. Handles are ABSOLUTE
 * points in curve space, which is what makes this a lossless conversion in both directions
 * rather than an approximation.
 */
export function bezierEasing(x1: number, y1: number, x2: number, y2: number): EasingCurve {
  return {
    type: "curve",
    keys: [
      { x: 0, y: 0, out: { x: x1, y: y1 } },
      { x: 1, y: 1, in: { x: x2, y: y2 } }
    ]
  };
}

/**
 * A CSS timing function for `Element.animate()`. `cut` is a step: the package treats it as
 * an instant blend, and the nearest honest CSS is a single step at the end rather than a
 * curve that merely looks steep.
 */
export function easingToCss(easing: Easing): string {
  if (typeof easing === "string") {
    if (easing === "cut") return "steps(1, end)";
    const direct = DIRECT[easing];
    if (direct) return direct;
  }
  // A single cubic-bezier keeps its exact CSS spelling — sampling it would be both lossy
  // and unreadable in a timing file somebody has to look at.
  if (isEasingCurve(easing)) {
    const exact = asCubicBezier(easing);
    if (exact) return exact;
  }
  const samples: string[] = [];
  for (let i = 0; i <= EASING_SAMPLES; i += 1) {
    const t = i / EASING_SAMPLES;
    samples.push(evaluateEasing(t, easing).toFixed(4).replace(/\.?0+$/, "") || "0");
  }
  return `linear(${samples.join(", ")})`;
}
