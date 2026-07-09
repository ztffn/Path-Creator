// First-class easing: the scalar 0..1 -> 0..1 remap shared by camera blends and
// cart-distance keyframes. An Easing is either a named preset (legacy blend names
// plus the gre/1650294 polynomial set) or a custom multi-anchor curve of cubic-bezier
// segments, authored in position or (integrated) speed space. Presets are analytic;
// curve segments solve x->t per segment. Pure data + pure evaluator; no engine dep.
import { lerp } from "./vec3";

/** Named easing presets: legacy blend curves + the gre/1650294 polynomial set. */
export type EasingPreset =
  // Legacy blend vocabulary (kept for existing documents; outputs unchanged).
  | "cut"
  | "linear"
  | "easeIn"
  | "easeOut"
  | "easeInOut"
  | "hardIn"
  | "hardOut"
  // gre/1650294 polynomial set.
  | "easeInQuad"
  | "easeOutQuad"
  | "easeInOutQuad"
  | "easeInCubic"
  | "easeOutCubic"
  | "easeInOutCubic"
  | "easeInQuart"
  | "easeOutQuart"
  | "easeInOutQuart"
  | "easeInQuint"
  | "easeOutQuint"
  | "easeInOutQuint";

/** A point in the unit-ish easing space (x = normalized time, y = progress). */
export interface EasingPoint {
  x: number;
  y: number;
}

/**
 * How an anchor's two tangent handles relate while editing: "free" moves each
 * independently (broken), "aligned" keeps them collinear but independent lengths,
 * "mirror" keeps them exact opposites. Purely an editing constraint — the evaluator
 * only reads the handle points.
 */
export type TangentMode = "free" | "aligned" | "mirror";

/**
 * A keyframe on a multi-anchor easing curve: an anchor plus optional bezier tangent
 * handles (absolute points). `out` shapes the segment to the next key, `in` the
 * segment from the previous key; absent handles default to the linear 1/3 chord.
 * `tangent` is the handle-linking mode for the editor (default "aligned").
 */
export interface EasingCurveKey extends EasingPoint {
  out?: EasingPoint;
  in?: EasingPoint;
  tangent?: TangentMode;
}

/**
 * Full-control easing: an ordered list of keys (x strictly increasing, endpoints at
 * x=0 and x=1) joined by cubic-bezier segments. Expresses arbitrary speed profiles —
 * speed up, slow down, hold, or reverse — beyond a single cubic-bezier's one S-curve.
 */
export interface EasingCurve {
  type: "curve";
  keys: EasingCurveKey[];
  /**
   * What the curve's y means. "position" (default): y is progress vs time, used
   * directly. "speed": y is speed vs time; the evaluator integrates and normalizes
   * it so progress still runs 0->1. Lets an editor author either graph.
   */
  space?: "position" | "speed";
}

export type Easing = EasingPreset | EasingCurve;

/** Analytic preset functions on already-clamped alpha in [0,1]. */
export const EASING_PRESETS: Record<EasingPreset, (a: number) => number> = {
  cut: () => 1,
  linear: (a) => a,
  // Legacy: easeIn/Out are quadratic, easeInOut is smoothstep, hardIn/Out are cubic.
  easeIn: (a) => a * a,
  easeOut: (a) => 1 - (1 - a) * (1 - a),
  easeInOut: (a) => a * a * (3 - 2 * a),
  hardIn: (a) => a * a * a,
  hardOut: (a) => 1 - (1 - a) * (1 - a) * (1 - a),
  // gre/1650294 set.
  easeInQuad: (a) => a * a,
  easeOutQuad: (a) => a * (2 - a),
  easeInOutQuad: (a) => (a < 0.5 ? 2 * a * a : -1 + (4 - 2 * a) * a),
  easeInCubic: (a) => a * a * a,
  easeOutCubic: (a) => (a - 1) ** 3 + 1,
  easeInOutCubic: (a) => (a < 0.5 ? 4 * a * a * a : (a - 1) * (2 * a - 2) * (2 * a - 2) + 1),
  easeInQuart: (a) => a * a * a * a,
  easeOutQuart: (a) => 1 - (a - 1) ** 4,
  easeInOutQuart: (a) => (a < 0.5 ? 8 * a * a * a * a : 1 - 8 * (a - 1) ** 4),
  easeInQuint: (a) => a * a * a * a * a,
  easeOutQuint: (a) => 1 + (a - 1) ** 5,
  easeInOutQuint: (a) => (a < 0.5 ? 16 * a * a * a * a * a : 1 + 16 * (a - 1) ** 5)
};

