import type { BezierPath } from "./bezier-path";
import { EndOfPathInstruction, PathSpace, type Vec3 } from "./types";
import { splitBezierPathByAngleError, splitBezierPathEvenly, type PathSplitData } from "./vertex-path-utils";
import { clamp01, inverseLerp, lerp, pingPong, rotateAroundAxis, vec3 } from "./vec3";

export interface VertexPathFromBezierOptions {
  maxAngleError?: number;
  minVertexDistance?: number;
  spacing?: number;
}

export interface RotationFrame {
  forward: Vec3;
  up: Vec3;
  right: Vec3;
}

export class VertexPath {
  public readonly space: PathSpace;
  public readonly isClosedLoop: boolean;
  public readonly localPoints: Vec3[];
  public readonly localTangents: Vec3[];
  public readonly localNormals: Vec3[];
  public readonly times: number[];
  public readonly length: number;
  public readonly cumulativeLengthAtEachVertex: number[];
  public readonly up: Vec3;

  constructor(points: Vec3[], cumulativeLength: number[]);
  constructor(bezierPath: BezierPath, options?: VertexPathFromBezierOptions);
  constructor(
    input: Vec3[] | BezierPath,
    arg2?: number[] | VertexPathFromBezierOptions
  ) {
    if (Array.isArray(input)) {
      const points = input;
      const cumulativeLength = (arg2 ?? []) as number[];
      if (points.length === 0) {
        throw new Error("VertexPath requires sampled points");
      }
      if (cumulativeLength.length !== points.length) {
        throw new Error("cumulativeLength must have same length as points");
      }

      this.space = PathSpace.XYZ;
      this.isClosedLoop = false;
      this.localPoints = points;
      this.localTangents = buildTangentsFromPoints(points, false);
      this.localNormals = buildNormals(points, this.localTangents, this.space, false, 0, []);
      this.cumulativeLengthAtEachVertex = cumulativeLength;
      this.length = cumulativeLength[cumulativeLength.length - 1] ?? 0;
      this.times = cumulativeLength.map((d) => (this.length > 0 ? d / this.length : 0));
      this.up = vec3.create(0, 1, 0);
      return;
    }

    const bezierPath = input;
    const options = (arg2 ?? {}) as VertexPathFromBezierOptions;
    const maxAngleError = options.maxAngleError ?? 0.3;
    const minVertexDistance = options.minVertexDistance ?? 0.01;

    const splitData: PathSplitData =
      options.spacing !== undefined
        ? splitBezierPathEvenly(bezierPath, Math.max(options.spacing, 0.01))
        : splitBezierPathByAngleError(bezierPath, maxAngleError, minVertexDistance);

    this.space = bezierPath.space;
    this.isClosedLoop = bezierPath.isClosed;
    this.localPoints = splitData.vertices;
    this.localTangents = splitData.tangents;
    this.cumulativeLengthAtEachVertex = splitData.cumulativeLength;
    this.length = splitData.cumulativeLength[splitData.cumulativeLength.length - 1] ?? 0;
    this.times = splitData.cumulativeLength.map((d) => (this.length > 0 ? d / this.length : 0));

    const pathUp = inferUp(this.localPoints);
    this.up = pathUp;

    this.localNormals = buildNormals(
      this.localPoints,
      this.localTangents,
      this.space,
      bezierPath.flipNormals,
      bezierPath.globalNormalsAngle,
      buildAnchorNormalAngles(bezierPath, splitData)
    );
  }

  get numPoints(): number {
    return this.localPoints.length;
  }

  getPoint(index: number): Vec3 {
    return this.localPoints[index];
  }

  getTangent(index: number): Vec3 {
    return this.localTangents[index];
  }

  getNormal(index: number): Vec3 {
    return this.localNormals[index];
  }

  resolveDistance(distance: number, mode: EndOfPathInstruction): number {
    const total = this.length;
    if (total <= 0) return 0;

    if (mode === EndOfPathInstruction.Stop) {
      return Math.max(0, Math.min(total, distance));
    }

    if (mode === EndOfPathInstruction.Loop) {
      const wrapped = distance % total;
      return wrapped < 0 ? wrapped + total : wrapped;
    }

    return pingPong(distance, total);
  }

  getPointAtDistance(dst: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): Vec3 {
    const t = this.length > 0 ? dst / this.length : 0;
    return this.getPointAtTime(t, mode);
  }

  getDirectionAtDistance(dst: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): Vec3 {
    const t = this.length > 0 ? dst / this.length : 0;
    return this.getDirection(t, mode);
  }

  getNormalAtDistance(dst: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): Vec3 {
    const t = this.length > 0 ? dst / this.length : 0;
    return this.getNormalAtTime(t, mode);
  }

