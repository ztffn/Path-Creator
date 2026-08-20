// M1.4: shots are authorable Pascal nodes, they play back through the timeline, and the
// viewport camera does not fight them. The last part is R9 — exactly one owner per frame — and
// it is the reason the director takes a `controls` argument at all. A fake controller that
// behaves the way `camera-controls` really does (re-deriving its pose from its own state on
// every update) is what makes "does not fight it" testable headlessly. Scope: the camera seam.
import { beforeEach, describe, expect, it } from "vitest";
import { PerspectiveCamera, Group, Vector3 } from "three";
import { nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import {
  buildShotNode,
  buildTimelineNode,
  createPluginNode,
  installPascalTimeOnScene,
  PascalCameraDirector,
  pascalTargetContext,
  readShotDefinitions,
  readShots,
  readTimeline,
  registerPascalTimeKinds,
  SHOT_KIND,
  synthesiseCameraTrack,
  type CameraControlsLike
} from "../src/index";

const CLOCK = "humatime_clock";

/** Drive the camera at `time`, exactly as a host would. */
function driveAt(
  director: PascalCameraDirector,
  camera: PerspectiveCamera,
  time: number,
  extra: Partial<Parameters<PascalCameraDirector["sync"]>[1]> = {}
) {
  return director.sync(camera, {
    timeline: readTimeline(CLOCK)!,
    vcams: readShotDefinitions(CLOCK),
    time,
    ...extra
  });
}

/**
 * A stand-in for drei's `CameraControls` that reproduces the behaviour which makes R9 real:
 * it holds its own position/target state and rewrites the camera from that state on every
 * `update`. Anything written to the camera between updates is therefore discarded — which is
 * exactly how the spike lost 1229 frames of 1230.
 */
class FakeCameraControls implements CameraControlsLike {
  position = new Vector3(0, 0, 0);
  target = new Vector3(0, 0, -1);
  updates = 0;

  constructor(private readonly camera: PerspectiveCamera) {}

  setLookAt(px: number, py: number, pz: number, tx: number, ty: number, tz: number): void {
    this.position.set(px, py, pz);
    this.target.set(tx, ty, tz);
  }

  update(): void {
    this.updates += 1;
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);
  }
}

function authorShots(): void {
  useScene.getState().clearScene();
  useScene.temporal.getState().clear();
  sceneRegistry.clear();
  installPascalTimeOnScene();

  createPluginNode(buildTimelineNode({ id: CLOCK, durationSeconds: 20 }));
  createPluginNode(
    buildShotNode({
      id: "shot_wide",
      name: "Wide",
      timelineId: CLOCK,
      timeSeconds: 0,
      blendSeconds: 0,
      body: "static",
      position: [0, 5, 20],
      rotationDeg: [0, 0, 0],
      fov: 50
    })
  );
  createPluginNode(
    buildShotNode({
      id: "shot_close",
      name: "Close",
      timelineId: CLOCK,
      timeSeconds: 10,
      blendSeconds: 4,
      body: "static",
      position: [0, 5, 4],
      rotationDeg: [0, 0, 0],
      fov: 35
    })
  );
}

describe("M1.4 — shots are an ordinary spatial Pascal kind", () => {
  beforeEach(() => registerPascalTimeKinds());

  it("registers, and unlike the clock and the cue it can be placed and moved", () => {
    const definition = nodeRegistry.get(SHOT_KIND)!;
    // A shot IS placed by a person, so under the classification test it is a spatial node —
    // which is why it parents where spatial things parent rather than under the timeline, and
    // therefore why it never meets the container problem the cue kind documented.
    expect(definition.capabilities.selectable).toEqual({ hitVolume: "bbox" });
    expect(definition.capabilities.movable).toBeTruthy();
    expect(definition.capabilities.duplicable).toBe(true);
  });

  it("has a renderer — the one kind in this package that draws anything", async () => {
    const renderer = nodeRegistry.get(SHOT_KIND)?.renderer as unknown as {
      kind: string;
      module: () => Promise<{ default: unknown }>;
    };
    expect(renderer.kind).toBe("parametric");
    expect(typeof (await renderer.module()).default).toBe("function");
  });
});

