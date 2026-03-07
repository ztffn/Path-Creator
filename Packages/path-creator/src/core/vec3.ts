import type { Vec3 } from "./types";

export const vec3 = {
  create(x = 0, y = 0, z = 0): Vec3 {
    return { x, y, z };
  },

  clone(a: Vec3): Vec3 {
    return { x: a.x, y: a.y, z: a.z };
  },

  add(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
  },

  sub(a: Vec3, b: Vec3): Vec3 {
    return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
  },

  scale(a: Vec3, s: number): Vec3 {
    return { x: a.x * s, y: a.y * s, z: a.z * s };
  },

  dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },

  cross(a: Vec3, b: Vec3): Vec3 {
    return {
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x
    };
  },

  sqrMagnitude(a: Vec3): number {
    return vec3.dot(a, a);
  },

  magnitude(a: Vec3): number {
    return Math.sqrt(vec3.sqrMagnitude(a));
  },

  normalize(a: Vec3): Vec3 {
    const m = vec3.magnitude(a);
    if (m === 0) return { x: 0, y: 0, z: 0 };
    return vec3.scale(a, 1 / m);
  },

  distance(a: Vec3, b: Vec3): number {
    return vec3.magnitude(vec3.sub(a, b));
  },

  lerp(a: Vec3, b: Vec3, t: number): Vec3 {
    return {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t
    };
  },

  closestPointOnLineSegment(p: Vec3, a: Vec3, b: Vec3): Vec3 {
    const ab = vec3.sub(b, a);
    const ap = vec3.sub(p, a);
    const sqrLenAB = vec3.sqrMagnitude(ab);
    if (sqrLenAB === 0) return vec3.clone(a);
    const t = clamp01(vec3.dot(ap, ab) / sqrLenAB);
    return vec3.add(a, vec3.scale(ab, t));
  }
};

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, v: number): number {
  if (a === b) return 0;
  return clamp01((v - a) / (b - a));
}

export function pingPong(value: number, length: number): number {
  const cycle = length * 2;
  let local = value % cycle;
  if (local < 0) local += cycle;
  return local <= length ? local : cycle - local;
}

export function rotateAroundAxis(v: Vec3, axis: Vec3, angleRad: number): Vec3 {
  const u = vec3.normalize(axis);
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);

  const term1 = vec3.scale(v, cos);
  const term2 = vec3.scale(vec3.cross(u, v), sin);
  const term3 = vec3.scale(u, vec3.dot(u, v) * (1 - cos));

  return vec3.add(vec3.add(term1, term2), term3);
}