  getRotationAtDistance(dst: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): RotationFrame {
    const t = this.length > 0 ? dst / this.length : 0;
    return this.getRotation(t, mode);
  }

  getPointAtTime(t: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): Vec3 {
    const data = this.calculatePercentOnPathData(t, mode);
    return vec3.lerp(
      this.localPoints[data.previousIndex],
      this.localPoints[data.nextIndex],
      data.percentBetweenIndices
    );
  }

  getDirection(t: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): Vec3 {
    const data = this.calculatePercentOnPathData(t, mode);
    const dir = vec3.lerp(
      this.localTangents[data.previousIndex],
      this.localTangents[data.nextIndex],
      data.percentBetweenIndices
    );
    return vec3.normalize(dir);
  }

  getNormalAtTime(t: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): Vec3 {
    const data = this.calculatePercentOnPathData(t, mode);
    const normal = vec3.lerp(
      this.localNormals[data.previousIndex],
      this.localNormals[data.nextIndex],
      data.percentBetweenIndices
    );
    return vec3.normalize(normal);
  }

  getRotation(t: number, mode: EndOfPathInstruction = EndOfPathInstruction.Loop): RotationFrame {
    const forward = this.getDirection(t, mode);
    const up = this.getNormalAtTime(t, mode);
    const right = vec3.normalize(vec3.cross(forward, up));
    return { forward, up, right };
  }

  getClosestPointOnPath(point: Vec3): Vec3 {
    const data = this.calculateClosestPointOnPathData(point);
    return vec3.lerp(
      this.localPoints[data.previousIndex],
      this.localPoints[data.nextIndex],
      data.percentBetweenIndices
    );
  }

  getClosestTimeOnPath(point: Vec3): number {
    const data = this.calculateClosestPointOnPathData(point);
    return lerp(
      this.times[data.previousIndex],
      this.times[data.nextIndex],
      data.percentBetweenIndices
    );
  }

  getClosestDistanceAlongPath(point: Vec3): number {
    const data = this.calculateClosestPointOnPathData(point);
    return lerp(
      this.cumulativeLengthAtEachVertex[data.previousIndex],
      this.cumulativeLengthAtEachVertex[data.nextIndex],
      data.percentBetweenIndices
    );
  }

  private calculatePercentOnPathData(
    t: number,
    mode: EndOfPathInstruction
  ): { previousIndex: number; nextIndex: number; percentBetweenIndices: number } {
    let tt = t;

    if (mode === EndOfPathInstruction.Loop) {
      if (tt < 0) tt += Math.ceil(Math.abs(tt));
      tt %= 1;
    } else if (mode === EndOfPathInstruction.Reverse) {
      tt = pingPong(tt, 1);
    } else {
      tt = clamp01(tt);
    }

    let prevIndex = 0;
    let nextIndex = this.numPoints - 1;
    let i = Math.round(tt * (this.numPoints - 1));

    while (true) {
      if (tt <= this.times[i]) {
        nextIndex = i;
      } else {
        prevIndex = i;
      }

      i = Math.floor((nextIndex + prevIndex) / 2);
      if (nextIndex - prevIndex <= 1) break;
    }

    const abPercent = inverseLerp(this.times[prevIndex], this.times[nextIndex], tt);
    return { previousIndex: prevIndex, nextIndex, percentBetweenIndices: abPercent };
  }

  private calculateClosestPointOnPathData(
    point: Vec3
  ): { previousIndex: number; nextIndex: number; percentBetweenIndices: number } {
    let minSqrDistance = Number.POSITIVE_INFINITY;
    let closestPoint = vec3.create();
    let closestSegmentIndexA = 0;
    let closestSegmentIndexB = 0;

    for (let i = 0; i < this.localPoints.length; i += 1) {
      let nextI = i + 1;
      if (nextI >= this.localPoints.length) {
        if (this.isClosedLoop) {
          nextI %= this.localPoints.length;
        } else {
          break;
        }
      }

      const closestPointOnSegment = vec3.closestPointOnLineSegment(
        point,
        this.localPoints[i],
        this.localPoints[nextI]
      );
      const sqrDistance = vec3.sqrMagnitude(vec3.sub(point, closestPointOnSegment));

      if (sqrDistance < minSqrDistance) {
        minSqrDistance = sqrDistance;
        closestPoint = closestPointOnSegment;
        closestSegmentIndexA = i;
        closestSegmentIndexB = nextI;
      }
    }

    const segmentLength = vec3.distance(
      this.localPoints[closestSegmentIndexA],
      this.localPoints[closestSegmentIndexB]
    );
    const t =
      segmentLength > 0
        ? vec3.distance(closestPoint, this.localPoints[closestSegmentIndexA]) / segmentLength
        : 0;

    return {
      previousIndex: closestSegmentIndexA,
      nextIndex: closestSegmentIndexB,
      percentBetweenIndices: t
    };
  }
}