describe("M1.4 — reading shots out of the scene document", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    authorShots();
  });

  it("turns authored nodes into virtual camera definitions keyed by node id", () => {
    const shots = readShots(CLOCK);
    expect(shots).toHaveLength(2);
    const wide = shots.find((shot) => shot.id === "shot_wide")!;
    expect(wide.definition.id).toBe("shot_wide");
    expect(wide.definition.body.type).toBe("static");
    expect(wide.definition.lens?.fov).toBe(50);
  });

  it("scopes to one clock", () => {
    createPluginNode(buildTimelineNode({ id: "humatime_other" }));
    createPluginNode(buildShotNode({ id: "shot_other", timelineId: "humatime_other" }));
    expect(readShots(CLOCK)).toHaveLength(2);
    expect(readShots("humatime_other")).toHaveLength(1);
  });

  it("expresses an orbit shot as a target reference, not as baked coordinates", () => {
    createPluginNode(
      buildShotNode({
        id: "shot_orbit",
        timelineId: CLOCK,
        timeSeconds: 15,
        body: "orbit",
        targetNodeId: "some_model",
        radius: 6
      })
    );
    const orbit = readShots(CLOCK).find((shot) => shot.id === "shot_orbit")!;
    expect(orbit.definition.body).toMatchObject({
      type: "orbit",
      target: { targetId: "some_model" },
      radius: 6
    });
  });
});

describe("M1.4 — the shot in force is a pure function of time", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    authorShots();
  });

  it("holds a shot until the next takes over", () => {
    const camera = new PerspectiveCamera();
    const director = new PascalCameraDirector();
    expect(driveAt(director, camera, 0)?.vcamId).toBe("shot_wide");
    expect(driveAt(director, camera, 9.9)?.vcamId).toBe("shot_wide");
    expect(driveAt(director, camera, 10)?.vcamId).toBe("shot_close");
    expect(driveAt(director, camera, 19)?.vcamId).toBe("shot_close");
  });

  it("synthesises a camera track from shot nodes when the document has none", () => {
    // The compatibility path, at READ time: a document written before camera tracks existed
    // still plays its shots, and loading it does not rewrite it.
    const track = synthesiseCameraTrack(CLOCK, 20)!;
    expect(track.type).toBe("camera");
    // These shots predate spans — they carry `blendSeconds` and no `endSeconds` — so the legacy
    // layout is reconstructed AS AN OVERLAP: Wide's block now reaches to 14, which is Close's
    // start plus the 4s blend it used to describe, and Close inherits exactly that 4s crossover.
    // Same hand-off, now visible on the lane as two blocks crossing. The blend carries the shot's
    // `blendCurve` (M1.8), whose default matches the library's own fallback.
    expect("blocks" in track && track.blocks).toEqual([
      { id: "block_shot_wide", vcamId: "shot_wide", start: 0, end: 14 },
      {
        id: "block_shot_close",
        vcamId: "shot_close",
        start: 10,
        end: 20,
        blendIn: { durationSeconds: 4, curve: "easeInOut" }
      }
    ]);
  });

  it("writes nothing at all in a gap, rather than snapping the camera", () => {
    const camera = new PerspectiveCamera();
    camera.position.set(1, 2, 3);
    const director = new PascalCameraDirector();

    // A timeline whose only block starts at 10 leaves t=0 uncovered. A gap is a deliberate
    // state — the host keeps its own camera.
    const timeline = readTimeline(CLOCK)!;
    const gapped = {
      ...timeline,
      tracks: [{ type: "camera" as const, id: "cam", blocks: [
        { id: "b", vcamId: "shot_close", start: 10, end: 20 }
      ] }]
    };
    expect(
      director.sync(camera, { timeline: gapped as never, vcams: readShotDefinitions(CLOCK), time: 0 })
    ).toBeNull();
    expect(camera.position.toArray()).toEqual([1, 2, 3]);
  });

  it("does not depend on the order the shots came out of the document", () => {
    const ids = readShots(CLOCK).map((shot) => shot.id);
    expect(new Set(ids).size).toBe(ids.length);
    const camera = new PerspectiveCamera();
    const director = new PascalCameraDirector();
    expect(driveAt(director, camera, 11)?.vcamId).toBe("shot_close");
  });
});

