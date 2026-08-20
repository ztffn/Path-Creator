import { describe, expect, it } from "vitest";
import {
  bezierAnchorCount,
  BezierPath,
  ControlMode,
  createPathCart,
  EndOfPathInstruction,
  PathSpace,
  sampleCartFrame,
  VertexPath
} from "../src/core";

describe("VertexPath.resolveDistance", () => {
  const path = new VertexPath(
    [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 }
    ],
    [0, 10]
  );

  it("clamps in stop mode", () => {
    expect(path.resolveDistance(12, EndOfPathInstruction.Stop)).toBe(10);
  });

  it("wraps in loop mode", () => {
    expect(path.resolveDistance(12, EndOfPathInstruction.Loop)).toBe(2);
  });

  it("ping-pongs in reverse mode", () => {
    expect(path.resolveDistance(12, EndOfPathInstruction.Reverse)).toBe(8);
  });
});

describe("BezierPath + VertexPath integration", () => {
  const bezier = new BezierPath(
    [
      { x: 0, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
      { x: 4, y: 1, z: 0 }
    ],
    { space: PathSpace.XYZ }
  );

  const vertexPath = new VertexPath(bezier, { maxAngleError: 1, minVertexDistance: 0.05 });

  it("builds sampled vertices with increasing cumulative length", () => {
    expect(vertexPath.numPoints).toBeGreaterThan(2);
    for (let i = 1; i < vertexPath.cumulativeLengthAtEachVertex.length; i += 1) {
      expect(vertexPath.cumulativeLengthAtEachVertex[i]).toBeGreaterThanOrEqual(
        vertexPath.cumulativeLengthAtEachVertex[i - 1]
      );
    }
  });

  it("clamps time queries in stop mode", () => {
    const atStart = vertexPath.getPointAtTime(0, EndOfPathInstruction.Stop);
    const beforeStart = vertexPath.getPointAtTime(-2, EndOfPathInstruction.Stop);
    const atEnd = vertexPath.getPointAtTime(1, EndOfPathInstruction.Stop);
    const afterEnd = vertexPath.getPointAtTime(2, EndOfPathInstruction.Stop);

    expect(beforeStart.x).toBeCloseTo(atStart.x, 6);
    expect(beforeStart.y).toBeCloseTo(atStart.y, 6);
    expect(afterEnd.x).toBeCloseTo(atEnd.x, 6);
    expect(afterEnd.y).toBeCloseTo(atEnd.y, 6);
  });

  it("finds closest distance on path", () => {
    const d = vertexPath.getClosestDistanceAlongPath({ x: 1.8, y: 0.2, z: 0 });
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThanOrEqual(vertexPath.length);
  });

  it("keeps evenly sampled vertex path close to bezier anchors", () => {
    const curved = new BezierPath(
      [
        { x: -2, y: 0.5, z: -1.2 },
        { x: -0.5, y: 1.8, z: 1.6 },
        { x: 1.5, y: -1.2, z: -0.4 },
        { x: 3, y: 0.3, z: 1.4 }
      ],
      { space: PathSpace.XYZ, controlMode: ControlMode.Free }
    );
    curved.autoSmooth(0.4);

    const sampled = new VertexPath(curved, { spacing: 0.08 });

    for (let i = 0; i < curved.numAnchorPoints; i += 1) {
      const anchor = curved.getAnchor(i);
      const closest = sampled.getClosestPointOnPath(anchor);
      const distance = Math.hypot(
        closest.x - anchor.x,
        closest.y - anchor.y,
        closest.z - anchor.z
      );
      expect(distance).toBeLessThan(0.2);
    }
  });
});

describe("BezierPath editing operations", () => {
  it("uses correct open-path segment count and endpoint segment", () => {
    const bezier = new BezierPath(
      [
        { x: 0, y: 0, z: 0 },
        { x: 1, y: 0.4, z: 0 },
        { x: 2, y: -0.3, z: 0 },
        { x: 3, y: 0.2, z: 0 }
      ],
      { space: PathSpace.XYZ, controlMode: ControlMode.Free, isClosed: false }
    );

    expect(bezier.numAnchorPoints).toBe(4);
    expect(bezier.numSegments).toBe(3);

    const firstAnchor = bezier.getAnchor(0);
    const lastAnchor = bezier.getAnchor(bezier.numAnchorPoints - 1);
    const firstSegment = bezier.getPointsInSegment(0);
    const lastSegment = bezier.getPointsInSegment(bezier.numSegments - 1);

    expect(firstSegment[0].x).toBeCloseTo(firstAnchor.x, 6);
    expect(firstSegment[0].y).toBeCloseTo(firstAnchor.y, 6);
    expect(lastSegment[3].x).toBeCloseTo(lastAnchor.x, 6);
    expect(lastSegment[3].y).toBeCloseTo(lastAnchor.y, 6);
  });

  it("splits segment and increases anchor count", () => {
    const bezier = new BezierPath(
      [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 }
      ],
      { space: PathSpace.XYZ, controlMode: ControlMode.Free }
    );

    const beforeAnchors = bezier.numAnchorPoints;
    const newAnchorIndex = bezier.splitSegment(0, 0.5);
    expect(bezier.numAnchorPoints).toBe(beforeAnchors + 1);
    expect(newAnchorIndex % 3).toBe(0);
  });

  it("deletes anchor when enough segments exist", () => {
    const bezier = new BezierPath(
      [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 0, z: 0 },
        { x: 4, y: 0, z: 0 },
        { x: 6, y: 0, z: 0 }
      ],
      { space: PathSpace.XYZ, controlMode: ControlMode.Free }
    );

    const beforeAnchors = bezier.numAnchorPoints;
    const deleted = bezier.deleteAnchor(3);
    expect(deleted).toBe(true);
    expect(bezier.numAnchorPoints).toBe(beforeAnchors - 1);
  });

  it("autoSmooth updates controls without changing anchor count", () => {
    const bezier = new BezierPath(
      [
        { x: 0, y: 0, z: 0 },
        { x: 2, y: 1, z: 0 },
        { x: 4, y: 0, z: 0 }
      ],
      { space: PathSpace.XYZ, controlMode: ControlMode.Free }
    );

    const beforeAnchors = bezier.numAnchorPoints;
    const beforeControl = bezier.getPoint(1);
    bezier.autoSmooth(0.45);
    const afterControl = bezier.getPoint(1);

    expect(bezier.numAnchorPoints).toBe(beforeAnchors);
    expect(afterControl.x !== beforeControl.x || afterControl.y !== beforeControl.y || afterControl.z !== beforeControl.z).toBe(true);
  });
});