function inferUp(points: Vec3[]): Vec3 {
  let min = vec3.clone(points[0]);
  let max = vec3.clone(points[0]);
  for (const p of points) {
    min = { x: Math.min(min.x, p.x), y: Math.min(min.y, p.y), z: Math.min(min.z, p.z) };
    max = { x: Math.max(max.x, p.x), y: Math.max(max.y, p.y), z: Math.max(max.z, p.z) };
  }
  const size = vec3.sub(max, min);
  return size.z > size.y ? vec3.create(0, 1, 0) : vec3.create(0, 0, -1);
}

function buildTangentsFromPoints(points: Vec3[], isClosed: boolean): Vec3[] {
  const tangents: Vec3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const prev = i === 0 ? (isClosed ? points[points.length - 1] : points[i]) : points[i - 1];
    const next = i === points.length - 1 ? (isClosed ? points[0] : points[i]) : points[i + 1];
    tangents.push(vec3.normalize(vec3.sub(next, prev)));
  }
  return tangents;
}

function buildNormals(
  points: Vec3[],
  tangents: Vec3[],
  space: PathSpace,
  flipNormals: boolean,
  globalNormalsAngle: number,
  anchorAngles: Array<{ startIndex: number; endIndex: number; startAngle: number; endAngle: number }>
): Vec3[] {
  const normals: Vec3[] = [];
  const initialUp = space === PathSpace.XY ? vec3.create(0, 0, -1) : vec3.create(0, 1, 0);

  if (space !== PathSpace.XYZ) {
    for (const t of tangents) {
      let n = vec3.cross(t, initialUp);
      if (!flipNormals) n = vec3.scale(n, -1);
      normals.push(vec3.normalize(n));
    }
    return normals;
  }

  let lastRotationAxis = initialUp;
  for (let i = 0; i < tangents.length; i += 1) {
    if (i === 0) {
      normals.push(vec3.normalize(vec3.cross(lastRotationAxis, tangents[0])));
      continue;
    }

    const offset = vec3.sub(points[i], points[i - 1]);
    const sqrDistance = vec3.sqrMagnitude(offset);
    if (sqrDistance === 0) {
      normals.push(normals[i - 1]);
      continue;
    }

    const r = vec3.sub(
      lastRotationAxis,
      vec3.scale(offset, (2 / sqrDistance) * vec3.dot(offset, lastRotationAxis))
    );
    const t = vec3.sub(
      tangents[i - 1],
      vec3.scale(offset, (2 / sqrDistance) * vec3.dot(offset, tangents[i - 1]))
    );

    const v2 = vec3.sub(tangents[i], t);
    const c2 = vec3.dot(v2, v2);
    let finalRot = r;
    if (c2 !== 0) {
      finalRot = vec3.sub(r, vec3.scale(v2, (2 / c2) * vec3.dot(v2, r)));
    }

    normals.push(vec3.normalize(vec3.cross(finalRot, tangents[i])));
    lastRotationAxis = finalRot;
  }

  for (const map of anchorAngles) {
    const count = Math.max(1, map.endIndex - map.startIndex);
    for (let i = 0; i <= count; i += 1) {
      const idx = map.startIndex + i;
      if (idx >= normals.length) continue;
      const t = count === 0 ? 1 : i / count;
      const angleDeg = lerp(map.startAngle, map.endAngle, t) + globalNormalsAngle;
      const angleRad = (angleDeg * Math.PI) / 180;
      normals[idx] = rotateAroundAxis(normals[idx], tangents[idx], angleRad);
      if (flipNormals) {
        normals[idx] = vec3.scale(normals[idx], -1);
      }
      normals[idx] = vec3.normalize(normals[idx]);
    }
  }

  return normals;
}

function buildAnchorNormalAngles(
  bezierPath: BezierPath,
  splitData: PathSplitData
): Array<{ startIndex: number; endIndex: number; startAngle: number; endAngle: number }> {
  const mapped: Array<{ startIndex: number; endIndex: number; startAngle: number; endAngle: number }> = [];
  const count = splitData.anchorVertexMap.length - 1;

  for (let anchorIndex = 0; anchorIndex < count; anchorIndex += 1) {
    const nextAnchorIndex = bezierPath.isClosed
      ? (anchorIndex + 1) % bezierPath.numSegments
      : anchorIndex + 1;

    const startAngle = bezierPath.getAnchorNormalAngle(anchorIndex);
    const endAngle = bezierPath.getAnchorNormalAngle(nextAnchorIndex);

    mapped.push({
      startIndex: splitData.anchorVertexMap[anchorIndex],
      endIndex: splitData.anchorVertexMap[anchorIndex + 1],
      startAngle,
      endAngle
    });
  }

  return mapped;
}