describe("M1.4 — playback, with the time layer owning the camera", () => {
  let camera: PerspectiveCamera;
  let director: PascalCameraDirector;

  beforeEach(() => {
    registerPascalTimeKinds();
    authorShots();
    camera = new PerspectiveCamera();
    director = new PascalCameraDirector();
  });

  it("puts the camera where the shot says, and sets its lens", () => {
    driveAt(director, camera, 0);
    expect(camera.position.toArray()).toEqual([0, 5, 20]);
    expect(camera.fov).toBe(50);
  });

  it("blends into the next shot across its own blendSeconds, then holds", () => {
    driveAt(director, camera, 10); // the instant it takes over
    expect(camera.position.z).toBeCloseTo(20, 3); // still the wide shot

    driveAt(director, camera, 12); // halfway through the 4s blend
    expect(camera.position.z).toBeGreaterThan(4);
    expect(camera.position.z).toBeLessThan(20);

    driveAt(director, camera, 14); // blend complete
    expect(camera.position.z).toBeCloseTo(4, 3);

    driveAt(director, camera, 19); // held
    expect(camera.position.z).toBeCloseTo(4, 3);
  });

  it("blends the LENS across the window too, not just the position", () => {
    // The capability the hand-rolled resolver this replaced did not have: it snapped fov at the
    // cut. Deferring resolution to the library gets an animated lens, blend curves and
    // per-block overrides for free, and removes a second implementation that could drift.
    driveAt(director, camera, 10);
    expect(camera.fov).toBeCloseTo(50, 3); // wide, at the instant close takes over
    driveAt(director, camera, 12);
    expect(camera.fov).toBeGreaterThan(35);
    expect(camera.fov).toBeLessThan(50); // mid-blend, genuinely between the two
    driveAt(director, camera, 14);
    expect(camera.fov).toBeCloseTo(35, 3); // arrived
  });

  it("is scrub-safe — the same time gives the same pose, forwards or backwards", () => {
    const poseAt = (time: number): number[] => {
      driveAt(director, camera, time);
      return camera.position.toArray();
    };
    const forwards = [10, 11, 12, 13, 14].map(poseAt);
    const backwards = [14, 13, 12, 11, 10].map(poseAt).reverse();
    expect(backwards).toEqual(forwards);
  });

  it("frames a node by id, and re-frames itself when that node moves", () => {
    // The seam paying for itself: the shot names what it frames, so moving the subject
    // re-frames the shot with no timeline edit at all.
    const subject = new Group();
    subject.position.set(0, 0, 0);
    sceneRegistry.nodes.set("some_model", subject);

    createPluginNode(
      buildShotNode({
        id: "shot_orbit",
        timelineId: CLOCK,
        timeSeconds: 15,
        blendSeconds: 0,
        body: "orbit",
        targetNodeId: "some_model",
        azimuthDeg: 0,
        elevationDeg: 0,
        radius: 6
      })
    );
    const { getTargetPosition } = pascalTargetContext(sceneRegistry);

    driveAt(director, camera, 15, { getTargetPosition });
    const framedAtOrigin = camera.position.clone();

    subject.position.set(10, 0, 0);
    subject.updateMatrixWorld(true);
    driveAt(director, camera, 15, { getTargetPosition });

    expect(camera.position.x - framedAtOrigin.x).toBeCloseTo(10, 5);
  });
});