export function isEasingCurve(easing: Easing): easing is EasingCurve {
  return typeof easing === "object" && easing.type === "curve";
}

const clamp01 = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);

/**
 * General cubic-bezier with arbitrary control points; solves parameter t for the
 * given x (Newton then bisection), returns y. x is assumed monotonic across the
 * segment (control-point x within [p0.x, p3.x]), as the curve editor enforces.
 */
const cubic = (t: number, a: number, b: number, c: number, d: number): number => {
  const mt = 1 - t;
  return mt * mt * mt * a + 3 * mt * mt * t * b + 3 * mt * t * t * c + t * t * t * d;
};

function solveCubicBezierSegment(p0: EasingPoint, c1: EasingPoint, c2: EasingPoint, p3: EasingPoint, x: number): number {
  const epsilon = 1e-6;
  let t0 = 0;
  let t1 = 1;
  let t = p3.x > p0.x ? (x - p0.x) / (p3.x - p0.x) : 0;
  for (let i = 0; i < 24; i++) {
    const xt = cubic(t, p0.x, c1.x, c2.x, p3.x);
    if (Math.abs(xt - x) < epsilon) break;
    if (xt < x) t0 = t;
    else t1 = t;
    t = (t0 + t1) * 0.5;
  }
  return cubic(t, p0.y, c1.y, c2.y, p3.y);
}

/** Raw geometric value of the curve at x (ignores `space` — the y as drawn/edited). */
export function sampleEasingCurve(curve: EasingCurve, x: number): number {
  const keys = curve.keys;
  if (keys.length === 0) return x;
  if (keys.length === 1 || x <= keys[0].x) return keys[0].y;
  const last = keys[keys.length - 1];
  if (x >= last.x) return last.y;
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1].x < x) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const c1 = a.out ?? { x: lerp(a.x, b.x, 1 / 3), y: lerp(a.y, b.y, 1 / 3) };
  const c2 = b.in ?? { x: lerp(a.x, b.x, 2 / 3), y: lerp(a.y, b.y, 2 / 3) };
  return solveCubicBezierSegment(a, c1, c2, b, x);
}

const LUT_SEGMENTS = 64;
// Normalized cumulative-integral LUT for speed-space curves, memoized per curve object
// so the per-frame evaluator stays cheap (curve identity is stable across renders).
const speedLutCache = new WeakMap<EasingCurve, number[]>();
function speedCurveLUT(curve: EasingCurve): number[] {
  const cached = speedLutCache.get(curve);
  if (cached) return cached;
  const cum = new Array<number>(LUT_SEGMENTS + 1);
  cum[0] = 0;
  let acc = 0;
  let prev = sampleEasingCurve(curve, 0);
  for (let i = 1; i <= LUT_SEGMENTS; i++) {
    const s = sampleEasingCurve(curve, i / LUT_SEGMENTS);
    acc += ((prev + s) / 2) * (1 / LUT_SEGMENTS);
    cum[i] = acc;
    prev = s;
  }
  const total = acc;
  const lut = Math.abs(total) < 1e-6 ? cum.map((_, i) => i / LUT_SEGMENTS) : cum.map((v) => v / total);
  speedLutCache.set(curve, lut);
  return lut;
}

/** Evaluate a multi-anchor easing curve at x, integrating+normalizing when space="speed". */
export function evaluateEasingCurve(curve: EasingCurve, x: number): number {
  if (curve.space !== "speed") return sampleEasingCurve(curve, x);
  const lut = speedCurveLUT(curve);
  const t = clamp01(x) * LUT_SEGMENTS;
  const i = Math.floor(t);
  return i >= LUT_SEGMENTS ? lut[LUT_SEGMENTS] : lerp(lut[i], lut[i + 1], t - i);
}

