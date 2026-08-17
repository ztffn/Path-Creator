// M1.2: tracks drive Pascal nodes by id, scrub deterministically, hand the pose back on
// leave, and — the assertion the whole approach rests on — cost Pascal's undo history and
// dirty-node set exactly nothing. Runs against Pascal's REAL scene store and REAL scene
// registry, and drives a genuine Pascal built-in kind (`column`) authored from Pascal's own
// schema, so "time never asks what a thing is" is demonstrated rather than asserted.
import { beforeAll, describe, expect, it } from "vitest";
import { ColumnNode, sceneRegistry, useScene } from "@pascal-app/core";
import { createTimeline, type Timeline } from "@huma/path-creator/core";
import { Group, Object3D } from "three";
import {
  installPascalTimeOnScene,
  PascalNodeDriver,
  pascalSceneBinding,
  registerPascalTimeKinds,
  TIMELINE_KIND
} from "../src/index";
import { flushFrame } from "./setup";

const COLUMN_ID = "column_1";
const CLOCK_ID = "timeline_1";

/**
 * What `useRegistry` does, without a React tree: the master id-to-object map plus the
 * per-kind index. Registration is a render-time side effect in Pascal, so a headless test has
 * to stand in for the render — the two writes below are exactly the two the hook performs.
 */
function registerObject(id: string, type: string, object: Object3D): void {
  sceneRegistry.nodes.set(id, object);
  sceneRegistry.byType[type]!.add(id);
}

/** A transform track that lifts `objectId` from y=0 to y=4 over four seconds. */
function liftTimeline(objectId: string): Timeline {
  return createTimeline({
    duration: 4,
    tracks: [
      {
        type: "transform",
        id: "lift",
        objectId,
        position: [
          { time: 0, value: [2, 0, -1] },
          { time: 4, value: [2, 4, -1] }
        ]
      }
    ]
  });
}

describe("M1.2 — a track moves an object the scene document owns", () => {
  let column: Object3D;
  let driver: PascalNodeDriver;
  let timeline: Timeline;

  beforeAll(() => {
    registerPascalTimeKinds();
    useScene.getState().clearScene();
    sceneRegistry.clear();
    installPascalTimeOnScene();

    // A real Pascal column, authored from Pascal's own schema. The time layer below never
    // learns that it is a column — it only ever sees the node id.
    const columnNode = ColumnNode.parse({
      id: COLUMN_ID,
      type: "column",
      parentId: null,
      position: [2, 0, -1]
    });
    useScene.getState().createNode(columnNode as never);

    column = new Group();
    column.position.set(2, 0, -1); // where Pascal placed it
    registerObject(COLUMN_ID, "column", column);

    driver = new PascalNodeDriver(pascalSceneBinding());
    timeline = liftTimeline(COLUMN_ID);
  });

  it("resolves the node id to the object Pascal registered", () => {
    expect(pascalSceneBinding().resolve(COLUMN_ID)).toBe(column);
    expect(pascalSceneBinding().resolve("no-such-node")).toBeNull();
  });

  it("has no animation binding, so every transform track over a Pascal node is absolute", () => {
    // Pascal has no runtime AnimationMixer for its nodes. Additive tracks exist to layer
    // corrections over mixer output; here there is nothing to layer over. Recorded as a
    // property of the integration, not a gap to close.
    expect(pascalSceneBinding().resolveAnimation(COLUMN_ID)).toBeNull();
  });

  it("moves the object when the clock moves", () => {
    driver.sync(timeline, { time: 2, playing: true, driving: true });
    expect(column.position.toArray()).toEqual([2, 2, -1]);
  });

  it("is a pure function of t — scrubbing back lands exactly where it did going forward", () => {
    const poseAt = (time: number): number[] => {
      driver.sync(timeline, { time, playing: false, driving: true });
      return column.position.toArray();
    };

    const forward = [0, 1, 2, 3, 4].map(poseAt);
    const backward = [4, 3, 2, 1, 0].map(poseAt).reverse();

    // Determinism under scrubbing is what the whole timeline design rests on, and later what
    // room consensus will rest on — every client evaluates the same t and must derive the
    // same world. A stateful evaluator would pass a forward-only test and fail this one.
    expect(backward).toEqual(forward);
    expect(forward[0]).toEqual([2, 0, -1]);
    expect(forward[4]).toEqual([2, 4, -1]);
  });

  it("hands the pose back untouched when the timeline is left", () => {
    driver.sync(timeline, { time: 3, playing: true, driving: true });
    expect(column.position.toArray()).toEqual([2, 3, -1]);

    driver.release();

    // Without this, scrubbing silently rewrites where the author put things and the scene
    // document drifts under them.
    expect(column.position.toArray()).toEqual([2, 0, -1]);
  });

  it("does not throw when Pascal deletes a node out from under a live track", () => {
    driver.sync(timeline, { time: 1, playing: true, driving: true });
    // Pascal owns the lifecycle. A node can vanish while a track still references it, and the
    // time layer skips rather than repairing — it holds ids it did not mint and cannot fix.
    useScene.getState().deleteNode(COLUMN_ID);
    sceneRegistry.nodes.delete(COLUMN_ID);

    expect(() => driver.sync(timeline, { time: 2, playing: true, driving: true })).not.toThrow();
    expect(() => driver.release()).not.toThrow();
  });
});

