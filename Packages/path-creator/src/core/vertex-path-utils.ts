import { evaluateCurve, evaluateCurveDerivative, estimateCurveLength } from "./cubic-bezier";
import type { BezierPath } from "./bezier-path";
import type { Vec3 } from "./types";
import { vec3 } from "./vec3";

export interface PathSplitData {
  vertices: Vec3[];
  tangents: Vec3[];
  cumulativeLength: number[];
  anchorVertexMap: number[];
}

const DEFAULT_ACCURACY = 10;

export function splitBezierPathByAngleError(
  bezierPath: BezierPath,
  maxAngleError: number,
  minVertexDistance: number,
  accuracy = DEFAULT_ACCURACY
): PathSplitData {
  const splitData: PathSplitData = {
    vertices: [bezierPath.getPoint(0)],
    tangents: [vec3.normalize(evaluateCurveDerivative(bezierPath.getPointsInSegment(0), 0))],
    cumulativeLength: [0],
    anchorVertexMap: [0]
  };

  let prevPointOnPath = bezierPath.getPoint(0);
  let lastAddedPoint = bezierPath.getPoint(0);
  let currentPathLength = 0;
  let distanceSinceLastVertex = 0;

  for (let segmentIndex = 0; segmentIndex < bezierPath.numSegments; segmentIndex += 1) {
    const segmentPoints = bezierPath.getPointsInSegment(segmentIndex);
    const estimatedSegmentLength = estimateCurveLength(...segmentPoints);
    const divisions = Math.max(2, Math.ceil(estimatedSegmentLength * accuracy));
    const increment = 1 / divisions;

    for (let t = increment; t <= 1 + 1e-6; t += increment) {
      const isLastPointOnPath = t + increment > 1 && segmentIndex === bezierPath.numSegments - 1;
      const evalT = isLastPointOnPath ? 1 : t;
      const pointOnPath = evaluateCurve(segmentPoints, evalT);
      const nextPointOnPath = evaluateCurve(segmentPoints, Math.min(evalT + increment, 1));

      const localAngle = 180 - minAngle(prevPointOnPath, pointOnPath, nextPointOnPath);
      const angleFromPrevVertex = 180 - minAngle(lastAddedPoint, pointOnPath, nextPointOnPath);
      const angleError = Math.max(localAngle, angleFromPrevVertex);

      if ((angleError > maxAngleError && distanceSinceLastVertex >= minVertexDistance) || isLastPointOnPath) {
        currentPathLength += vec3.distance(lastAddedPoint, pointOnPath);
        splitData.cumulativeLength.push(currentPathLength);
        splitData.vertices.push(pointOnPath);
        splitData.tangents.push(vec3.normalize(evaluateCurveDerivative(segmentPoints, evalT)));
        distanceSinceLastVertex = 0;
        lastAddedPoint = pointOnPath;
      } else {
        distanceSinceLastVertex += vec3.distance(pointOnPath, prevPointOnPath);
      }

      prevPointOnPath = pointOnPath;
    }

    splitData.anchorVertexMap.push(splitData.vertices.length - 1);
  }

  return splitData;
}

export function splitBezierPathEvenly(
  bezierPath: BezierPath,
  spacing: number,
  accuracy = DEFAULT_ACCURACY
): PathSplitData {
  const splitData: PathSplitData = {
    vertices: [bezierPath.getPoint(0)],
    tangents: [vec3.normalize(evaluateCurveDerivative(bezierPath.getPointsInSegment(0), 0))],
    cumulativeLength: [0],
    anchorVertexMap: [0]
  };

  let prevPointOnPath = bezierPath.getPoint(0);
  let lastAddedPoint = bezierPath.getPoint(0);
  let currentPathLength = 0;
  let distanceSinceLastVertex = 0;

  for (let segmentIndex = 0; segmentIndex < bezierPath.numSegments; segmentIndex += 1) {
    const segmentPoints = bezierPath.getPointsInSegment(segmentIndex);
    const estimatedSegmentLength = estimateCurveLength(...segmentPoints);
    const divisions = Math.max(2, Math.ceil(estimatedSegmentLength * accuracy));
    const increment = 1 / divisions;

    for (let t = increment; t <= 1 + 1e-6; t += increment) {
      const isLastPointOnPath = t + increment > 1 && segmentIndex === bezierPath.numSegments - 1;
      const evalT = isLastPointOnPath ? 1 : t;

      let pointOnPath = evaluateCurve(segmentPoints, evalT);
      distanceSinceLastVertex += vec3.distance(pointOnPath, prevPointOnPath);

      if (distanceSinceLastVertex > spacing) {
        const overshoot = distanceSinceLastVertex - spacing;
        const backDir = vec3.normalize(vec3.sub(prevPointOnPath, pointOnPath));
        pointOnPath = vec3.add(pointOnPath, vec3.scale(backDir, overshoot));
      }

      if (distanceSinceLastVertex >= spacing || isLastPointOnPath) {
        currentPathLength += vec3.distance(lastAddedPoint, pointOnPath);
        splitData.cumulativeLength.push(currentPathLength);
        splitData.vertices.push(pointOnPath);
        splitData.tangents.push(vec3.normalize(evaluateCurveDerivative(segmentPoints, evalT)));
        distanceSinceLastVertex = 0;
        lastAddedPoint = pointOnPath;
      }

      prevPointOnPath = pointOnPath;
    }

    splitData.anchorVertexMap.push(splitData.vertices.length - 1);
  }

  return splitData;
}

function minAngle(a: Vec3, b: Vec3, c: Vec3): number {
  const ab = vec3.sub(a, b);
  const cb = vec3.sub(c, b);
  const denom = vec3.magnitude(ab) * vec3.magnitude(cb);
  if (denom === 0) return 0;
  const cos = Math.max(-1, Math.min(1, vec3.dot(ab, cb) / denom));
  return (Math.acos(cos) * 180) / Math.PI;
}
