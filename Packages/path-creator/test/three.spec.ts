import { describe, expect, it } from "vitest";
import { AnimationClip, AnimationMixer, Group, Matrix4, NumberKeyframeTrack, PerspectiveCamera, Quaternion, Vector3 } from "three";
import {
  DEFAULT_COMPOSER_SETTINGS,
  VertexPath,
  createPathCart,
  sampleCartFrame,
  type ComposerSettings,
  type Vec3,
  type VirtualCameraDefinition
} from "../src/core";
import {
  activateVirtualCameraBrain,
  ActivationTrackDirector,
  AnimationTrackDirector,
  applyScreenComposerAim,
  applyVirtualCameraBrain,
  applyVirtualCameraSnapshot,
  applyVirtualCameraTransition,
  blendVirtualCameraSnapshots,
  buildDollyRailLines,
  buildRoadMeshBuffers,
  buildTubeMeshBuffers,
  captureVirtualCameraSnapshot,
  createRigComposerState,
  createRigDriveState,
  createScreenComposerState,
  createVirtualCameraBrainState,
  driveActivation,
  driveVirtualCameraBrain,
  stepComposerAim,
  evaluateVirtualCameraBlendCurve,
  getVirtualCameraBrainProgress,
  applyVirtualCameraNoise,
  buildOrbitRingPoints,
  createRigBodyState,
  hideEditorHelpers,
  markEditorHelpers,
  orbitOffset,
  orbitParamsFromLocalOffset,
  ObjectBindingRegistry,
  createOverrideInputAccumulator,
  resolveCameraPivot,
  stepCameraOverride,
  TransformTrackDirector,
  setVirtualCameraBrainLive,
  showEditorHelpers,
  resolveVirtualCameraDefinition,
  resolveVirtualCameraTransition,
  retargetVirtualCameraBrain,
  type VirtualCameraSnapshot
} from "../src/three";

// The composer takes a full ComposerSettings; tests start from the authored
// defaults and override only the fields under test.
function composer(overrides: Partial<ComposerSettings>): ComposerSettings {
  return { ...DEFAULT_COMPOSER_SETTINGS, ...overrides };
}

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

  it("buildDollyRailLines produces symmetric rails and paired ties", () => {
    const rail = buildDollyRailLines(path, { gauge: 0.2, tieSpacing: 0.5, segmentsPerUnit: 8 });

    expect(rail.left.length).toBe(rail.right.length);
    expect(rail.left.length).toBeGreaterThan(2);
    // Ties come in endpoint pairs (segment geometry).
    expect(rail.ties.length % 2).toBe(0);
    expect(rail.ties.length).toBeGreaterThanOrEqual(2);

    // Each rail sample straddles the centre by the half-gauge; left and right
    // are mirror images about the centreline, so their midpoint is the centre.
    for (let i = 0; i < rail.left.length; i += 1) {
      const l = rail.left[i];
      const r = rail.right[i];
      const gap = Math.hypot(l.x - r.x, l.y - r.y, l.z - r.z);
      expect(gap).toBeCloseTo(0.2, 6);
    }
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

  it("track aim without settings orients toward the target (instant look-at)", () => {
    const snapshot = resolveVirtualCameraDefinition({
      id: "vcam-aim",
      body: {
        type: "static",
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 }
      },
      aim: { type: "track", target: { x: 10, y: 0, z: 0 } }
    });

    const q = snapshot!.quaternion;
    const look = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
    expect(look.x).toBeCloseTo(1);
    expect(look.y).toBeCloseTo(0);
    expect(look.z).toBeCloseTo(0);
  });

  it("leaves body orientation for a track aim with settings (composer is a live post-stage)", () => {
    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "vcam-composer",
        body: {
          type: "static",
          position: { x: 0, y: 0, z: 0 },
          quaternion: { x: 0, y: 0, z: 0, w: 1 }
        },
        aim: {
          type: "track",
          target: { x: 10, y: 0, z: 0 },
          settings: DEFAULT_COMPOSER_SETTINGS
        }
      },
      { getTargetPosition: () => ({ x: 10, y: 0, z: 0 }) }
    );

    expect(snapshot?.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });

  it("returns null when the referenced cart is unavailable", () => {
    const snapshot = resolveVirtualCameraDefinition(
      { id: "vcam-missing", body: { type: "cart", cartId: "nope" } },
      { getCartFrame }
    );
    expect(snapshot).toBeNull();
  });
});