describe("M1.2 — activation drives visibility", () => {
  let marker: Object3D;
  let driver: PascalNodeDriver;
  const timeline = createTimeline({
    duration: 4,
    tracks: [
      {
        type: "activation",
        id: "reveal",
        objectId: CLOCK_ID,
        clips: [{ id: "window", start: 0, end: 2 }],
        postPlaybackState: "revert"
      }
    ]
  });

  beforeAll(() => {
    sceneRegistry.clear();
    marker = new Group();
    marker.visible = true; // how Pascal had it
    registerObject(CLOCK_ID, TIMELINE_KIND, marker);
    driver = new PascalNodeDriver(pascalSceneBinding());
  });

  it("is visible inside the clip window and hidden past it", () => {
    driver.sync(timeline, { time: 1, playing: true, driving: true });
    expect(marker.visible).toBe(true);

    driver.sync(timeline, { time: 3, playing: true, driving: true });
    expect(marker.visible).toBe(false);
  });

  it("reverts to how Pascal had it when the timeline is left", () => {
    driver.release();
    expect(marker.visible).toBe(true);
  });
});

describe("M1.2 — driving costs Pascal's document nothing", () => {
  it("2000 frames move undo depth by zero and dirty-node count by zero", async () => {
    registerPascalTimeKinds();
    useScene.getState().clearScene();
    sceneRegistry.clear();
    useScene.temporal.getState().clear();

    const node = ColumnNode.parse({
      id: COLUMN_ID,
      type: "column",
      parentId: null,
      position: [0, 0, 0]
    });
    useScene.getState().createNode(node as never);

    const object = new Group();
    registerObject(COLUMN_ID, "column", object);

    const driver = new PascalNodeDriver(pascalSceneBinding());
    const timeline = liftTimeline(COLUMN_ID);

    // Pascal marks dirty on the NEXT animation frame, so let creation's mark land and then
    // clear it. Measuring a delta on the raw set would prove nothing here: creation already
    // put this node in it, and a Set cannot grow when the same id is added again — which is
    // exactly how the first version of this test passed while measuring nothing at all.
    await flushFrame();
    useScene.getState().clearDirty(COLUMN_ID);
    expect(useScene.getState().dirtyNodes.size).toBe(0);

    const undoDepthBefore = useScene.temporal.getState().pastStates.length;

    const FRAMES = 2000;
    for (let frame = 0; frame < FRAMES; frame += 1) {
      driver.sync(timeline, {
        time: (frame / FRAMES) * timeline.duration,
        playing: true,
        driving: true
      });
    }
    driver.release();
    await flushFrame();

    // The measurement the whole approach turns on. Writing to node data instead of the live
    // Object3D would make every frame of playback an undo entry and would queue the node for
    // geometry rebuild 2000 times over. If a later change "fixes" something by writing
    // through the store, this is the test that catches it.
    expect(useScene.temporal.getState().pastStates.length - undoDepthBefore).toBe(0);
    expect(useScene.getState().dirtyNodes.size).toBe(0);

    // And the frames were not no-ops: the object really did travel, and came back.
    expect(object.position.y).toBe(0);
    driver.sync(timeline, { time: 4, playing: true, driving: true });
    expect(object.position.y).toBe(4);
  });

  it("— and the same measurement reads non-zero when the document really is edited", async () => {
    // The control. A zero only means something if the instruments move when they should, and
    // both of these were silently stuck at zero in earlier versions of this file: undo because
    // nothing had edited the store, dirty because Pascal defers marking to an animation frame
    // that Node does not have. One explicit edit, measured identically, is what makes the
    // zeros above evidence rather than an artefact of the harness.
    await flushFrame();
    useScene.getState().clearDirty(COLUMN_ID);
    const undoDepthBefore = useScene.temporal.getState().pastStates.length;

    useScene.getState().updateNode(COLUMN_ID, { position: [9, 9, 9] } as never);
    await flushFrame();

    expect(useScene.temporal.getState().pastStates.length - undoDepthBefore).toBe(1);
    expect(useScene.getState().dirtyNodes.has(COLUMN_ID)).toBe(true);
  });
});
