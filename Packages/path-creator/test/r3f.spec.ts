import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three";
import { EndOfPathInstruction, VertexPath } from "../src/core";
import {
  applyDollyCamera,
  samplePathAtDistance,
  updateFollowerState,
  vec3Distance
} from "../src/r3f";

describe("r3f runtime helpers", () => {
  const path = new VertexPath(
    [
      { x: 0, y: 0, z: 0 },
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 }
    ],
    [0, 1, 2]
  );

  it("updateFollowerState advances and wraps", () => {
    const next = updateFollowerState(
      { distance: 1.8 },
      1,
      1,
      path,
      EndOfPathInstruction.Loop
    );

    expect(next.distance).toBeCloseTo(0.8, 6);
  });

  it("samplePathAtDistance matches path query", () => {
    const sample = samplePathAtDistance(path, 0.5, EndOfPathInstruction.Stop);
    const p = path.getPointAtDistance(0.5, EndOfPathInstruction.Stop);
    expect(vec3Distance(sample.position, p)).toBeCloseTo(0, 6);
  });

  it("applyDollyCamera moves camera toward sample", () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 5);

    const sample = samplePathAtDistance(path, 1, EndOfPathInstruction.Stop);
    applyDollyCamera(camera, sample, { x: 2, y: 0, z: 0 }, 0, 1 / 60);

    expect(camera.position.x).toBeCloseTo(sample.position.x, 6);
    expect(camera.position.y).toBeCloseTo(sample.position.y, 6);
    expect(camera.position.z).toBeCloseTo(sample.position.z, 6);
  });
});
