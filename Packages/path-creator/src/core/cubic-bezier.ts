import type { Vec3 } from "./types";
import { clamp01, vec3 } from "./vec3";

export function evaluateCurve(points: readonly [Vec3, Vec3, Vec3, Vec3], t: number): Vec3 {
  return evaluateCurve4(points[0], points[1], points[2], points[3], t);
}

export function evaluateCurve4(a1: Vec3, c1: Vec3, c2: Vec3, a2: Vec3, t: number): Vec3 {
  const tt = clamp01(t);
  const omt = 1 - tt;
  return {
    x: omt * omt * omt * a1.x + 3 * omt * omt * tt * c1.x + 3 * omt * tt * tt * c2.x + tt * tt * tt * a2.x,
    y: omt * omt * omt * a1.y + 3 * omt * omt * tt * c1.y + 3 * omt * tt * tt * c2.y + tt * tt * tt * a2.y,
    z: omt * omt * omt * a1.z + 3 * omt * omt * tt * c1.z + 3 * omt * tt * tt * c2.z + tt * tt * tt * a2.z
  };
}

export function evaluateCurveDerivative(points: readonly [Vec3, Vec3, Vec3, Vec3], t: number): Vec3 {
  return evaluateCurveDerivative4(points[0], points[1], points[2], points[3], t);
}

export function evaluateCurveDerivative4(a1: Vec3, c1: Vec3, c2: Vec3, a2: Vec3, t: number): Vec3 {
  const tt = clamp01(t);
  const omt = 1 - tt;
  return {
    x: 3 * omt * omt * (c1.x - a1.x) + 6 * omt * tt * (c2.x - c1.x) + 3 * tt * tt * (a2.x - c2.x),
    y: 3 * omt * omt * (c1.y - a1.y) + 6 * omt * tt * (c2.y - c1.y) + 3 * tt * tt * (a2.y - c2.y),
    z: 3 * omt * omt * (c1.z - a1.z) + 6 * omt * tt * (c2.z - c1.z) + 3 * tt * tt * (a2.z - c2.z)
  };
}

export function estimateCurveLength(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): number {
  const controlNetLength =
    vec3.distance(p0, p1) + vec3.distance(p1, p2) + vec3.distance(p2, p3);
  return vec3.distance(p0, p3) + controlNetLength / 2;
}

export function splitCurve(
  points: readonly [Vec3, Vec3, Vec3, Vec3],
  t: number
): [[Vec3, Vec3, Vec3, Vec3], [Vec3, Vec3, Vec3, Vec3]] {
  const tt = clamp01(t);
  const a1 = vec3.lerp(points[0], points[1], tt);
  const a2 = vec3.lerp(points[1], points[2], tt);
  const a3 = vec3.lerp(points[2], points[3], tt);
  const b1 = vec3.lerp(a1, a2, tt);
  const b2 = vec3.lerp(a2, a3, tt);
  const pointOnCurve = vec3.lerp(b1, b2, tt);

  return [
    [points[0], a1, b1, pointOnCurve],
    [pointOnCurve, b2, a3, points[3]]
  ];
}
