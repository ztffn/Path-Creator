// The from-view shot's round trip, end to end: a real three camera's pose, captured exactly as
// the scene driver captures it, authored as a shot node in Pascal's real store, read back
// through readTimeline's synthesised camera track, and applied by the director — must land the
// camera back on the SAME view. This is the seam the browser proof only half-covered (position
// at capture, never pose at playback), and where an euler-order or handedness slip would frame
// a different scene with no error anywhere. Also pins order-proofing: a controller that sets a
// non-XYZ rotation order must not change what gets captured.
import { beforeEach, describe, expect, it } from "vitest";
import { PerspectiveCamera, Quaternion, Vector3 } from "three";
import { useScene } from "@pascal-app/core";
import {
  buildShotNode,
  buildTimelineNode,
  captureViewportPose,
  createPluginNode,
  installPascalTimeOnScene,
  PascalCameraDirector,
  readShotDefinitions,
  readTimeline,
  registerPascalTimeKinds,
  type CameraControlsLike
} from "../src/index";

const CLOCK = "humatime_capture_clock";

/** An interesting pose: off every axis, so any order/sign slip shows up. */
function authorCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(42);
  camera.position.set(8, 5, 12);
  camera.lookAt(2, 1, -3);
  camera.updateMatrixWorld(true);
  return camera;
}

const forwardOf = (quaternion: Quaternion): Vector3 =>
  new Vector3(0, 0, -1).applyQuaternion(quaternion).normalize();

describe("capture -> author -> evaluate -> apply, one view end to end", () => {
  let camera: PerspectiveCamera;

  beforeEach(() => {
    registerPascalTimeKinds();
    useScene.getState().clearScene();
    useScene.temporal.getState().clear();
    installPascalTimeOnScene();
    createPluginNode(buildTimelineNode({ id: CLOCK, durationSeconds: 10 }));

    camera = authorCamera();
    createPluginNode(
      buildShotNode({
        id: "humatime_shot_capture",
        name: "From view",
        timelineId: CLOCK,
        timeSeconds: 2,
        body: "static",
        ...captureViewportPose(camera)
      })
    );
  });

  it("capture is order-proof: a controller's exotic rotation order changes nothing", () => {
    const reordered = authorCamera();
    reordered.rotation.reorder("YXZ"); // what a controls implementation is free to do
    const a = captureViewportPose(camera);
    const b = captureViewportPose(reordered);
    for (let i = 0; i < 3; i += 1) {
      expect(b.rotationDeg[i]).toBeCloseTo(a.rotationDeg[i], 6);
    }
  });

  it("with no controller, the director lands the camera back on the captured view exactly", () => {
    const timeline = readTimeline(CLOCK)!;
    const vcams = readShotDefinitions(CLOCK);
    const played = new PerspectiveCamera(50);

    const frame = new PascalCameraDirector().sync(played, { timeline, vcams, time: 3 });
    expect(frame).not.toBeNull();

    expect(played.position.x).toBeCloseTo(8, 5);
    expect(played.position.y).toBeCloseTo(5, 5);
    expect(played.position.z).toBeCloseTo(12, 5);
    // Same orientation up to quaternion double-cover.
    expect(Math.abs(played.quaternion.dot(camera.quaternion))).toBeCloseTo(1, 5);
    expect(played.fov).toBe(42);
  });

  it("with a controller, the fed look-at points down the captured view direction", () => {
    const timeline = readTimeline(CLOCK)!;
    const vcams = readShotDefinitions(CLOCK);
    const played = new PerspectiveCamera(50);
    const calls: number[][] = [];
    const controls: CameraControlsLike = {
      setLookAt: (...args: unknown[]) => calls.push(args.slice(0, 6) as number[]),
      update: () => undefined
    };

    new PascalCameraDirector().sync(played, { timeline, vcams, time: 3, controls });
    expect(calls).toHaveLength(1);
    const [px, py, pz, tx, ty, tz] = calls[0]!;
    expect([px, py, pz]).toEqual([8, 5, 12]);

    const fed = new Vector3(tx! - px!, ty! - py!, tz! - pz!).normalize();
    const authored = forwardOf(camera.quaternion);
    expect(fed.dot(authored)).toBeCloseTo(1, 5);
    // The lens is still the director's job on the controller path.
    expect(played.fov).toBe(42);
  });

  it("CONTROL: a deliberately different pose does NOT match — the comparison can fail", () => {
    const other = new PerspectiveCamera(42);
    other.position.set(8, 5, 12);
    other.lookAt(-4, 2, 6);
    other.updateMatrixWorld(true);
    expect(Math.abs(other.quaternion.dot(camera.quaternion))).toBeLessThan(0.99);
  });
});