describe("orbit body", () => {
  const lookDir = (s: { quaternion: { x: number; y: number; z: number; w: number } }) =>
    new Vector3(0, 0, -1).applyQuaternion(
      new Quaternion(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w)
    );

  it("places at radius/azimuth/elevation around the target and looks back at it (world binding)", () => {
    const snapshot = resolveVirtualCameraDefinition({
      id: "orbit-world",
      body: {
        type: "orbit",
        target: { x: 0, y: 0, z: 0 },
        azimuthDeg: 0,
        elevationDeg: 0,
        radius: 5
      }
    });

    // azimuth 0, elevation 0 sits on +Z at the radius.
    expect(snapshot?.position.x).toBeCloseTo(0);
    expect(snapshot?.position.y).toBeCloseTo(0);
    expect(snapshot?.position.z).toBeCloseTo(5);
    // Default body aim looks back at the target (-Z).
    const look = lookDir(snapshot!);
    expect(look.x).toBeCloseTo(0);
    expect(look.z).toBeCloseTo(-1);
  });

  it("swings azimuth around +Y", () => {
    const snapshot = resolveVirtualCameraDefinition({
      id: "orbit-az",
      body: { type: "orbit", target: { x: 0, y: 0, z: 0 }, azimuthDeg: 90, elevationDeg: 0, radius: 5 }
    });
    expect(snapshot?.position.x).toBeCloseTo(5);
    expect(snapshot?.position.z).toBeCloseTo(0);
  });

  it("auto-orbits purely from the resolve clock (deterministic)", () => {
    const def: VirtualCameraDefinition = {
      id: "orbit-auto",
      body: {
        type: "orbit",
        target: { x: 0, y: 0, z: 0 },
        azimuthDeg: 0,
        elevationDeg: 0,
        radius: 5,
        autoOrbitDegPerSec: 90
      }
    };
    const at0 = resolveVirtualCameraDefinition(def, { elapsedSeconds: 0 });
    const at1 = resolveVirtualCameraDefinition(def, { elapsedSeconds: 1 });
    const at1again = resolveVirtualCameraDefinition(def, { elapsedSeconds: 1 });
    // 1s * 90deg/s = azimuth 90 -> from +Z to +X.
    expect(at0?.position.z).toBeCloseTo(5);
    expect(at1?.position.x).toBeCloseTo(5);
    expect(at1?.position.z).toBeCloseTo(0);
    // Same clock -> identical pose (scrub-safe).
    expect(at1again?.position).toEqual(at1?.position);
  });

  it("clamps elevation off the poles (±80)", () => {
    const snapshot = resolveVirtualCameraDefinition({
      id: "orbit-el",
      body: { type: "orbit", target: { x: 0, y: 0, z: 0 }, azimuthDeg: 0, elevationDeg: 200, radius: 5 }
    });
    const expected = Math.sin((80 * Math.PI) / 180) * 5;
    expect(snapshot?.position.y).toBeCloseTo(expected);
  });

  it("follows the target's yaw (lockYaw): the orbit stays on the same side as it turns", () => {
    const yaw90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "orbit-lockyaw",
        body: {
          type: "orbit",
          target: { targetId: "t" },
          azimuthDeg: 0,
          elevationDeg: 0,
          radius: 5,
          binding: "lockYaw"
        }
      },
      {
        getTargetPosition: () => ({ x: 0, y: 0, z: 0 }),
        getTargetOrientation: () => ({ x: yaw90.x, y: yaw90.y, z: yaw90.z, w: yaw90.w })
      }
    );
    // The +Z offset rotates with the 90° yaw to +X.
    expect(snapshot?.position.x).toBeCloseTo(5);
    expect(snapshot?.position.z).toBeCloseTo(0);
  });

  it("lockYaw strips target pitch (level horizon): the offset stays horizontal", () => {
    const pitched = new Quaternion().multiplyQuaternions(
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3),
      new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 4)
    );
    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "orbit-lockyaw-pitch",
        body: {
          type: "orbit",
          target: { targetId: "t" },
          azimuthDeg: 0,
          elevationDeg: 0,
          radius: 5,
          binding: "lockYaw"
        }
      },
      {
        getTargetPosition: () => ({ x: 0, y: 0, z: 0 }),
        getTargetOrientation: () => ({ x: pitched.x, y: pitched.y, z: pitched.z, w: pitched.w })
      }
    );
    // Yaw-only frame keeps a horizontal-plane offset despite the target's pitch.
    expect(snapshot?.position.y).toBeCloseTo(0);
  });

  it("inherits full target orientation (lock): the up rolls with the target", () => {
    const roll90 = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2);
    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "orbit-lock",
        body: {
          type: "orbit",
          target: { targetId: "t" },
          azimuthDeg: 0,
          elevationDeg: 0,
          radius: 5,
          binding: "lock"
        }
      },
      {
        getTargetPosition: () => ({ x: 0, y: 0, z: 0 }),
        getTargetOrientation: () => ({ x: roll90.x, y: roll90.y, z: roll90.z, w: roll90.w })
      }
    );
    // Roll about the view axis leaves +Z offset unchanged but tilts the camera up.
    expect(snapshot?.position.z).toBeCloseTo(5);
    const up = new Vector3(0, 1, 0).applyQuaternion(
      new Quaternion(
        snapshot!.quaternion.x,
        snapshot!.quaternion.y,
        snapshot!.quaternion.z,
        snapshot!.quaternion.w
      )
    );
    // World-up would give +Y; a rolled frame does not.
    expect(up.y).toBeLessThan(0.99);
  });

  it("falls back to world binding when the target has no orientation", () => {
    const yaw90 = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const withOrientation = resolveVirtualCameraDefinition(
      {
        id: "orbit-fb",
        body: {
          type: "orbit",
          target: { targetId: "t" },
          azimuthDeg: 0,
          elevationDeg: 0,
          radius: 5,
          binding: "lockYaw"
        }
      },
      {
        getTargetPosition: () => ({ x: 0, y: 0, z: 0 }),
        getTargetOrientation: () => null // no orientation registered
      }
    );
    // No orientation -> behaves like world binding (offset unrotated on +Z).
    expect(withOrientation?.position.x).toBeCloseTo(0);
    expect(withOrientation?.position.z).toBeCloseTo(5);
    void yaw90;
  });

  it("keeps body position independent of a track aim on a different target", () => {
    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "orbit-aim",
        body: { type: "orbit", target: { x: 0, y: 0, z: 0 }, azimuthDeg: 0, elevationDeg: 0, radius: 5 },
        aim: { type: "track", target: { targetId: "aimee" } }
      },
      { getTargetPosition: (id) => (id === "aimee" ? { x: 10, y: 0, z: 5 } : null) }
    );
    // Body still orbits the origin at +Z...
    expect(snapshot?.position.z).toBeCloseTo(5);
    // ...but the aim orients toward the (different) tracked target.
    const look = lookDir(snapshot!);
    const expected = new Vector3(10, 0, 5 - 5).normalize();
    expect(look.x).toBeCloseTo(expected.x);
    expect(look.y).toBeCloseTo(expected.y);
    expect(look.z).toBeCloseTo(expected.z);
  });

  it("returns null when the orbit target id cannot resolve", () => {
    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "orbit-missing",
        body: { type: "orbit", target: { targetId: "nope" }, azimuthDeg: 0, elevationDeg: 0, radius: 5 }
      },
      { getTargetPosition: () => null }
    );
    expect(snapshot).toBeNull();
  });
});

