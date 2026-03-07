import type { Vec3 } from "../core";

export interface MeshBuffers {
  positions: number[];
  indices: number[];
}

export function buildPolylineBuffers(points: Vec3[]): MeshBuffers {
  const positions: number[] = [];
  for (const p of points) {
    positions.push(p.x, p.y, p.z);
  }

  const indices: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    indices.push(i, i + 1);
  }

  return { positions, indices };
}
