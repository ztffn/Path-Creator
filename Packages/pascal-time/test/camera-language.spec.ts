// M1.8: the camera language the library already evaluates, now sayable from the plugin — blend
// curves, a FOV push, a tracked aim, the damped composer and seeded noise. Two claims here carry
// the phase: the persisted schema is proven WIDER than a preset name (the pre-M1.8 shape is kept
// as a control and shown to drop a hand-shaped curve outright), and the composer — the one stage
// that damps from the previous frame — is proven deterministic while the clock is not running.
import { beforeEach, describe, expect, it } from "vitest";
import { Object3D, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { z } from "zod";
import { sceneRegistry, useScene } from "@pascal-app/core";
import { DEFAULT_COMPOSER_SETTINGS } from "@huma/path-creator/core";
import {
  buildShotNode,
  buildTimelineNode,
  createPluginNode,
  installPascalTimeOnScene,
  migrateTrackPayload,
  PascalCameraDirector,
  readShotDefinitions,
  readShots,
  readTimeline,
  registerPascalTimeKinds,
  shotDefinition,
  synthesiseCameraTrack,
  type CameraFrame,
  type PersistedTrack
} from "../src/index";

const CLOCK = "humatime_clock";

/** A hand-shaped ease: an out tangent on the first anchor. Not expressible as a preset name. */
const CUSTOM_CURVE = {
  type: "curve" as const,
  keys: [{ x: 0, y: 0, out: { x: 0.7, y: 0.05 } }, { x: 1, y: 1 }]
};

function freshScene(): void {
  useScene.getState().clearScene();
  useScene.temporal.getState().clear();
  sceneRegistry.clear();
  installPascalTimeOnScene();
  createPluginNode(buildTimelineNode({ id: CLOCK, durationSeconds: 20 }));
}

beforeEach(() => {
  registerPascalTimeKinds();
  freshScene();
});

// ------------------------------------------------------------------ the persisted schema

describe("the persisted camera block carries everything the library evaluates", () => {
  const cameraTrack = (block: Record<string, unknown>): unknown => ({
    type: "camera",
    id: "camera_1",
    blocks: [{ id: "b1", vcamId: "shot_1", start: 0, end: 10, ...block }]
  });

  const blocksOf = (raw: unknown): Record<string, unknown>[] => {
    const { tracks } = migrateTrackPayload([raw], 1);
    const track = tracks[0] as Extract<PersistedTrack, { type: "camera" }> | undefined;
    return (track?.blocks ?? []) as unknown as Record<string, unknown>[];
  };

  it("a hand-shaped blend curve survives the round trip", () => {
    const blocks = blocksOf(cameraTrack({ blendIn: { durationSeconds: 2, curve: CUSTOM_CURVE } }));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.blendIn).toEqual({ durationSeconds: 2, curve: CUSTOM_CURVE });
  });

  it("CONTROL: the pre-M1.8 narrow shape drops that same track entirely", () => {
    // The assertion above only means something if a narrower schema really would have failed —
    // and the failure mode is the bad one: not "the curve is lost" but "the block does not parse",
    // so the migrator drops the whole track with no error anywhere.
    const narrowBlock = z.object({
      id: z.string(),
      vcamId: z.string(),
      start: z.number(),
      end: z.number(),
      blendIn: z
        .object({ durationSeconds: z.number().min(0), curve: z.string().optional() })
        .optional()
    });
    const parsed = narrowBlock.safeParse({
      id: "b1",
      vcamId: "shot_1",
      start: 0,
      end: 10,
      blendIn: { durationSeconds: 2, curve: CUSTOM_CURVE }
    });
    expect(parsed.success).toBe(false);
  });

  it("a lens animation survives on every lens field the library knows", () => {
    const lensAnimation = {
      fov: { from: 50, to: 24, easing: CUSTOM_CURVE },
      dutchDeg: { from: 0, to: 8 }
    };
    expect(blocksOf(cameraTrack({ lensAnimation }))[0]!.lensAnimation).toEqual(lensAnimation);
  });

  it("per-block overrides round-trip opaquely, including a nested aim", () => {
    const overrides = { aim: { type: "track", target: { targetId: "node_42" } } };
    expect(blocksOf(cameraTrack({ overrides }))[0]!.overrides).toEqual(overrides);
  });

  it("a malformed block is still dropped — wide is not the same as unchecked", () => {
    expect(blocksOf(cameraTrack({ blendIn: { durationSeconds: "soon" } }))).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ node -> definition

describe("a shot node says the camera language", () => {
  it("the flattened composer defaults match the library's own, field for field", () => {
    // The node carries ComposerSettings as flat fields (parametrics addresses a top-level key),
    // so nothing but this pins the two together. A drift would frame every composed shot
    // differently from the library's documented default and report nothing.
    const d = shotDefinition.defaults() as unknown as Record<string, number | boolean | number[]>;
    const offset = d.composerTargetOffset as number[];
    expect({
      screenX: d.composerScreenX,
      screenY: d.composerScreenY,
      deadWidth: d.composerDeadWidth,
      deadHeight: d.composerDeadHeight,
      softWidth: d.composerSoftWidth,
      softHeight: d.composerSoftHeight,
      dampingX: d.composerDampingX,
      dampingY: d.composerDampingY,
      targetOffsetX: offset[0],
      targetOffsetY: offset[1],
      targetOffsetZ: offset[2],
      lookaheadTime: d.composerLookaheadTime,
      lookaheadSmoothing: d.composerLookaheadSmoothing,
      lookaheadIgnoreY: d.composerLookaheadIgnoreY,
      centerOnActivate: d.composerCenterOnActivate
    }).toEqual(DEFAULT_COMPOSER_SETTINGS);
  });

  it("aimMode body keeps the body's orientation; track names the node it watches", () => {
    createPluginNode(buildShotNode({ id: "s_body", timelineId: CLOCK }));
    createPluginNode(
      buildShotNode({
        id: "s_track",
        timelineId: CLOCK,
        aimMode: "track",
        aimTargetNodeId: "node_7"
      })
    );
    const byId = new Map(readShots(CLOCK).map((shot) => [shot.id, shot]));
    expect(byId.get("s_body")!.definition.aim).toEqual({ type: "body" });
    expect(byId.get("s_track")!.definition.aim).toEqual({
      type: "track",
      target: { targetId: "node_7" }
    });
  });

  it("a track aim with no node named falls back to its literal point", () => {
    createPluginNode(
      buildShotNode({ id: "s", timelineId: CLOCK, aimMode: "track", aimTargetPoint: [1, 2, 3] })
    );
    expect(readShots(CLOCK)[0]!.definition.aim).toEqual({
      type: "track",
      target: { x: 1, y: 2, z: 3 }
    });
  });

  it("the composer toggle is exactly what promotes a look-at into a damped aim", () => {
    // The library distinguishes the two by the PRESENCE of `settings` and nothing else, so this
    // one boolean is the whole switch between a pure stage and a stateful one.
    createPluginNode(
      buildShotNode({ id: "s", timelineId: CLOCK, aimMode: "track", aimTargetNodeId: "n" })
    );
    const settings = (): unknown => (readShots(CLOCK)[0]!.definition.aim as { settings?: unknown }).settings;
    expect(settings()).toBeUndefined();
    useScene.getState().updateNode("s" as never, { composerEnabled: true } as never);
    expect(settings()).toEqual(DEFAULT_COMPOSER_SETTINGS);
  });

  it("noise is per-axis, and absent unless the shot asks for it", () => {
    createPluginNode(buildShotNode({ id: "s", timelineId: CLOCK }));
    expect(readShots(CLOCK)[0]!.definition.noise).toBeUndefined();
    useScene.getState().updateNode("s" as never, {
      noiseEnabled: true,
      noiseSeed: 9,
      noisePositionAmplitude: [0.1, 0.2, 0.3]
    } as never);
    const noise = readShots(CLOCK)[0]!.definition.noise!;
    expect(noise.seed).toBe(9);
    expect(noise.positionAmplitude).toEqual({ x: 0.1, y: 0.2, z: 0.3 });
  });
});

// ------------------------------------------------------------------ node -> block -> frame

describe("a shot's camera language reaches the synthesised block", () => {
  const blocksOfClock = (): Record<string, unknown>[] => {
    const track = synthesiseCameraTrack(CLOCK, 20)!;
    return ("blocks" in track ? track.blocks : []) as unknown as Record<string, unknown>[];
  };

  it("the blend curve becomes the block's blendIn.curve", () => {
    createPluginNode(
      buildShotNode({ id: "a", timelineId: CLOCK, timeSeconds: 0, blendSeconds: 0 })
    );
    createPluginNode(
      buildShotNode({
        id: "b",
        timelineId: CLOCK,
        timeSeconds: 5,
        blendSeconds: 2,
        blendCurve: CUSTOM_CURVE
      })
    );
    expect(blocksOfClock()[1]!.blendIn).toEqual({ durationSeconds: 2, curve: CUSTOM_CURVE });
  });

  it("a FOV push becomes a lensAnimation, and a flat push becomes nothing", () => {
    createPluginNode(
      buildShotNode({ id: "push", timelineId: CLOCK, fov: 50, animateFov: true, fovEnd: 24 })
    );
    expect(readShots(CLOCK)[0]!.lensAnimation).toEqual({
      fov: { from: 50, to: 24, easing: "easeInOut" }
    });

    // Equal endpoints emit nothing: the ABSENCE is what tells a reader the lens is fixed.
    useScene.getState().updateNode("push" as never, { fovEnd: 50 } as never);
    expect(readShots(CLOCK)[0]!.lensAnimation).toBeUndefined();
  });

  it("the push animates the resolved lens across the shot's own window", () => {
    createPluginNode(
      buildShotNode({
        id: "push",
        timelineId: CLOCK,
        timeSeconds: 0,
        blendSeconds: 0,
        fov: 60,
        animateFov: true,
        fovEnd: 20,
        fovEasing: "linear"
      })
    );
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();
    const fovAt = (time: number): number | undefined =>
      director.sync(camera, {
        timeline: readTimeline(CLOCK)!,
        vcams: readShotDefinitions(CLOCK),
        time
      })?.snapshot.lens?.fov;

    expect(fovAt(0)).toBeCloseTo(60, 5);
    expect(fovAt(10)).toBeCloseTo(40, 5);
    expect(fovAt(20)).toBeCloseTo(20, 5);
  });
});

// ------------------------------------------------------------------ the composer stage

describe("the damped composer runs in the director", () => {
  /** A body looking down -Z from the origin, watching a node placed well off to one side. */
  const TARGET_AT = new Vector3(6, 0, -10);

  function authorComposedShot(extra: Record<string, unknown> = {}): void {
    const target = new Object3D();
    target.position.copy(TARGET_AT);
    target.updateMatrixWorld(true);
    sceneRegistry.nodes.set("target_node" as never, target as never);

    createPluginNode(
      buildShotNode({
        id: "s",
        timelineId: CLOCK,
        timeSeconds: 0,
        blendSeconds: 0,
        body: "static",
        position: [0, 0, 0],
        rotationDeg: [0, 0, 0],
        aimMode: "track",
        aimTargetNodeId: "target_node",
        composerEnabled: true,
        ...extra
      })
    );
  }

  const getTargetPosition = (id: string): { x: number; y: number; z: number } | null => {
    const object = sceneRegistry.nodes.get(id as never) as Object3D | undefined;
    if (!object) return null;
    const world = new Vector3();
    object.getWorldPosition(world);
    return { x: world.x, y: world.y, z: world.z };
  };

  const drive = (
    director: PascalCameraDirector,
    camera: PerspectiveCamera,
    time: number,
    playing: boolean,
    delta: number
  ): CameraFrame | null =>
    director.sync(camera, {
      timeline: readTimeline(CLOCK)!,
      vcams: readShotDefinitions(CLOCK),
      time,
      playing,
      deltaSeconds: delta,
      getTargetPosition
    });

  const quatOf = (frame: CameraFrame): Quaternion =>
    new Quaternion(
      frame.snapshot.quaternion.x,
      frame.snapshot.quaternion.y,
      frame.snapshot.quaternion.z,
      frame.snapshot.quaternion.w
    );

  const forwardOf = (frame: CameraFrame): Vector3 =>
    new Vector3(0, 0, -1).applyQuaternion(quatOf(frame));

  it("centre-on-activate aims the composed forward AT the target, not down the body's -Z", () => {
    authorComposedShot({ composerCenterOnActivate: true });
    const director = new PascalCameraDirector();
    const frame = drive(director, new PerspectiveCamera(50, 16 / 9), 0, false, 0)!;

    expect(frame.composedTarget).toEqual({ x: 6, y: 0, z: -10 });
    expect(forwardOf(frame).angleTo(TARGET_AT.clone().normalize())).toBeLessThan(1e-6);
  });

  it("CONTROL: the same shot with the aim off keeps the body's orientation exactly", () => {
    // Without this, "the composer reframed it" would be equally true of a director that always
    // pointed at the target for some other reason.
    authorComposedShot({ aimMode: "body", composerEnabled: false, composerCenterOnActivate: true });
    const director = new PascalCameraDirector();
    const frame = drive(director, new PerspectiveCamera(50, 16 / 9), 0, false, 0)!;

    expect(frame.composedTarget).toBeNull();
    expect(forwardOf(frame).angleTo(new Vector3(0, 0, -1))).toBeLessThan(1e-6);
  });

  it("scrubbing is deterministic — the same time yields the same pose, however it was reached", () => {
    // The composer is the one stage that damps from the previous frame, so this is the property
    // the phase had to preserve: with the clock stopped the carried state is dropped and delta is
    // 0, which reduces the correction to the soft-edge clamp — a pure function of this frame.
    authorComposedShot();
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera(50, 16 / 9);

    const first = { ...drive(director, camera, 4, false, 0)!.snapshot.quaternion };
    // Walk the clock elsewhere and come back a different way.
    drive(director, camera, 0, false, 0);
    drive(director, camera, 19, false, 0);
    const again = { ...drive(director, camera, 4, false, 0)!.snapshot.quaternion };

    // Component equality, not an angle: `Quaternion.angleTo` runs the dot product through acos,
    // whose derivative is unbounded at 1, so two BIT-IDENTICAL quaternions still report ~3e-8 rad
    // (which is 2·acos(1 − one ULP)). Comparing components says what is actually meant.
    expect(again).toEqual(first);
  });

  it("CONTROL: under playback the same time does NOT repeat — the damping is real", () => {
    // The zero above would look identical if the composer never did anything at all. This shows
    // the state it carries actually changes the frame, so the determinism is a property of the
    // stopped clock rather than of a dead stage.
    authorComposedShot();
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera(50, 16 / 9);

    const scrubbed = quatOf(drive(director, camera, 4, false, 0)!);
    let played = scrubbed;
    for (let i = 0; i < 30; i += 1) played = quatOf(drive(director, camera, 4, true, 1 / 50)!);

    expect(played.angleTo(scrubbed)).toBeGreaterThan(1e-3);
  });

  it("a shot with no composer leaves the stage cold even after a composed shot ran", () => {
    // Two shots, one composed and one not: the composed orientation must not leak forward into
    // the plain shot, or a cut out of a composed shot would inherit its framing.
    const target = new Object3D();
    target.position.copy(TARGET_AT);
    target.updateMatrixWorld(true);
    sceneRegistry.nodes.set("target_node" as never, target as never);

    createPluginNode(
      buildShotNode({
        id: "composed",
        timelineId: CLOCK,
        timeSeconds: 0,
        blendSeconds: 0,
        position: [0, 0, 0],
        rotationDeg: [0, 0, 0],
        aimMode: "track",
        aimTargetNodeId: "target_node",
        composerEnabled: true,
        composerCenterOnActivate: true
      })
    );
    createPluginNode(
      buildShotNode({
        id: "plain",
        timelineId: CLOCK,
        timeSeconds: 10,
        blendSeconds: 0,
        position: [0, 0, 0],
        rotationDeg: [0, 0, 0]
      })
    );

    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera(50, 16 / 9);
    drive(director, camera, 0, true, 1 / 50);
    const plain = drive(director, camera, 12, true, 1 / 50)!;

    expect(plain.vcamId).toBe("plain");
    expect(plain.composedTarget).toBeNull();
    expect(forwardOf(plain).angleTo(new Vector3(0, 0, -1))).toBeLessThan(1e-6);
  });
});