describe("orbit placement helpers", () => {
  it("orbitOffset round-trips through orbitParamsFromLocalOffset", () => {
    for (const [az, el, r] of [
      [0, 0, 5],
      [37, 20, 3],
      [-120, -15, 8],
      [175, 45, 2]
    ] as const) {
      const offset = orbitOffset(az, el, r);
      const back = orbitParamsFromLocalOffset(offset);
      expect(back.azimuthDeg).toBeCloseTo(az);
      expect(back.elevationDeg).toBeCloseTo(el);
      expect(back.radius).toBeCloseTo(r);
    }
  });

  it("orbitParamsFromLocalOffset clamps elevation off the poles", () => {
    // A near-vertical offset recovers a clamped 80°, not 90°.
    const back = orbitParamsFromLocalOffset({ x: 0, y: 5, z: 0.0001 });
    expect(back.elevationDeg).toBeCloseTo(80);
  });

  it("orbitParamsFromLocalOffset is safe at the origin", () => {
    expect(orbitParamsFromLocalOffset({ x: 0, y: 0, z: 0 })).toEqual({
      azimuthDeg: 0,
      elevationDeg: 0,
      radius: 0
    });
  });

  it("buildOrbitRingPoints is a closed ring at the elevation height", () => {
    const points = buildOrbitRingPoints(5, 0, 32);
    expect(points.length).toBe(33); // n+1, closed
    const last = points[points.length - 1];
    expect(last.x).toBeCloseTo(points[0].x);
    expect(last.y).toBeCloseTo(points[0].y);
    expect(last.z).toBeCloseTo(points[0].z);
    // Every point sits at radius 5 in the horizontal plane (elevation 0).
    for (const p of points) {
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(5);
      expect(p.y).toBeCloseTo(0);
    }
  });

  it("buildOrbitRingPoints lifts the ring and shrinks its radius with elevation", () => {
    const points = buildOrbitRingPoints(5, 30, 32);
    const y = Math.sin((30 * Math.PI) / 180) * 5;
    const ringR = Math.cos((30 * Math.PI) / 180) * 5;
    for (const p of points) {
      expect(p.y).toBeCloseTo(y);
      expect(Math.hypot(p.x, p.z)).toBeCloseTo(ringR);
    }
  });
});