/**
 * Sample the speed (finite-difference derivative) of an easing at `samples`+1 evenly
 * spaced times. Signed deltas — callers take Math.abs and/or normalize as they need.
 * Shared by the space converter, the editor's overlay, and the block speed sparkline.
 */
export function sampleEasingDerivative(easing: Easing, samples: number, eps = 1e-3): number[] {
  const out = new Array<number>(samples + 1);
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    out[i] = evaluateEasing(Math.min(1, x + eps), easing) - evaluateEasing(Math.max(0, x - eps), easing);
  }
  return out;
}

/**
 * Convert a curve to the other authoring space while preserving the motion it
 * produces: sample the resulting position (or its derivative, for speed) at evenly
 * spaced anchors. Used by an editor's position<->speed toggle. Lossy resample.
 */
export function convertEasingCurveSpace(current: EasingCurve, target: "position" | "speed", samples = 4): EasingCurve {
  if (target === "position") return easingToCurve(current, samples);
  // Speed = derivative of the resulting motion. Its magnitude is arbitrary (the evaluator
  // re-normalizes by total area), so rescale the sampled deltas to a friendly display range.
  const ys = sampleEasingDerivative(current, samples);
  const maxAbs = Math.max(1e-6, ...ys.map((y) => Math.abs(y)));
  const scale = 0.8 / maxAbs;
  const points = ys.map((y, i) => ({ x: i / samples, y: y * scale }));
  return { type: "curve", space: "speed", keys: fitTangentHandles(points) };
}

/**
 * Shapes a 0..1 progress value through an easing. Default "easeInOut" matches the
 * legacy blend evaluator (drop-in for callers that relied on the old default).
 */
export function evaluateEasing(t: number, easing: Easing = "easeInOut"): number {
  const a = clamp01(t);
  if (isEasingCurve(easing)) return evaluateEasingCurve(easing, a);
  return (EASING_PRESETS[easing] ?? EASING_PRESETS.linear)(a);
}

/**
 * Fit cubic-bezier tangent handles to sampled points (Catmull-Rom style: each anchor's
 * tangent is the slope through its neighbors, handles at 1/3 the chord). Turns a few
 * anchors into a smooth C1 curve, so we don't need many points to look curved.
 */
function fitTangentHandles(points: EasingPoint[]): EasingCurveKey[] {
  return points.map((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    const slope = !prev
      ? (next.y - p.y) / (next.x - p.x)
      : !next
        ? (p.y - prev.y) / (p.x - prev.x)
        : (next.y - prev.y) / (next.x - prev.x);
    const key: EasingCurveKey = { x: p.x, y: p.y };
    if (next) {
      const g = (next.x - p.x) / 3;
      key.out = { x: p.x + g, y: p.y + slope * g };
    }
    if (prev) {
      const g = (p.x - prev.x) / 3;
      key.in = { x: p.x - g, y: p.y - slope * g };
    }
    return key;
  });
}

/**
 * Sample any easing into an editable position curve (endpoints exact) with few, smooth
 * anchors. Used to seed the editor so a preset can be tuned. A position curve is
 * returned as-is to keep its handles; presets/speed curves resample with fitted tangents.
 */
export function easingToCurve(easing: Easing, samples = 3): EasingCurve {
  if (isEasingCurve(easing) && easing.space !== "speed") return easing;
  const points: EasingPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const x = i / samples;
    points.push({ x, y: evaluateEasing(x, easing) });
  }
  return { type: "curve", keys: fitTangentHandles(points) };
}

/** Coerce an unknown/legacy easing value to a valid Easing, falling back to `fallback`. */
export function normalizeEasing(value: unknown, fallback: Easing = "linear"): Easing {
  if (typeof value === "string" && value in EASING_PRESETS) return value as EasingPreset;
  if (typeof value === "object" && value !== null && (value as { type?: unknown }).type === "curve") {
    const keys = (value as { keys?: unknown }).keys;
    if (Array.isArray(keys) && keys.length >= 2 && keys.every((k) => typeof k?.x === "number" && typeof k?.y === "number")) {
      return value as EasingCurve;
    }
  }
  return fallback;
}
