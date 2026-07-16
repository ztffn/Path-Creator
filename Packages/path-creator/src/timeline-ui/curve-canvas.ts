// Shared, coordinate-agnostic curve-interaction core for the timeline-ui curve
// editors. Pure geometry + edit reducers over an ordered anchor list (the
// EasingCurveKey shape: x/y plus optional in/out bezier handles): domain<->pixel
// scaling, anchor + handle dragging with neighbor clamping and tangent relinking,
// and add/remove. EasingEditor (0..1, one curve) and KeyframeCurveEditor (real
// units, N curves) both drive their SVG from these — one interaction codebase.
import { clamp, lerp, tangentHandles, type EasingCurveKey, type EasingPoint, type TangentMode } from "../core";

/** Inclusive value range for one axis (domain units; may be negative). */
export interface Axis { min: number; max: number }

/** Linear map between an axis's domain and a [0, px] pixel length (no inversion). */
export function makeScale(axis: Axis, px: number): { toPx: (v: number) => number; toValue: (p: number) => number } {
  const span = axis.max - axis.min || 1;
  return {
    toPx: (v) => ((v - axis.min) / span) * px,
    toValue: (p) => axis.min + (p / px) * span
  };
}

/** Smallest time/x gap kept between neighboring anchors so the curve stays a function of x. */
export const ANCHOR_EPSILON = 1e-3;

// Effective control points: the explicit handle, or the default 1/3-chord point the
// evaluator uses when a handle is absent — so every anchor shows a grabbable handle.
export const effOut = (keys: EasingCurveKey[], i: number): EasingPoint =>
  keys[i]!.out ?? { x: lerp(keys[i]!.x, keys[i + 1]!.x, 1 / 3), y: lerp(keys[i]!.y, keys[i + 1]!.y, 1 / 3) };
export const effIn = (keys: EasingCurveKey[], i: number): EasingPoint =>
  keys[i]!.in ?? { x: lerp(keys[i - 1]!.x, keys[i]!.x, 2 / 3), y: lerp(keys[i - 1]!.y, keys[i]!.y, 2 / 3) };

export const cloneKeys = (keys: EasingCurveKey[]): EasingCurveKey[] =>
  keys.map((k) => ({ ...k, ...(k.out && { out: { ...k.out } }), ...(k.in && { in: { ...k.in } }) }));

/**
 * Enforce an interior anchor's tangent mode by setting the handle opposite `refSide`
 * from the reference handle: "mirror" makes it the exact opposite, "aligned" keeps it
 * collinear at its own length. Opposite-x is clamped to its segment (curve must stay a
 * function of x), staying collinear by recomputing y. "free" leaves it untouched.
 * `yBounds` clamps the derived handle's y (over/undershoot allowance is caller policy).
 */
export function relink(keys: EasingCurveKey[], index: number, refSide: "out" | "in", mode: TangentMode, yBounds: Axis): void {
  if (mode === "free") return;
  const key = keys[index]!;
  const prev = keys[index - 1];
  const next = keys[index + 1];
  if (!prev || !next) return;
  const eff = (side: "out" | "in"): EasingPoint => (side === "out" ? effOut(keys, index) : effIn(keys, index));
  const oppSide = refSide === "out" ? "in" : "out";
  const ref = eff(refSide);
  const oppLoX = oppSide === "out" ? key.x : prev.x;
  const oppHiX = oppSide === "out" ? next.x : key.x;
  const vx = ref.x - key.x;
  const vy = ref.y - key.y;
  let ox: number;
  let oy: number;
  if (mode === "mirror") {
    ox = -vx;
    oy = -vy;
  } else {
    const curr = eff(oppSide);
    const curLen = Math.hypot(curr.x - key.x, curr.y - key.y);
    const vlen = Math.hypot(vx, vy) || 1e-6;
    ox = (-vx / vlen) * curLen;
    oy = (-vy / vlen) * curLen;
  }
  const hx = key.x + ox;
  let hy = key.y + oy;
  const cx = clamp(hx, oppLoX, oppHiX);
  if (cx !== hx && Math.abs(ox) > 1e-9) hy = key.y + oy * ((cx - key.x) / ox);
  const opp = { x: cx, y: clamp(hy, yBounds.min, yBounds.max) };
  if (oppSide === "out") key.out = opp;
  else key.in = opp;
}

/** Which part of an anchor a pointer gesture targets. */
export type DragTarget = { kind: "anchor" | "out" | "in"; index: number };