describe("manual pivot-orbit override (OrbitControls model on any vcam)", () => {
  // Coded pose: camera at (0,0,5), identity quaternion (looks along -Z, i.e. at the
  // pivot at the origin). Decomposes to azimuth 0, elevation 0, radius 5.
  const coded = (): VirtualCameraSnapshot => ({
    position: { x: 0, y: 0, z: 5 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  });
  const PIVOT = { x: 0, y: 0, z: 0 };
  const lookDir = (s: VirtualCameraSnapshot) =>
    new Vector3(0, 0, -1).applyQuaternion(
      new Quaternion(s.quaternion.x, s.quaternion.y, s.quaternion.z, s.quaternion.w)
    );

  it("locked axes ignore input — exact passthrough", () => {
    const state = createRigBodyState();
    const c = coded();
    const r = stepCameraOverride(c, PIVOT, "v", { azimuth: { mode: "locked" } }, state, { azimuthDeltaDeg: 45 }, 0.016);
    expect(r.active).toBe(false);
    expect(r.snapshot).toBe(c); // returns the coded snapshot by reference
  });

  it("no control at all is an exact passthrough", () => {
    const state = createRigBodyState();
    const c = coded();
    const r = stepCameraOverride(c, PIVOT, "v", undefined, state, { azimuthDeltaDeg: 45, dollyDelta: 3 }, 0.016);
    expect(r.active).toBe(false);
    expect(r.snapshot).toBe(c);
  });

  it("LMB azimuth orbits around the pivot, staying aimed at it", () => {
    const state = createRigBodyState();
    const r = stepCameraOverride(coded(), PIVOT, "v", { azimuth: { mode: "free" } }, state, { azimuthDeltaDeg: 90 }, 0.016);
    expect(r.active).toBe(true);
    // +90° azimuth swings from +Z to +X.
    expect(r.snapshot.position.x).toBeCloseTo(5);
    expect(r.snapshot.position.z).toBeCloseTo(0, 5);
    // Still looking at the pivot (toward -X from +X).
    const look = lookDir(r.snapshot);
    expect(look.x).toBeCloseTo(-1);
  });

  it("free holds where left; recenter eases back to the coded pose", () => {
    const free = createRigBodyState();
    stepCameraOverride(coded(), PIVOT, "v", { azimuth: { mode: "free" } }, free, { azimuthDeltaDeg: 30 }, 0.016);
    for (let i = 0; i < 100; i += 1) stepCameraOverride(coded(), PIVOT, "v", { azimuth: { mode: "free" } }, free, {}, 0.05);
    expect(free.azimuthOffsetDeg).toBeCloseTo(30); // free never decays

    const rec = createRigBodyState();
    const ctrl = { azimuth: { mode: "recenter" as const, recenterWait: 0.5, recenterTime: 0.5 } };
    stepCameraOverride(coded(), PIVOT, "v", ctrl, rec, { azimuthDeltaDeg: 40 }, 0.016);
    stepCameraOverride(coded(), PIVOT, "v", ctrl, rec, {}, 0.4); // before wait: holds
    expect(rec.azimuthOffsetDeg).toBeCloseTo(40);
    for (let i = 0; i < 300; i += 1) stepCameraOverride(coded(), PIVOT, "v", ctrl, rec, {}, 0.05);
    expect(rec.azimuthOffsetDeg).toBeCloseTo(0, 2); // eased back to coded
  });

  it("recentering yields to live input (idle timer resets)", () => {
    const state = createRigBodyState();
    const ctrl = { azimuth: { mode: "recenter" as const, recenterWait: 0.2, recenterTime: 0.5 } };
    for (let i = 0; i < 30; i += 1) stepCameraOverride(coded(), PIVOT, "v", ctrl, state, { azimuthDeltaDeg: 5 }, 0.1);
    expect(state.azimuthOffsetDeg).toBeCloseTo(150);
    expect(state.idleAzimuth).toBe(0);
  });

  it("azimuth takes the shortest angular path (wraps to ±180)", () => {
    const state = createRigBodyState();
    stepCameraOverride(coded(), PIVOT, "v", { azimuth: { mode: "free" } }, state, { azimuthDeltaDeg: 350 }, 0.016);
    expect(state.azimuthOffsetDeg).toBeCloseTo(-10);
  });

  it("elevation is clamped off the poles", () => {
    const state = createRigBodyState();
    const r = stepCameraOverride(coded(), PIVOT, "v", { elevation: { mode: "free" } }, state, { elevationDeltaDeg: 200 }, 0.016);
    // Clamped to 80°: y = sin(80°)·5.
    expect(r.snapshot.position.y).toBeCloseTo(Math.sin((80 * Math.PI) / 180) * 5);
  });

  it("RMB pan moves the pivot and re-frames (aims at the panned point)", () => {
    const state = createRigBodyState();
    // Coded looks along -Z, so view-right is +X; pan +X by 2.
    const r = stepCameraOverride(coded(), PIVOT, "v", { pan: { mode: "free" } }, state, { panXDelta: 2 }, 0.016);
    expect(r.active).toBe(true);
    expect(r.snapshot.position.x).toBeCloseTo(2); // camera trucked +X
    expect(r.snapshot.position.z).toBeCloseTo(5);
    // Aims at the panned pivot (2,0,0): forward still -Z.
    const look = lookDir(r.snapshot);
    expect(look.z).toBeCloseTo(-1);
  });

  it("wheel dollies toward the pivot with damping + min/max clamp", () => {
    const state = createRigBodyState();
    const ctrl = { dolly: { mode: "free" as const }, minDistance: 2, maxDistance: 12 };
    // Pull out by +5 and let the damped ease settle.
    let r = stepCameraOverride(coded(), PIVOT, "v", ctrl, state, { dollyDelta: 5 }, 0.016);
    for (let i = 0; i < 300; i += 1) r = stepCameraOverride(coded(), PIVOT, "v", ctrl, state, {}, 0.05);
    expect(r.snapshot.position.z).toBeCloseTo(10); // 5 + 5, within max 12
    // Now zoom way in: clamps at minDistance 2.
    stepCameraOverride(coded(), PIVOT, "v", ctrl, state, { dollyDelta: -100 }, 0.016);
    for (let i = 0; i < 300; i += 1) r = stepCameraOverride(coded(), PIVOT, "v", ctrl, state, {}, 0.05);
    expect(r.snapshot.position.z).toBeCloseTo(2);
  });

  it("reseeds (zeroes offsets) when the driven vcam changes", () => {
    const state = createRigBodyState();
    stepCameraOverride(coded(), PIVOT, "a", { azimuth: { mode: "free" } }, state, { azimuthDeltaDeg: 30 }, 0.016);
    expect(state.azimuthOffsetDeg).toBeCloseTo(30);
    stepCameraOverride(coded(), PIVOT, "b", { azimuth: { mode: "free" } }, state, {}, 0.016);
    expect(state.azimuthOffsetDeg).toBe(0);
    expect(state.vcamId).toBe("b");
  });

  it("resolveCameraPivot: aim target > orbit target > synthesized point in front", () => {
    const resolve = (id: string) => (id === "t" ? { x: 1, y: 2, z: 3 } : null);
    const trackDef: VirtualCameraDefinition = {
      id: "v",
      body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      aim: { type: "track", target: { targetId: "t" } }
    };
    expect(resolveCameraPivot(trackDef, coded(), resolve)).toEqual({ x: 1, y: 2, z: 3 });

    const orbitDef: VirtualCameraDefinition = {
      id: "v",
      body: { type: "orbit", target: { x: 4, y: 0, z: 0 }, azimuthDeg: 0, elevationDeg: 0, radius: 5 }
    };
    expect(resolveCameraPivot(orbitDef, coded(), () => null)).toEqual({ x: 4, y: 0, z: 0 });

    const staticDef: VirtualCameraDefinition = {
      id: "v",
      body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
    };
    // Coded looks -Z from (0,0,5); synthesized pivot is 10 in front → (0,0,-5).
    const p = resolveCameraPivot(staticDef, coded(), () => null);
    expect(p.z).toBeCloseTo(-5);
  });

  it("orbits any vcam around a synthesized pivot (static, no target)", () => {
    const state = createRigBodyState();
    const staticDef: VirtualCameraDefinition = {
      id: "s",
      body: { type: "static", position: { x: 0, y: 0, z: 5 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
    };
    const pivot = resolveCameraPivot(staticDef, coded(), () => null); // (0,0,-5)
    const r = stepCameraOverride(coded(), pivot, "s", { azimuth: { mode: "free" } }, state, { azimuthDeltaDeg: 90 }, 0.016);
    expect(r.active).toBe(true);
    // radius to synth pivot is 10; +90° azimuth swings to +X of the pivot.
    expect(r.snapshot.position.x).toBeCloseTo(10);
    expect(r.snapshot.position.z).toBeCloseTo(-5);
  });

  it("preserves authored roll — the override does not flatten the horizon", () => {
    // Coded pose with 30° roll about the view axis. Pan makes the override active
    // with no orbit rotation (delta = identity), so the recomposed orientation must
    // be the coded (rolled) quaternion — a world-up look-at would level it.
    const roll = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (30 * Math.PI) / 180);
    const rolled: VirtualCameraSnapshot = {
      position: { x: 0, y: 0, z: 5 },
      quaternion: { x: roll.x, y: roll.y, z: roll.z, w: roll.w }
    };
    const state = createRigBodyState();
    const r = stepCameraOverride(rolled, PIVOT, "v", { pan: { mode: "free" } }, state, { panXDelta: 1 }, 0.016);
    expect(r.active).toBe(true);
    expect(r.snapshot.quaternion.z).toBeCloseTo(roll.z);
    expect(r.snapshot.quaternion.w).toBeCloseTo(roll.w);
  });

  it("a steep (overhead) shot holds its pose when the override engages — no ±80 pop", () => {
    // Camera 10 directly above the pivot (elevation 90°, past the ±80 orbit limit).
    // Azimuth (yaw about world-up) leaves an overhead offset unmoved; the old
    // spherical recompose clamped elevation to 80 and dropped the camera to y≈9.85.
    const overhead: VirtualCameraSnapshot = {
      position: { x: 0, y: 10, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    };
    const state = createRigBodyState();
    const r = stepCameraOverride(overhead, PIVOT, "v", { azimuth: { mode: "free" } }, state, { azimuthDeltaDeg: 45 }, 0.016);
    expect(r.active).toBe(true);
    expect(r.snapshot.position.y).toBeCloseTo(10);
    expect(Math.hypot(r.snapshot.position.x, r.snapshot.position.z)).toBeCloseTo(0, 5);
  });

  it("elevation clamps ±80 off horizontal relative to a nonzero coded elevation", () => {
    // Coded pose at elevation 45° (radius 5). Pushing elevation past the limit clamps
    // the RESULT to 80° — the windup bound is relative to the coded 45°, not to zero,
    // so this exercises the el0≠0 branch (position stays on the radius-5 sphere).
    const el45: VirtualCameraSnapshot = {
      position: { x: 0, y: 5 * Math.sin(Math.PI / 4), z: 5 * Math.cos(Math.PI / 4) },
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    };
    const state = createRigBodyState();
    const r = stepCameraOverride(el45, PIVOT, "v", { elevation: { mode: "free" } }, state, { elevationDeltaDeg: 200 }, 0.016);
    expect(r.snapshot.position.y).toBeCloseTo(5 * Math.sin((80 * Math.PI) / 180));
    expect(Math.hypot(r.snapshot.position.x, r.snapshot.position.y, r.snapshot.position.z)).toBeCloseTo(5);
  });

  it("an out-of-range coded radius does not jump when the override engages", () => {
    // Coded 50 units out; control caps distance at 40. Azimuth only (dolly 0) must
    // not clamp the radius inward — the reachable band widens to include the coded r0.
    const state = createRigBodyState();
    const far: VirtualCameraSnapshot = { position: { x: 0, y: 0, z: 50 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } };
    const ctrl = { azimuth: { mode: "free" as const }, minDistance: 1, maxDistance: 40 };
    const r = stepCameraOverride(far, PIVOT, "v", ctrl, state, { azimuthDeltaDeg: 30 }, 0.016);
    expect(Math.hypot(r.snapshot.position.x, r.snapshot.position.z)).toBeCloseTo(50);
  });

  it("dolly reverses immediately at a distance limit (no wind-up dead zone)", () => {
    const state = createRigBodyState();
    const ctrl = { dolly: { mode: "free" as const }, minDistance: 2, maxDistance: 12 };
    // Over-scroll inward far past minDistance, then settle at the clamp (radius 2).
    stepCameraOverride(coded(), PIVOT, "v", ctrl, state, { dollyDelta: -100 }, 0.016);
    let z = 5;
    for (let i = 0; i < 300; i += 1) z = stepCameraOverride(coded(), PIVOT, "v", ctrl, state, {}, 0.05).snapshot.position.z;
    expect(z).toBeCloseTo(2);
    // A single outward notch moves the radius out right away (the target was bounded,
    // not wound up to -100), rather than sitting in a dead zone.
    const after = stepCameraOverride(coded(), PIVOT, "v", ctrl, state, { dollyDelta: 5 }, 0.05).snapshot.position.z;
    expect(after).toBeGreaterThan(z);
  });
});

describe("override input accumulator", () => {
  it("maps LMB/RMB/wheel gestures to override input with the twin's signs", () => {
    const acc = createOverrideInputAccumulator();
    acc.orbit(10, -5); // drag right + up
    acc.pan(4, 2);
    acc.dolly(200);
    const input = acc.drain()!;
    expect(input.azimuthDeltaDeg).toBeCloseTo(10 * 0.4);
    expect(input.elevationDeltaDeg).toBeCloseTo(5 * 0.4); // up (−dy) raises elevation
    expect(input.panXDelta).toBeCloseTo(-4 * 0.02);
    expect(input.panYDelta).toBeCloseTo(2 * 0.02);
    expect(input.dollyDelta).toBeCloseTo(200 * 0.01);
  });

  it("drain clears; returns null when nothing pending", () => {
    const acc = createOverrideInputAccumulator({ orbitDegPerPixel: 1 });
    acc.orbit(3, 0);
    expect(acc.drain()?.azimuthDeltaDeg).toBeCloseTo(3);
    expect(acc.drain()).toBeNull(); // cleared
  });
});

describe("rig-matrix camera placement (P1.2: follow through a transformed parent)", () => {
  const rotSnap = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 5);
  const snap: VirtualCameraSnapshot = {
    name: "s",
    position: { x: 1, y: 2, z: 3 },
    quaternion: { x: rotSnap.x, y: rotSnap.y, z: rotSnap.z, w: rotSnap.w }
  };

  it("identity rigMatrix matches the world-root path (backward compatible)", () => {
    const a = new PerspectiveCamera();
    applyVirtualCameraSnapshot(a, snap);
    const b = new PerspectiveCamera();
    applyVirtualCameraSnapshot(b, snap, new Matrix4());
    expect(b.position.distanceTo(a.position)).toBeCloseTo(0, 6);
    expect(b.quaternion.angleTo(a.quaternion)).toBeCloseTo(0, 6);
  });

  it("places a rig-space snapshot into world through a rotated + translated parent", () => {
    const rig = new Matrix4().compose(
      new Vector3(100, 0, 0),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2),
      new Vector3(1, 1, 1)
    );
    const s: VirtualCameraSnapshot = {
      name: "o",
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    };
    const cam = new PerspectiveCamera();
    applyVirtualCameraSnapshot(cam, s, rig);
    cam.updateMatrixWorld(true);
    expect(cam.getWorldPosition(new Vector3()).distanceTo(new Vector3(100, 0, 0))).toBeCloseTo(0, 5);
    const forward = cam.getWorldDirection(new Vector3());
    const expected = new Vector3(0, 0, -1).transformDirection(rig);
    expect(forward.angleTo(expected)).toBeCloseTo(0, 5);
  });

  it("composer keeps the horizon level and returns a world-space target under a rolled parent", () => {
    // Rig rolled 40deg about Z + translated: its up is tilted vs world Y.
    const rig = new Matrix4().compose(
      new Vector3(5, 0, 0),
      new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), (40 * Math.PI) / 180),
      new Vector3(1, 1, 1)
    );
    const def: VirtualCameraDefinition = {
      id: "v",
      body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      aim: {
        type: "track",
        target: { x: 2, y: 1.5, z: -5 },
        settings: composer({ dampingX: 0, dampingY: 0, centerOnActivate: true })
      }
    };
    const cam = new PerspectiveCamera(50, 16 / 9, 0.1, 100);
    applyVirtualCameraSnapshot(
      cam,
      { name: "b", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      rig
    );
    const state = createRigComposerState();
    const worldTarget = stepComposerAim(cam, def, state, () => null, 1 / 60, undefined, rig);
    cam.updateMatrixWorld(true);

    // Returned target is the rig-space target expressed in world (for overlays).
    const expectedTarget = new Vector3(2, 1.5, -5).applyMatrix4(rig);
    expect(worldTarget).not.toBeNull();
    expect(
      new Vector3(worldTarget!.x, worldTarget!.y, worldTarget!.z).distanceTo(expectedTarget)
    ).toBeCloseTo(0, 5);

    // Level horizon: the camera's screen-right is horizontal w.r.t. the rig's up
    // (no roll). Contrast: without rigMatrix the composer levels to world Y instead.
    const expectedUp = new Vector3(0, 1, 0).transformDirection(rig);
    const right = new Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    expect(right.dot(expectedUp)).toBeCloseTo(0, 4);
    expect(Math.abs(right.dot(new Vector3(0, 1, 0)))).toBeGreaterThan(0.3);
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

describe("driveVirtualCameraBrain", () => {
  it("re-resolves the definition each frame so blends chase moving bodies", () => {
    const path = new VertexPath(
      [
        { x: 0, y: 0, z: 0 },
        { x: 100, y: 0, z: 0 }
      ],
      [0, 100]
    );
    const cart = createPathCart({ distance: 0 });
    const definition = {
      id: "rail-cam",
      body: { type: "cart" as const, cartId: "dolly" }
    };
    const context = {
      getCartFrame: (id: string) => (id === "dolly" ? sampleCartFrame(path, cart) : null)
    };

    const brain = createVirtualCameraBrainState({
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    });
    activateVirtualCameraBrain(brain, resolveVirtualCameraDefinition(definition, context)!, {
      durationSeconds: 2,
      curve: "linear"
    });

    const camera = new PerspectiveCamera();
    cart.distance = 10;
    driveVirtualCameraBrain(camera, brain, definition, context, 1);
    // Halfway through the blend toward the cart now at x=10.
    expect(camera.position.x).toBeCloseTo(5);

    cart.distance = 20;
    driveVirtualCameraBrain(camera, brain, definition, context, 1);
    expect(camera.position.x).toBeCloseTo(20);
    expect(brain.isBlending).toBe(false);
  });
});

describe("virtual camera brain snap", () => {
  it("setVirtualCameraBrainLive parks a pose with no blend", () => {
    const brain = createVirtualCameraBrainState({
      position: { x: 0, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    });
    activateVirtualCameraBrain(
      brain,
      { position: { x: 10, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
      { durationSeconds: 2, curve: "linear" }
    );
    expect(brain.isBlending).toBe(true);

    setVirtualCameraBrainLive(brain, {
      position: { x: 7, y: 0, z: 0 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    });

    expect(brain.isBlending).toBe(false);
    expect(brain.previous).toBeUndefined();
    expect(getVirtualCameraBrainProgress(brain)).toBe(1);
    expect(brain.live?.position.x).toBeCloseTo(7);

    // A subsequent update holds the snapped pose (no residual animation).
    const camera = new PerspectiveCamera();
    applyVirtualCameraBrain(camera, brain, 1 / 60);
    expect(camera.position.x).toBeCloseTo(7);
  });
});

describe("screen composer aim", () => {
  it("preserves rotation while target is inside the dead zone", () => {
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
    const initial = camera.quaternion.clone();
    const target = targetAtScreen(camera, { x: 0.04, y: 0.03 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      composer({ deadWidth: 0.2, deadHeight: 0.2, dampingX: 0, dampingY: 0 }),
      1 / 60
    );

    expect(camera.quaternion.angleTo(initial)).toBeCloseTo(0, 6);
  });

  it("corrects to the nearest dead-zone edge instead of center", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.3, y: 0 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      composer({ deadWidth: 0.2, deadHeight: 0.2, dampingX: 0, dampingY: 0 }),
      1 / 60
    );

    expect(screenPosition(camera, target).x).toBeCloseTo(0.1, 5);
  });

  it("respects non-center screen position", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.32, y: -0.12 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      composer({
        screenX: 0.2,
        screenY: -0.1,
        deadWidth: 0.1,
        deadHeight: 0.1,
        dampingX: 0,
        dampingY: 0
      }),
      1 / 60
    );

    const screen = screenPosition(camera, target);
    expect(screen.x).toBeCloseTo(0.25, 5);
    expect(Math.abs(screen.y - -0.1)).toBeLessThanOrEqual(0.05);
  });

  it("can center on activation", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.3, y: -0.2 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      composer({
        screenX: 0.1,
        screenY: -0.1,
        deadWidth: 0.2,
        deadHeight: 0.2,
        dampingX: 1,
        dampingY: 1,
        centerOnActivate: true
      }),
      1 / 60
    );

    const screen = screenPosition(camera, target);
    expect(screen.x).toBeCloseTo(0.1, 2);
    expect(screen.y).toBeCloseTo(-0.1, 2);
  });

  it("clamps soft-zone breaches immediately", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.7, y: 0 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      composer({
        deadWidth: 0.2,
        deadHeight: 0.2,
        softWidth: 0.8,
        softHeight: 0.8,
        dampingX: 0.000001,
        dampingY: 0.000001
      }),
      1 / 60
    );

    expect(screenPosition(camera, target).x).toBeLessThanOrEqual(0.400001);
  });

  it("applies horizontal and vertical damping independently", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const target = targetAtScreen(camera, { x: 0.3, y: 0.3 });

    applyScreenComposerAim(
      camera,
      target,
      { x: 0, y: 1, z: 0 },
      createScreenComposerState(),
      // Damping is heaviness (bigger = slower). The lighter x axis corrects more.
      composer({ deadWidth: 0.2, deadHeight: 0.2, dampingX: 1, dampingY: 12 }),
      1 / 30
    );

    const screen = screenPosition(camera, target);
    expect(Math.abs(screen.x - 0.1)).toBeLessThan(Math.abs(screen.y - 0.1));
  });

  it("damping is based on delta seconds", () => {
    const target = targetAtScreen(new PerspectiveCamera(60, 1, 0.1, 100), { x: 0.28, y: 0 });
    const oneStep = new PerspectiveCamera(60, 1, 0.1, 100);
    const manySteps = new PerspectiveCamera(60, 1, 0.1, 100);
    const oneStepState = createScreenComposerState();
    const manyStepsState = createScreenComposerState();
    const settings = composer({ deadWidth: 0.2, deadHeight: 0.2, dampingX: 4, dampingY: 4 });

    applyScreenComposerAim(oneStep, target, { x: 0, y: 1, z: 0 }, oneStepState, settings, 1);
    for (let i = 0; i < 60; i += 1) {
      applyScreenComposerAim(manySteps, target, { x: 0, y: 1, z: 0 }, manyStepsState, settings, 1 / 60);
    }

    expect(screenPosition(manySteps, target).x).toBeCloseTo(screenPosition(oneStep, target).x, 2);
  });

  it("lookahead initializes and resets cleanly on teleports", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const state = createScreenComposerState();
    const settings = composer({
      lookaheadTime: 0.5,
      lookaheadSmoothing: 8,
      dampingX: 0,
      dampingY: 0
    });

    applyScreenComposerAim(camera, { x: 0, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, state, settings, 1 / 60);
    expect(vec3Length(state.smoothedVelocity)).toBeCloseTo(0, 6);

    applyScreenComposerAim(camera, { x: 100, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, state, settings, 1 / 60);
    expect(vec3Length(state.smoothedVelocity)).toBeCloseTo(0, 6);
  });

  it("lookahead smoothing increases prediction lag", () => {
    const fastState = createScreenComposerState();
    const slowState = createScreenComposerState();
    const fastCamera = new PerspectiveCamera(60, 1, 0.1, 100);
    const slowCamera = new PerspectiveCamera(60, 1, 0.1, 100);
    const fast = composer({ lookaheadTime: 0.25, dampingX: 0, dampingY: 0, lookaheadSmoothing: 1 });
    const slow = composer({ lookaheadTime: 0.25, dampingX: 0, dampingY: 0, lookaheadSmoothing: 12 });

    applyScreenComposerAim(fastCamera, { x: 0, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, fastState, fast, 1 / 60);
    applyScreenComposerAim(slowCamera, { x: 0, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, slowState, slow, 1 / 60);

    applyScreenComposerAim(fastCamera, { x: 1, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, fastState, fast, 1 / 60);
    applyScreenComposerAim(slowCamera, { x: 1, y: 0, z: -10 }, { x: 0, y: 1, z: 0 }, slowState, slow, 1 / 60);

    expect(Math.abs(slowState.smoothedVelocity?.x ?? 0)).toBeLessThan(
      Math.abs(fastState.smoothedVelocity?.x ?? 0)
    );
  });
});

describe("composer stage", () => {
  const trackedDef = (id: string): VirtualCameraDefinition => ({
    id,
    body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } },
    aim: {
      type: "track",
      target: { targetId: "t" },
      settings: composer({ dampingX: 0, dampingY: 0 })
    }
  });

  it("frames the resolved target and adopts the vcam id", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const state = createRigComposerState();
    const target = targetAtScreen(camera, { x: 0.3, y: 0 });

    const out = stepComposerAim(camera, trackedDef("cam"), state, (id) => (id === "t" ? target : null), 1 / 60);

    expect(out).toEqual(target);
    expect(state.vcamId).toBe("cam");
    // Undamped: reframed to the dead-zone edge, well short of the raw 0.3.
    expect(screenPosition(camera, target).x).toBeLessThan(0.2);
  });

  it("skips vcams without a damped-composer aim and clears its id", () => {
    const camera = new PerspectiveCamera();
    const state = createRigComposerState();
    state.vcamId = "stale";
    const plain: VirtualCameraDefinition = {
      id: "x",
      body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
    };

    expect(stepComposerAim(camera, plain, state, () => null, 1 / 60)).toBeNull();
    expect(state.vcamId).toBeNull();
  });

  it("reseeds the composed orientation when the vcam changes", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100);
    const state = createRigComposerState();
    const target = targetAtScreen(camera, { x: 0.3, y: 0 });
    const resolve = (id: string) => (id === "t" ? target : null);

    stepComposerAim(camera, trackedDef("a"), state, resolve, 1 / 60);
    const afterA = camera.quaternion.clone();

    // Switching vcam reseeds from the current pose, so a fresh (identity body)
    // frame re-derives rather than continuing to damp from A's composed pose.
    camera.quaternion.set(0, 0, 0, 1);
    stepComposerAim(camera, trackedDef("b"), state, resolve, 1 / 60);
    expect(state.vcamId).toBe("b");
    expect(camera.quaternion.angleTo(afterA)).toBeCloseTo(0, 6);
  });
});

