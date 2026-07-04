import { describe, expect, it } from "vitest";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { VertexPath } from "../src/core";
import {
  activateVirtualCameraBrain,
  applyVirtualCameraBrain,
  applyVirtualCameraSnapshot,
  applyVirtualCameraTransition,
  blendVirtualCameraSnapshots,
  buildRoadMeshBuffers,
  buildTubeMeshBuffers,
  captureVirtualCameraSnapshot,
  createVirtualCameraBrainState,
  evaluateVirtualCameraBlendCurve,
  getVirtualCameraBrainProgress,
  resolveVirtualCameraTransition,
  type VirtualCameraSnapshot
} from "../src/three";

describe("three geometry builders", () => {
  const path = new VertexPath(
    [
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0.5, z: 0 },
      { x: 1, y: 0, z: 0 }
    ],
    [0, 1, 2]
  );

  it("buildRoadMeshBuffers returns valid indexed triangles", () => {
    const mesh = buildRoadMeshBuffers(path, { roadWidth: 0.3, thickness: 0.1 });
    expect(mesh.positions.length).toBe(path.numPoints * 8 * 3);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.normals?.length).toBe(mesh.positions.length);
    expect(mesh.uvs?.length).toBe(path.numPoints * 8 * 2);
  });

  it("buildTubeMeshBuffers returns valid tube data", () => {
    const mesh = buildTubeMeshBuffers(path, {
      radius: 0.2,
      radialSegments: 8,
      segmentsPerUnit: 4
    });

    expect(mesh.positions.length).toBeGreaterThan(0);
    expect(mesh.indices.length).toBeGreaterThan(0);
    expect(mesh.indices.length % 3).toBe(0);
    expect(mesh.normals?.length).toBe(mesh.positions.length);
    expect(mesh.uvs?.length).toBe((mesh.positions.length / 3) * 2);
  });
});