describe("fromJSON normalizes the per-anchor normals array", () => {
  const straight = {
    points: [
      { x: 0, y: 0, z: 0 },
      { x: 3, y: 0, z: 0 },
      { x: 7, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ],
    isClosed: false,
    space: PathSpace.XYZ,
    controlMode: ControlMode.Automatic,
    autoControlLength: 0.3,
    flipNormals: false,
    globalNormalsAngle: 0
  };

  it("pads a short array to one entry per anchor", () => {
    const path = BezierPath.fromJSON({ ...straight, perAnchorNormalsAngle: [] });
    expect(path.toJSON().perAnchorNormalsAngle).toEqual([0, 0]);
  });

  it("trims a long one, and replaces a non-finite entry", () => {
    const path = BezierPath.fromJSON({
      ...straight,
      perAnchorNormalsAngle: [12, Number.NaN, 4, 9]
    });
    expect(path.toJSON().perAnchorNormalsAngle).toEqual([12, 0]);
  });

  it("a short array no longer yields NaN frames — the silent failure this fixes", () => {
    // A length mismatch did not throw: it produced NaN normals that propagated into every
    // sampled frame, while VertexPath.length still read correctly. So the symptom was a camera
    // at NaN with a path that measured 10 m.
    const path = BezierPath.fromJSON({ ...straight, perAnchorNormalsAngle: [] });
    const vertexPath = new VertexPath(path, { maxAngleError: 0.3, minVertexDistance: 0.01 });
    const cart = createPathCart({ distance: 5 });
    const frame = sampleCartFrame(vertexPath, cart, 5);
    expect(Number.isFinite(frame.position.x)).toBe(true);
    expect(frame.position.x).toBeCloseTo(5, 1);
    expect(Number.isFinite(frame.up.y)).toBe(true);
  });

  it("bezierAnchorCount counts open and closed point lists", () => {
    expect(bezierAnchorCount(4, false)).toBe(2);
    expect(bezierAnchorCount(7, false)).toBe(3);
    expect(bezierAnchorCount(6, true)).toBe(2);
  });
});
