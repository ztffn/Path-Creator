import { describe, expect, it } from "vitest";
import { Group, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { VertexPath, createPathCart, sampleCartFrame } from "../src/core";
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
  applyVirtualCameraNoise,
  hideEditorHelpers,
  markEditorHelpers,
  showEditorHelpers,
  resolveVirtualCameraDefinition,
  resolveVirtualCameraTransition,
  retargetVirtualCameraBrain,
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

describe("virtual camera bodies", () => {
  const straightPath = new VertexPath(
    [
      { x: 0, y: 0, z: 0 },
      { x: 10, y: 0, z: 0 }
    ],
    [0, 10]
  );
  const cart = createPathCart({ distance: 5 });
  const getCartFrame = (cartId: string) =>
    cartId === "cart-1" ? sampleCartFrame(straightPath, cart) : null;

  it("resolves a static body to its pose", () => {
    const snapshot = resolveVirtualCameraDefinition({
      id: "vcam-static",
      body: {
        type: "static",
        position: { x: 1, y: 2, z: 3 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 }
      },
      lens: { fov: 30 }
    });

    expect(snapshot).not.toBeNull();
    expect(snapshot?.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(snapshot?.lens?.fov).toBe(30);
  });

  it("resolves a cart body looking along the cart forward", () => {
    const snapshot = resolveVirtualCameraDefinition(
      { id: "vcam-cart", body: { type: "cart", cartId: "cart-1" } },
      { getCartFrame }
    );

    expect(snapshot).not.toBeNull();
    const frame = sampleCartFrame(straightPath, cart);
    expect(snapshot?.position.x).toBeCloseTo(frame.position.x);

    const q = snapshot!.quaternion;
    const look = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
    expect(look.x).toBeCloseTo(frame.forward.x);
    expect(look.y).toBeCloseTo(frame.forward.y);
    expect(look.z).toBeCloseTo(frame.forward.z);
  });

  it("re-resolves as the cart moves", () => {
    const moving = createPathCart({ distance: 2 });
    const resolveAt = () =>
      resolveVirtualCameraDefinition(
        { id: "v", body: { type: "cart", cartId: "c" } },
        { getCartFrame: () => sampleCartFrame(straightPath, moving) }
      );

    const a = resolveAt();
    moving.distance = 7;
    const b = resolveAt();
    expect(a?.position.x).toBeCloseTo(2);
    expect(b?.position.x).toBeCloseTo(7);
  });

  it("look-at aim orients toward the target", () => {
    const snapshot = resolveVirtualCameraDefinition({
      id: "vcam-aim",
      body: {
        type: "static",
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 }
      },
      aim: { type: "look-at", target: { x: 10, y: 0, z: 0 } }
    });

    const q = snapshot!.quaternion;
    const look = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
    expect(look.x).toBeCloseTo(1);
    expect(look.y).toBeCloseTo(0);
    expect(look.z).toBeCloseTo(0);
  });

  it("returns null when the referenced cart is unavailable", () => {
    const snapshot = resolveVirtualCameraDefinition(
      { id: "vcam-missing", body: { type: "cart", cartId: "nope" } },
      { getCartFrame }
    );
    expect(snapshot).toBeNull();
  });
});

describe("retargetVirtualCameraBrain", () => {
  const poseAt = (x: number): VirtualCameraSnapshot => ({
    position: { x, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  });

  it("keeps a blend chasing a moving target", () => {
    const brain = createVirtualCameraBrainState(poseAt(0));
    activateVirtualCameraBrain(brain, poseAt(10), { durationSeconds: 2, curve: "linear" });

    updateToCompletion(brain, 1);
    expect(brain.live?.position.x).toBeCloseTo(5);

    retargetVirtualCameraBrain(brain, { target: poseAt(20) });
    updateToCompletion(brain, 1);
    expect(brain.live?.position.x).toBeCloseTo(20);
    expect(brain.isBlending).toBe(false);
  });

  it("updates the outgoing pose too", () => {
    const brain = createVirtualCameraBrainState(poseAt(0));
    activateVirtualCameraBrain(brain, poseAt(10), { durationSeconds: 2, curve: "linear" });

    retargetVirtualCameraBrain(brain, { previous: poseAt(4) });
    updateToCompletion(brain, 1);
    expect(brain.live?.position.x).toBeCloseTo(7);
  });
});

describe("virtual camera noise channel", () => {
  const base: VirtualCameraSnapshot = {
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  };

  it("is deterministic for identical settings and time", () => {
    const noise = { seed: 7, positionAmplitude: 0.5, rotationAmplitudeDeg: 2 };
    const a = applyVirtualCameraNoise(base, noise, 1.234);
    const b = applyVirtualCameraNoise(base, noise, 1.234);
    expect(a).toEqual(b);
  });

  it("varies over time and by seed", () => {
    const noise = { seed: 7, positionAmplitude: 0.5 };
    const t0 = applyVirtualCameraNoise(base, noise, 0.2);
    const t1 = applyVirtualCameraNoise(base, noise, 1.7);
    const otherSeed = applyVirtualCameraNoise(base, { ...noise, seed: 8 }, 0.2);
    expect(t0.position).not.toEqual(t1.position);
    expect(t0.position).not.toEqual(otherSeed.position);
  });

  it("stays within the position amplitude", () => {
    const noise = { positionAmplitude: 0.25 };
    for (let i = 0; i < 50; i += 1) {
      const shaken = applyVirtualCameraNoise(base, noise, i * 0.13);
      expect(Math.abs(shaken.position.x)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(shaken.position.y)).toBeLessThanOrEqual(0.25);
      expect(Math.abs(shaken.position.z)).toBeLessThanOrEqual(0.25);
    }
  });

  it("leaves the snapshot unchanged at zero amplitude", () => {
    const shaken = applyVirtualCameraNoise(base, { seed: 3 }, 2.5);
    expect(shaken.position).toEqual(base.position);
    expect(shaken.quaternion).toEqual(base.quaternion);
  });

  it("resolves through the definition with context time", () => {
    const definition = {
      id: "v",
      body: {
        type: "static" as const,
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 }
      },
      noise: { seed: 5, positionAmplitude: 0.3 }
    };
    const a = resolveVirtualCameraDefinition(definition, { elapsedSeconds: 0.5 });
    const b = resolveVirtualCameraDefinition(definition, { elapsedSeconds: 2.5 });
    expect(a?.position).not.toEqual(b?.position);
  });
});

describe("dutch lens", () => {
  it("rolls the camera around the view axis", () => {
    const camera = new PerspectiveCamera();
    applyVirtualCameraSnapshot(camera, {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      lens: { dutchDeg: 90 }
    });

    const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    expect(Math.abs(up.y)).toBeCloseTo(0, 5);
    const look = new Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(look.z).toBeCloseTo(-1, 5);
  });

  it("blends dutch between lenses, treating absence as zero", () => {
    const from: VirtualCameraSnapshot = {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      lens: { fov: 50 }
    };
    const to: VirtualCameraSnapshot = {
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 },
      lens: { fov: 50, dutchDeg: 20 }
    };
    const blended = blendVirtualCameraSnapshots(from, to, 0.5, { curve: "linear" });
    expect(blended.lens?.dutchDeg).toBeCloseTo(10);
  });
});

describe("editor helper layers", () => {
  it("moves a tree onto the helper layer and gates it per camera", () => {
    const root = new Group();
    const child = new Group();
    root.add(child);
    markEditorHelpers(root);

    const playbackCamera = new PerspectiveCamera();
    expect(playbackCamera.layers.test(root.layers)).toBe(false);
    expect(playbackCamera.layers.test(child.layers)).toBe(false);

    const editorCamera = new PerspectiveCamera();
    showEditorHelpers(editorCamera);
    expect(editorCamera.layers.test(root.layers)).toBe(true);

    hideEditorHelpers(editorCamera);
    expect(editorCamera.layers.test(root.layers)).toBe(false);
  });
});