describe("three virtual cameras", () => {
  const yAxis = new Vector3(0, 1, 0);

  it("captures and applies camera pose and lens state", () => {
    const source = new PerspectiveCamera(40, 16 / 9, 0.2, 250);
    source.position.set(1, 2, 3);
    source.quaternion.setFromAxisAngle(yAxis, Math.PI / 4);
    source.zoom = 1.5;

    const snapshot = captureVirtualCameraSnapshot(source, {
      name: "hero",
      settings: { targetWeight: 0.75 }
    });

    const target = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
    applyVirtualCameraSnapshot(target, snapshot);

    expect(target.position.x).toBeCloseTo(1, 6);
    expect(target.position.y).toBeCloseTo(2, 6);
    expect(target.position.z).toBeCloseTo(3, 6);
    expect(target.quaternion.angleTo(source.quaternion)).toBeCloseTo(0, 6);
    expect(target.fov).toBeCloseTo(40, 6);
    expect(target.near).toBeCloseTo(0.2, 6);
    expect(target.far).toBeCloseTo(250, 6);
    expect(target.zoom).toBeCloseTo(1.5, 6);
    expect(snapshot.settings?.targetWeight).toBeCloseTo(0.75, 6);
  });

  it("cuts immediately when no source camera or duration is present", () => {
    const camera = new PerspectiveCamera();
    const to = snapshot("b", 10, new Quaternion().setFromAxisAngle(yAxis, Math.PI / 2));

    const applied = applyVirtualCameraTransition(camera, undefined, to, {
      durationSeconds: 1,
      elapsedSeconds: 0.25
    });

    expect(applied.position.x).toBeCloseTo(10, 6);
    expect(camera.position.x).toBeCloseTo(10, 6);
    expect(camera.quaternion.angleTo(toQuaternion(to))).toBeCloseTo(0, 6);
  });

  it("blends position, rotation, lens, and numeric settings", () => {
    const from = snapshot("a", 0, new Quaternion(), {
      lens: { fov: 40, near: 0.1, far: 100 },
      settings: { screenX: -0.2, targetWeight: 0.25 }
    });
    const to = snapshot("b", 10, new Quaternion().setFromAxisAngle(yAxis, Math.PI), {
      lens: { fov: 60, near: 0.3, far: 300 },
      settings: { screenX: 0.2, targetWeight: 0.75 }
    });

    const blended = blendVirtualCameraSnapshots(from, to, 0.5, { curve: "linear" });
    const blendedQuaternion = toQuaternion(blended);

    expect(blended.position.x).toBeCloseTo(5, 6);
    expect(blendedQuaternion.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 2, 6);
    expect(blended.lens?.fov).toBeCloseTo(50, 6);
    expect(blended.lens?.near).toBeCloseTo(0.2, 6);
    expect(blended.lens?.far).toBeCloseTo(200, 6);
    expect(blended.settings?.screenX).toBeCloseTo(0, 6);
    expect(blended.settings?.targetWeight).toBeCloseTo(0.5, 6);
  });

  it("resolves elapsed blend progress using the requested curve", () => {
    const from = snapshot("a", 0, new Quaternion());
    const to = snapshot("b", 10, new Quaternion());

    const resolved = resolveVirtualCameraTransition(from, to, {
      durationSeconds: 2,
      elapsedSeconds: 1,
      curve: "easeIn"
    });

    expect(evaluateVirtualCameraBlendCurve(0.5, "easeIn")).toBeCloseTo(0.25, 6);
    expect(resolved.position.x).toBeCloseTo(2.5, 6);
  });

  it("brain cuts on first activation", () => {
    const brain = createVirtualCameraBrainState();
    const to = snapshot("b", 10, new Quaternion());

    activateVirtualCameraBrain(brain, to, {
      durationSeconds: 2,
      curve: "easeInOut"
    });

    expect(brain.isBlending).toBe(false);
    expect(brain.live?.position.x).toBeCloseTo(10, 6);
    expect(getVirtualCameraBrainProgress(brain)).toBeCloseTo(1, 6);
  });

  it("brain advances a timed blend and completes on target", () => {
    const from = snapshot("a", 0, new Quaternion());
    const to = snapshot("b", 10, new Quaternion());
    const brain = createVirtualCameraBrainState(from);

    activateVirtualCameraBrain(brain, to, {
      durationSeconds: 2,
      curve: "linear"
    });

    const halfway = applyVirtualCameraBrain(new PerspectiveCamera(), brain, 1);
    expect(halfway?.position.x).toBeCloseTo(5, 6);
    expect(getVirtualCameraBrainProgress(brain)).toBeCloseTo(0.5, 6);
    expect(brain.isBlending).toBe(true);

    const done = updateToCompletion(brain, 1);
    expect(done?.position.x).toBeCloseTo(10, 6);
    expect(brain.live?.position.x).toBeCloseTo(10, 6);
    expect(brain.isBlending).toBe(false);
    expect(getVirtualCameraBrainProgress(brain)).toBeCloseTo(1, 6);
  });

  it("brain applies resolved snapshots to a camera", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const from = snapshot("a", 0, new Quaternion(), { lens: { fov: 60 } });
    const to = snapshot("b", 10, new Quaternion().setFromAxisAngle(yAxis, Math.PI), {
      lens: { fov: 40 }
    });
    const brain = createVirtualCameraBrainState(from);

    activateVirtualCameraBrain(brain, to, {
      durationSeconds: 2,
      curve: "linear"
    });
    applyVirtualCameraBrain(camera, brain, 1);

    expect(camera.position.x).toBeCloseTo(5, 6);
    expect(camera.quaternion.angleTo(new Quaternion())).toBeCloseTo(Math.PI / 2, 6);
    expect(camera.fov).toBeCloseTo(50, 6);
  });
});

function snapshot(
  name: string,
  x: number,
  quaternion: Quaternion,
  options: Partial<Pick<VirtualCameraSnapshot, "lens" | "settings">> = {}
): VirtualCameraSnapshot {
  return {
    name,
    position: { x, y: 0, z: 0 },
    quaternion: {
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w
    },
    ...options
  };
}

function toQuaternion(snapshot: VirtualCameraSnapshot): Quaternion {
  return new Quaternion(
    snapshot.quaternion.x,
    snapshot.quaternion.y,
    snapshot.quaternion.z,
    snapshot.quaternion.w
  );
}

function updateToCompletion(
  brain: ReturnType<typeof createVirtualCameraBrainState>,
  deltaSeconds: number
): VirtualCameraSnapshot | undefined {
  return applyVirtualCameraBrain(new PerspectiveCamera(), brain, deltaSeconds);
}
