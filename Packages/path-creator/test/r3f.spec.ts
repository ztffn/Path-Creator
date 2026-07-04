import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Vector3 } from "three";
import { EndOfPathInstruction, VertexPath, type Vec3 } from "../src/core";
import {
  applyDollyCamera,
  applyScreenComposerAim,
  createScreenComposerState,
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

  it("screen composer preserves rotation while target is inside the dead zone", () => {
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
    const initial = camera.quaternion.clone();
    const target = targetAtScreen(camera, { x: 0.04, y: 0.03 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      {
        deadZone: { width: 0.2, height: 0.2 },
        damping: { x: 0, y: 0 }
      },
      1 / 60
    );

    expect(camera.quaternion.angleTo(initial)).toBeCloseTo(0, 6);
  });

  it("screen composer corrects to the nearest dead-zone edge instead of center", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.3, y: 0 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      {
        deadZone: { width: 0.2, height: 0.2 },
        damping: { x: 0, y: 0 }
      },
      1 / 60
    );

    expect(screenPosition(camera, target).x).toBeCloseTo(0.1, 5);
  });

  it("screen composer respects non-center screen position", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.32, y: -0.12 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      {
        screenPosition: { x: 0.2, y: -0.1 },
        deadZone: { width: 0.1, height: 0.1 },
        damping: { x: 0, y: 0 }
      },
      1 / 60
    );

    const screen = screenPosition(camera, target);
    expect(screen.x).toBeCloseTo(0.25, 5);
    expect(Math.abs(screen.y - -0.1)).toBeLessThanOrEqual(0.05);
  });

  it("screen composer can center on activation", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.3, y: -0.2 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      {
        screenPosition: { x: 0.1, y: -0.1 },
        deadZone: { width: 0.2, height: 0.2 },
        damping: { x: 1, y: 1 },
        centerOnActivate: true
      },
      1 / 60
    );

    const screen = screenPosition(camera, target);
    expect(screen.x).toBeCloseTo(0.1, 2);
    expect(screen.y).toBeCloseTo(-0.1, 2);
  });

  it("screen composer clamps hard-limit breaches immediately", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.7, y: 0 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      {
        deadZone: { width: 0.2, height: 0.2 },
        hardLimits: { width: 0.8, height: 0.8 },
        damping: { x: 0.000001, y: 0.000001 }
      },
      1 / 60
    );

    expect(screenPosition(camera, target).x).toBeLessThanOrEqual(0.400001);
  });

  it("screen composer applies horizontal and vertical damping independently", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.3, y: 0.3 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      {
        deadZone: { width: 0.2, height: 0.2 },
        damping: { x: 12, y: 1 }
      },
      1 / 30
    );

    const screen = screenPosition(camera, target);
    expect(Math.abs(screen.x - 0.1)).toBeLessThan(Math.abs(screen.y - 0.1));
  });

  it("screen composer damping is based on delta seconds", () => {
    const target: Vec3 = targetAtScreen(new PerspectiveCamera(60, 1, 0.1, 100), {
      x: 0.28,
      y: 0
    });
    const oneStep = new PerspectiveCamera(60, 1, 0.1, 100);
    const manySteps = new PerspectiveCamera(60, 1, 0.1, 100);
    const oneStepState = createScreenComposerState();
    const manyStepsState = createScreenComposerState();
    const options = {
      deadZone: { width: 0.2, height: 0.2 },
      damping: { x: 4, y: 4 }
    };

    applyScreenComposerAim(oneStep, target, { x: 0, y: 1, z: 0 }, oneStepState, options, 1);
    for (let i = 0; i < 60; i += 1) {
      applyScreenComposerAim(
        manySteps,
        target,
        { x: 0, y: 1, z: 0 },
        manyStepsState,
        options,
        1 / 60
      );
    }

    expect(screenPosition(manySteps, target).x).toBeCloseTo(screenPosition(oneStep, target).x, 2);
  });

  it("screen composer lookahead initializes and resets cleanly on teleports", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const state = createScreenComposerState();
    const options = {
      lookaheadTime: 0.5,
      lookaheadSmoothing: 8,
      damping: { x: 0, y: 0 }
    };

    applyScreenComposerAim(camera, { x: 0, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, state, options, 1 / 60);
    expect(vec3Distance(state.smoothedVelocity ?? { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(0, 6);

    applyScreenComposerAim(camera, { x: 100, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, state, options, 1 / 60);
    expect(vec3Distance(state.smoothedVelocity ?? { x: 1, y: 1, z: 1 }, { x: 0, y: 0, z: 0 })).toBeCloseTo(0, 6);
  });

  it("screen composer lookahead smoothing increases prediction lag", () => {
    const fastState = createScreenComposerState();
    const slowState = createScreenComposerState();
    const fastCamera = new PerspectiveCamera(60, 1, 0.1, 100);
    const slowCamera = new PerspectiveCamera(60, 1, 0.1, 100);
    const baseOptions = {
      lookaheadTime: 0.25,
      damping: { x: 0, y: 0 }
    };

    applyScreenComposerAim(
      fastCamera,
      { x: 0, y: 0, z: -10 },
      { x: 0, y: 1, z: 0 },
      fastState,
      { ...baseOptions, lookaheadSmoothing: 1 },
      1 / 60
    );
    applyScreenComposerAim(
      slowCamera,
      { x: 0, y: 0, z: -10 },
      { x: 0, y: 1, z: 0 },
      slowState,
      { ...baseOptions, lookaheadSmoothing: 12 },
      1 / 60
    );

    applyScreenComposerAim(
      fastCamera,
      { x: 1, y: 0, z: -10 },
      { x: 0, y: 1, z: 0 },
      fastState,
      { ...baseOptions, lookaheadSmoothing: 1 },
      1 / 60
    );
    applyScreenComposerAim(
      slowCamera,
      { x: 1, y: 0, z: -10 },
      { x: 0, y: 1, z: 0 },
      slowState,
      { ...baseOptions, lookaheadSmoothing: 12 },
      1 / 60
    );

    expect(Math.abs(slowState.smoothedVelocity?.x ?? 0)).toBeLessThan(
      Math.abs(fastState.smoothedVelocity?.x ?? 0)
    );
  });
});

function targetAtScreen(
  camera: PerspectiveCamera,
  screen: { x: number; y: number },
  distance = 10
): Vec3 {
  const verticalFov = (camera.fov * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  return {
    x: Math.tan(screen.x * horizontalFov) * distance,
    y: Math.tan(screen.y * verticalFov) * distance,
    z: -distance
  };
}

function screenPosition(camera: PerspectiveCamera, target: Vec3): { x: number; y: number } {
  const verticalFov = (camera.fov * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const local = camera.worldToLocal(new Vector3(target.x, target.y, target.z));

  return {
    x: Math.atan2(local.x, -local.z) / horizontalFov,
    y: Math.atan2(local.y, Math.hypot(local.x, -local.z)) / verticalFov
  };
}