describe("driveActivation", () => {
  const vcamA: VirtualCameraDefinition = {
    id: "a",
    body: { type: "static", position: { x: 0, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
  };
  const vcamB: VirtualCameraDefinition = {
    id: "b",
    body: { type: "static", position: { x: 10, y: 0, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
  };
  const vcams = new Map<string, VirtualCameraDefinition>([
    ["a", vcamA],
    ["b", vcamB]
  ]);

  it("cuts to a shot then blends from the live pose to the next", () => {
    const state = createRigDriveState();
    const camera = new PerspectiveCamera();

    driveActivation(state, { camera, activeVcamId: "a", vcams, context: {} }, 0);
    expect(camera.position.x).toBeCloseTo(0);

    const blend = { durationSeconds: 2, curve: "linear" as const };
    driveActivation(state, { camera, activeVcamId: "b", vcams, context: {}, blend }, 1);
    expect(camera.position.x).toBeCloseTo(5);
    driveActivation(state, { camera, activeVcamId: "b", vcams, context: {}, blend }, 1);
    expect(camera.position.x).toBeCloseTo(10);
    expect(state.brain.isBlending).toBe(false);
  });

  it("re-activates the same id when the key bumps", () => {
    const state = createRigDriveState();
    const camera = new PerspectiveCamera();

    driveActivation(state, { camera, activeVcamId: "a", vcams, context: {} }, 0);
    driveActivation(
      state,
      { camera, activeVcamId: "b", vcams, context: {}, blend: { durationSeconds: 2, curve: "linear" }, activationKey: 1 },
      1
    );
    expect(camera.position.x).toBeCloseTo(5);

    // Same id, new key, default cut -> snap to B instead of continuing the blend.
    driveActivation(state, { camera, activeVcamId: "b", vcams, context: {}, activationKey: 2 }, 0);
    expect(camera.position.x).toBeCloseTo(10);
    expect(state.brain.isBlending).toBe(false);
  });

  it("idles on a null id and holds the last live pose", () => {
    const state = createRigDriveState();
    const camera = new PerspectiveCamera();
    driveActivation(state, { camera, activeVcamId: "b", vcams, context: {} }, 0);

    const result = driveActivation(state, { camera, activeVcamId: null, vcams, context: {} }, 1);
    expect(result.activeVcamId).toBeNull();
    expect(result.cameraSnapshot?.position.x).toBeCloseTo(10);
    expect(state.activation.vcamId).toBeNull();
  });
});

describe("portable object track directors", () => {
  it("stops and restores an animation binding when its track is removed", () => {
    const object = new Group();
    const mixer = new AnimationMixer(object);
    const clip = new AnimationClip("Walk", 2, [new NumberKeyframeTrack(".position[x]", [0, 2], [0, 2])]);
    const action = mixer.clipAction(clip);
    let restored = 0;
    const registry = new ObjectBindingRegistry();
    registry.register("fox", object, {
      mixer,
      actions: new Map([["Walk", action]]),
      clips: ["Walk"],
      resetToRest: () => { restored += 1; }
    });
    const director = new AnimationTrackDirector();
    director.sync(registry, [{
      type: "animation",
      id: "track",
      objectId: "fox",
      clips: [{ id: "clip", clipName: "Walk", start: 0, end: 2 }]
    }], true, 1);
    expect(action.isRunning()).toBe(true);
    director.sync(registry, [], true, 1);
    expect(action.isRunning()).toBe(false);
    expect(restored).toBe(1);
  });

  it("wraps a looping clip's local time into [0, duration) (mixer.update(0) never wraps)", () => {
    const object = new Group();
    const mixer = new AnimationMixer(object);
    const clip = new AnimationClip("Run", 2, [new NumberKeyframeTrack(".position[x]", [0, 2], [0, 2])]);
    const action = mixer.clipAction(clip);
    const registry = new ObjectBindingRegistry();
    registry.register("fox", object, { mixer, actions: new Map([["Run", action]]), clips: ["Run"], resetToRest: () => {} });
    const director = new AnimationTrackDirector();
    // Window 0..8 is longer than the 2s clip, so at t=5 the native local time (5)
    // runs past the clip; a looping action must keep cycling, not clamp to the end.
    director.sync(registry, [{ type: "animation", id: "track", objectId: "fox", clips: [{ id: "clip", clipName: "Run", start: 0, end: 8 }] }], true, 5);
    expect(action.isRunning()).toBe(true);
    expect(action.time).toBeCloseTo(1, 6); // 5 % 2
  });

  it("restores a transform after timeline driving ends", () => {
    const object = new Group();
    object.position.set(4, 5, 6);
    const registry = new ObjectBindingRegistry();
    registry.register("prop", object);
    const director = new TransformTrackDirector();
    const tracks = [{
      type: "transform" as const,
      id: "track",
      objectId: "prop",
      position: [{ time: 0, value: [1, 2, 3] as [number, number, number] }]
    }];
    director.sync(registry, tracks, true, 0);
    expect(object.position.toArray()).toEqual([1, 2, 3]);
    director.sync(registry, tracks, false, 0);
    expect(object.position.toArray()).toEqual([4, 5, 6]);
  });

  it("applies activation post-playback state", () => {
    const object = new Group();
    object.visible = false;
    const registry = new ObjectBindingRegistry();
    registry.register("prop", object);
    const director = new ActivationTrackDirector();
    const tracks = [{
      type: "activation" as const,
      id: "track",
      objectId: "prop",
      clips: [{ id: "clip", start: 0, end: 2 }],
      postPlaybackState: "revert" as const
    }];
    director.sync(registry, tracks, true, 2, 1, true);
    expect(object.visible).toBe(true);
    director.sync(registry, tracks, false, 2, 1, false);
    expect(object.visible).toBe(false);
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

function vec3Length(v: Vec3 | undefined): number {
  if (!v) return Number.NaN;
  return Math.hypot(v.x, v.y, v.z);
}