export interface DragAnchorOptions {
  /** Interior-anchor y clamp (endpoints may be pinned instead). */
  yBounds: Axis;
  /** Pin an anchor's x to a fixed value (e.g. easing endpoints at 0/1); undefined = free between neighbors. */
  pinnedX?: (index: number, isFirst: boolean, isLast: boolean) => number | undefined;
  /** Pin an anchor's y to a fixed value (e.g. easing endpoints at 0/1); undefined = clamp to yBounds. */
  pinnedY?: (index: number, isFirst: boolean, isLast: boolean) => number | undefined;
}

/**
 * Move anchor `index` toward (toX, toY) in domain space, returning a new key list.
 * Interior anchors clamp between their neighbors (keeping the ANCHOR_EPSILON gap);
 * endpoints are free unless `pinnedX`/`pinnedY` fix them. Any handles ride along.
 */
export function dragAnchor(keys: EasingCurveKey[], index: number, toX: number, toY: number, opts: DragAnchorOptions): EasingCurveKey[] {
  const next = cloneKeys(keys);
  const key = next[index]!;
  const isFirst = index === 0;
  const isLast = index === next.length - 1;
  const loX = index > 0 ? next[index - 1]!.x + ANCHOR_EPSILON : -Infinity;
  const hiX = index < next.length - 1 ? next[index + 1]!.x - ANCHOR_EPSILON : Infinity;
  const pinX = opts.pinnedX?.(index, isFirst, isLast);
  const pinY = opts.pinnedY?.(index, isFirst, isLast);
  const nx = pinX ?? clamp(toX, loX, hiX);
  const ny = pinY ?? clamp(toY, opts.yBounds.min, opts.yBounds.max);
  const dx = nx - key.x;
  const dy = ny - key.y;
  key.x = nx;
  key.y = ny;
  if (key.out) key.out = { x: key.out.x + dx, y: key.out.y + dy };
  if (key.in) key.in = { x: key.in.x + dx, y: key.in.y + dy };
  return next;
}

/**
 * Move a tangent handle of anchor `index` (side "out"/"in") toward (toX, toY),
 * clamped to its segment and yBounds; relinks the opposite handle for interior
 * anchors per the anchor's tangent mode. Returns a new key list.
 */
export function dragHandle(keys: EasingCurveKey[], index: number, side: "out" | "in", toX: number, toY: number, yBounds: Axis): EasingCurveKey[] {
  const next = cloneKeys(keys);
  const key = next[index]!;
  const loX = side === "out" ? key.x : next[index - 1]!.x;
  const hiX = side === "out" ? next[index + 1]!.x : key.x;
  const h = { x: clamp(toX, loX, hiX), y: clamp(toY, yBounds.min, yBounds.max) };
  if (side === "out") key.out = h;
  else key.in = h;
  if (index > 0 && index < next.length - 1) relink(next, index, side, key.tangent ?? "aligned", yBounds);
  return next;
}

/**
 * Insert an anchor at (atX, atY) with smooth tangent handles seeded from the local
 * slope through the bracketing anchors, returned sorted by x. `xBounds`/`yBounds`
 * clamp the insertion point.
 */
export function addAnchor(keys: EasingCurveKey[], atX: number, atY: number, xBounds: Axis, yBounds: Axis): EasingCurveKey[] {
  const nx = clamp(atX, xBounds.min, xBounds.max);
  const ny = clamp(atY, yBounds.min, yBounds.max);
  const sorted = [...keys].sort((a, b) => a.x - b.x);
  let lo = sorted[0]!;
  let hi = sorted[sorted.length - 1]!;
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    if (sorted[i]!.x <= nx && nx <= sorted[i + 1]!.x) {
      lo = sorted[i]!;
      hi = sorted[i + 1]!;
      break;
    }
  }
  const key: EasingCurveKey = { x: nx, y: ny, ...tangentHandles({ x: nx, y: ny }, lo, hi) };
  return [...keys, key].sort((a, b) => a.x - b.x);
}

/** Remove anchor `index`, returning a new key list (callers guard endpoint policy). */
export function removeAnchor(keys: EasingCurveKey[], index: number): EasingCurveKey[] {
  return keys.filter((_, i) => i !== index);
}

/** Index this new anchor will occupy once inserted at `atX` (for selection after add). */
export const insertIndexFor = (keys: EasingCurveKey[], atX: number): number => keys.filter((k) => k.x < atX).length;
