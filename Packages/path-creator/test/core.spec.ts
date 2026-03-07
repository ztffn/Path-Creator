import { describe, expect, it } from "vitest";
import { BezierPath, ControlMode, EndOfPathInstruction, PathSpace, VertexPath } from "../src/core";

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
});

describe("BezierPath editing operations", () => {
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
