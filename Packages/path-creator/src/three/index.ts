import { PathSpace, type Vec3, type VertexPath, vec3 } from "../core";

export interface MeshBuffers {
  positions: number[];
  indices: number[];
  normals?: number[];
  uvs?: number[];
}

export interface RoadMeshOptions {
  roadWidth?: number;
  thickness?: number;
  flattenSurface?: boolean;
}

export interface TubeMeshOptions {
  radius?: number;
  radialSegments?: number;
  segmentsPerUnit?: number;
}

const ROAD_TRIANGLE_MAP = [0, 8, 1, 1, 8, 9] as const;
const ROAD_SIDE_TRIANGLE_MAP = [4, 6, 14, 12, 4, 14, 5, 15, 7, 13, 15, 5] as const;

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

export function buildRoadMeshBuffers(path: VertexPath, options: RoadMeshOptions = {}): MeshBuffers {
  const roadWidth = Math.abs(options.roadWidth ?? 0.4);
  const thickness = Math.max(0, options.thickness ?? 0.15);
  const flattenSurface = options.flattenSurface ?? false;

  const vertCount = path.numPoints * 8;
  const positions = new Array<number>(vertCount * 3).fill(0);
  const normals = new Array<number>(vertCount * 3).fill(0);
  const uvs = new Array<number>(vertCount * 2).fill(0);

  const numTris = 2 * (path.numPoints - 1) + (path.isClosedLoop ? 2 : 0);
  const roadTriangles = new Array<number>(numTris * 3).fill(0);
  const underRoadTriangles = new Array<number>(numTris * 3).fill(0);
  const sideTriangles = new Array<number>(numTris * 2 * 3).fill(0);

  let vertIndex = 0;
  let triIndex = 0;

  const usePathNormals = !(path.space === PathSpace.XYZ && flattenSurface);

  for (let i = 0; i < path.numPoints; i += 1) {
    const tangent = path.getTangent(i);
    const normal = path.getNormal(i);

    const localUp = usePathNormals ? vec3.cross(tangent, normal) : path.up;
    const localRight = usePathNormals ? normal : vec3.cross(localUp, tangent);

    const p = path.getPoint(i);
    const sideA = vec3.sub(p, vec3.scale(localRight, roadWidth));
    const sideB = vec3.add(p, vec3.scale(localRight, roadWidth));

    const v = [
      sideA,
      sideB,
      vec3.sub(sideA, vec3.scale(localUp, thickness)),
      vec3.sub(sideB, vec3.scale(localUp, thickness))
    ] as const;

    setVertex(positions, vertIndex + 0, v[0]);
    setVertex(positions, vertIndex + 1, v[1]);
    setVertex(positions, vertIndex + 2, v[2]);
    setVertex(positions, vertIndex + 3, v[3]);
    setVertex(positions, vertIndex + 4, v[0]);
    setVertex(positions, vertIndex + 5, v[1]);
    setVertex(positions, vertIndex + 6, v[2]);
    setVertex(positions, vertIndex + 7, v[3]);

    setUv(uvs, vertIndex + 0, 0, path.times[i]);
    setUv(uvs, vertIndex + 1, 1, path.times[i]);

    setVertex(normals, vertIndex + 0, localUp);
    setVertex(normals, vertIndex + 1, localUp);
    setVertex(normals, vertIndex + 2, vec3.scale(localUp, -1));
    setVertex(normals, vertIndex + 3, vec3.scale(localUp, -1));
    setVertex(normals, vertIndex + 4, vec3.scale(localRight, -1));
    setVertex(normals, vertIndex + 5, localRight);
    setVertex(normals, vertIndex + 6, vec3.scale(localRight, -1));
    setVertex(normals, vertIndex + 7, localRight);

    if (i < path.numPoints - 1 || path.isClosedLoop) {
      for (let j = 0; j < ROAD_TRIANGLE_MAP.length; j += 1) {
        roadTriangles[triIndex + j] = (vertIndex + ROAD_TRIANGLE_MAP[j]) % vertCount;
        underRoadTriangles[triIndex + j] =
          (vertIndex + ROAD_TRIANGLE_MAP[ROAD_TRIANGLE_MAP.length - 1 - j] + 2) % vertCount;
      }

      for (let j = 0; j < ROAD_SIDE_TRIANGLE_MAP.length; j += 1) {
        sideTriangles[triIndex * 2 + j] = (vertIndex + ROAD_SIDE_TRIANGLE_MAP[j]) % vertCount;
      }
    }

    vertIndex += 8;
    triIndex += 6;
  }

  return {
    positions,
    normals,
    uvs,
    indices: [...roadTriangles, ...underRoadTriangles, ...sideTriangles]
  };
}

export function buildTubeMeshBuffers(path: VertexPath, options: TubeMeshOptions = {}): MeshBuffers {
  const radius = Math.max(0.0001, options.radius ?? 0.15);
  const radialSegments = Math.max(3, Math.floor(options.radialSegments ?? 10));
  const segmentsPerUnit = Math.max(0.1, options.segmentsPerUnit ?? 20);

  const rings = Math.max(2, Math.round(path.length * segmentsPerUnit) + 1);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let s = 0; s < rings; s += 1) {
    const t = rings === 1 ? 0 : s / (rings - 1);
    const center = path.getPointAtTime(t);
    const n = vec3.normalize(path.getNormalAtTime(t));
    const f = vec3.normalize(path.getDirection(t));
    const b = vec3.normalize(vec3.cross(n, f));

    for (let r = 0; r < radialSegments; r += 1) {
      const angle = (r / radialSegments) * Math.PI * 2;
      const offset = vec3.add(vec3.scale(n, Math.sin(angle) * radius), vec3.scale(b, Math.cos(angle) * radius));
      const p = vec3.add(center, offset);
      positions.push(p.x, p.y, p.z);

      const normal = vec3.normalize(offset);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(r / radialSegments, t);

      if (s < rings - 1) {
        const start = s * radialSegments;
        const next = (r + 1) % radialSegments;
        indices.push(start + r, start + next, start + r + radialSegments);
        indices.push(start + next, start + next + radialSegments, start + r + radialSegments);
      }
    }
  }

  return { positions, normals, uvs, indices };
}

function setVertex(buffer: number[], index: number, v: Vec3): void {
  const offset = index * 3;
  buffer[offset] = v.x;
  buffer[offset + 1] = v.y;
  buffer[offset + 2] = v.z;
}

function setUv(buffer: number[], index: number, u: number, v: number): void {
  const offset = index * 2;
  buffer[offset] = u;
  buffer[offset + 1] = v;
}