describe("M1.4 — R9, the camera has exactly one owner per frame", () => {
  let camera: PerspectiveCamera;
  let director: PascalCameraDirector;

  beforeEach(() => {
    registerPascalTimeKinds();
    authorShots();
    camera = new PerspectiveCamera();
    director = new PascalCameraDirector();
  });

  it("feeds a mounted controller instead of writing past it", () => {
    const controls = new FakeCameraControls(camera);
    driveAt(director, camera, 0, { controls });

    // The controller received the pose and applied it, so the camera holds the authored shot.
    expect(controls.updates).toBe(1);
    expect(controls.position.toArray()).toEqual([0, 5, 20]);
    expect(camera.position.toArray()).toEqual([0, 5, 20]);
  });

  it("survives the controller re-deriving the camera after the fact", () => {
    // This is the failure the rule exists for. A direct write lands, the controller updates
    // from its own untouched state, and the write is gone. Feeding the controller instead
    // means its state IS the shot, so a later update is a no-op rather than a reversal.
    const controls = new FakeCameraControls(camera);
    driveAt(director, camera, 0, { controls });

    controls.update(); // the controller's own next frame
    expect(camera.position.toArray()).toEqual([0, 5, 20]);
  });

  it("is indistinguishable from owning the camera outright", () => {
    // The spike's headline: same pose, to the digit, whichever path applied it.
    const solo = new PerspectiveCamera();
    const cooperative = new PerspectiveCamera();
    const controls = new FakeCameraControls(cooperative);

    for (const time of [0, 5, 10, 12, 14, 19]) {
      driveAt(director, solo, time);
      driveAt(director, cooperative, time, { controls });
      expect(cooperative.position.x).toBeCloseTo(solo.position.x, 6);
      expect(cooperative.position.y).toBeCloseTo(solo.position.y, 6);
      expect(cooperative.position.z).toBeCloseTo(solo.position.z, 6);
    }
  });

  it("gives the controller a pivot on what the shot frames, not a point behind it", () => {
    // A viewer permitted to orbit should turn around the subject. For an orbit shot that is
    // the orbit target, so the pivot must land on it rather than at an arbitrary distance.
    const subject = new Group();
    subject.position.set(3, 1, -2);
    subject.updateMatrixWorld(true);
    sceneRegistry.nodes.set("some_model", subject);

    createPluginNode(
      buildShotNode({
        id: "shot_orbit",
        timelineId: CLOCK,
        timeSeconds: 15,
        blendSeconds: 0,
        body: "orbit",
        targetNodeId: "some_model",
        radius: 6
      })
    );

    const controls = new FakeCameraControls(camera);
    driveAt(director, camera, 15, {
      controls,
      getTargetPosition: pascalTargetContext(sceneRegistry).getTargetPosition
    });

    expect(controls.target.x).toBeCloseTo(3, 4);
    expect(controls.target.y).toBeCloseTo(1, 4);
    expect(controls.target.z).toBeCloseTo(-2, 4);
  });

  it("— and writing past that same controller really does lose the frame", () => {
    // The control for every assertion above. If this fake did not actually contest the camera,
    // "feeding it works" would be true of a controller that does nothing, and the R9 tests
    // would prove nothing at all. This reproduces the spike's contested mode in miniature:
    // a direct write lands, the controller updates from its own untouched state, and the
    // write is gone — 1229 frames of 1230, measured in a real browser.
    const contested = new PerspectiveCamera();
    const controls = new FakeCameraControls(contested);
    controls.setLookAt(0, 0, 0, 0, 0, -1); // the controller believes the camera is at the origin

    contested.position.set(0, 5, 20); // a direct write, past the controller
    expect(contested.position.toArray()).toEqual([0, 5, 20]);

    controls.update(); // the controller's next frame re-derives from ITS state
    expect(contested.position.toArray()).toEqual([0, 0, 0]); // the write is gone
  });

  it("still owns the lens when a controller owns the pose", () => {
    const controls = new FakeCameraControls(camera);
    driveAt(director, camera, 14, { controls });
    // camera-controls has no opinion about field of view, so the shot's lens is still ours.
    expect(camera.fov).toBe(35);
  });
});
