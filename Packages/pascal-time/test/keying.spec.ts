// Keyframe capture (M1.3): the panel's "key this pose" affordance, pinned at both altitudes.
// The pure half (withCapturedPose) must upsert without mutating — Pascal's undo snapshot
// aliases the old array. The impure half (captureTransformKey) must cost exactly ONE undo
// entry, and what it writes must SURVIVE the migrator — including the curve editor's sparse
// tangent arrays (undefined holes), which an earlier schema draft would have silently dropped
// whole tracks over. Runs against Pascal's real store, per the package's standard.
import { beforeEach, describe, expect, it } from "vitest";
import { useScene } from "@pascal-app/core";
import { Group } from "three";
import { sceneRegistry } from "@pascal-app/core";
import {
  buildTimelineNode,
  capturePose,
  captureTransformKey,
  createPluginNode,
  installPascalTimeOnScene,
  putTrack,
  readStoredTimeline,
  registerPascalTimeKinds,
  withActivationClip,
  withCapturedPose,
  type CapturedPose,
  type PersistedTrack
} from "../src/index";

const CLOCK = "humatime_keying_clock";
const POSE: CapturedPose = { position: [1, 2, 3], rotation: [0, Math.PI, 0], scale: [1, 1, 1] };

describe("withCapturedPose (pure)", () => {
  it("creates a transform track with all three channels keyed together", () => {
    const next = withCapturedPose([], "obj", 2, POSE);
    expect(next).toHaveLength(1);
    const track = next[0] as Extract<PersistedTrack, { type: "transform" }>;
    expect(track).toMatchObject({ type: "transform", id: "transform_obj", objectId: "obj" });
    expect(track.position).toEqual([{ time: 2, value: [1, 2, 3] }]);
    expect(track.rotation).toEqual([{ time: 2, value: [0, Math.PI, 0] }]);
    expect(track.scale).toEqual([{ time: 2, value: [1, 1, 1] }]);
  });

  it("inserts sorted into an existing track and never mutates its input", () => {
    const original = withCapturedPose([], "obj", 4, POSE);
    Object.freeze(original);
    Object.freeze(original[0]);
    Object.freeze((original[0] as { position: unknown[] }).position);

    const next = withCapturedPose(original, "obj", 1, {
      ...POSE,
      position: [9, 9, 9]
    });
    const track = next[0] as Extract<PersistedTrack, { type: "transform" }>;
    expect(track.position?.map((k) => k.time)).toEqual([1, 4]);
    expect(next).not.toBe(original);
    expect(track).not.toBe(original[0]);
  });

  it("re-keying the same time replaces the value but keeps the key's easing and tangents", () => {
    const seeded: PersistedTrack[] = [
      {
        type: "transform",
        id: "transform_obj",
        objectId: "obj",
        position: [
          { time: 2, value: [0, 0, 0], easing: "easeInOut", tangentsAxes: [{ out: [0.5, 1] }] }
        ]
      }
    ];
    const next = withCapturedPose(seeded, "obj", 2, POSE);
    const track = next[0] as Extract<PersistedTrack, { type: "transform" }>;
    expect(track.position).toHaveLength(1);
    expect(track.position?.[0]).toMatchObject({
      time: 2,
      value: [1, 2, 3],
      easing: "easeInOut",
      tangentsAxes: [{ out: [0.5, 1] }]
    });
  });

  it("leaves additive tracks alone — a capture is an absolute pose", () => {
    const additive: PersistedTrack[] = [
      { type: "transform", id: "transform_obj", objectId: "obj", additive: true, position: [] }
    ];
    const next = withCapturedPose(additive, "obj", 0, POSE);
    expect(next).toHaveLength(2);
    expect((next[1] as { id: string }).id).not.toBe("transform_obj");
  });
});

describe("withActivationClip (pure)", () => {
  it("creates the object's activation track with one clip and revert semantics", () => {
    const next = withActivationClip([], "obj", 1, 10);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      type: "activation",
      id: "activation_obj",
      objectId: "obj",
      clips: [{ id: "clip_1", start: 1, end: 10 }],
      postPlaybackState: "revert"
    });
  });

  it("appends to an existing track sorted by start, with a fresh clip id, no mutation", () => {
    const original = withActivationClip([], "obj", 5, 10);
    Object.freeze(original);
    Object.freeze(original[0]);
    Object.freeze((original[0] as { clips: unknown[] }).clips);

    const next = withActivationClip(original, "obj", 0, 2);
    const track = next[0] as Extract<PersistedTrack, { type: "activation" }>;
    expect(track.clips.map((clip) => clip.start)).toEqual([0, 5]);
    expect(new Set(track.clips.map((clip) => clip.id)).size).toBe(2);
    expect(next).not.toBe(original);
  });

  it("leaves other objects' activation tracks alone", () => {
    const seeded = withActivationClip([], "other", 0, 4);
    const next = withActivationClip(seeded, "obj", 1, 3);
    expect(next).toHaveLength(2);
    expect((seeded[0] as { clips: unknown[] }).clips).toHaveLength(1);
  });
});

describe("captureTransformKey (against Pascal's real store)", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    useScene.getState().clearScene();
    useScene.temporal.getState().clear();
    sceneRegistry.clear();
    installPascalTimeOnScene();
    createPluginNode(buildTimelineNode({ id: CLOCK, durationSeconds: 10 }));

    const object = new Group();
    object.position.set(1, 2, 3);
    object.rotation.set(0, Math.PI, 0);
    sceneRegistry.nodes.set("marker", object);
  });

  it("captures the live pose from three's real object", () => {
    const pose = capturePose(sceneRegistry.nodes.get("marker")!);
    expect(pose.position).toEqual([1, 2, 3]);
    expect(pose.rotation[1]).toBeCloseTo(Math.PI);
    expect(pose.scale).toEqual([1, 1, 1]);
  });

  it("one press is one undo entry, and the key lands in the document", () => {
    const before = useScene.temporal.getState().pastStates.length;
    expect(captureTransformKey(CLOCK, "marker", 2.5)).toBe(true);
    expect(useScene.temporal.getState().pastStates.length - before).toBe(1);

    const stored = readStoredTimeline(CLOCK);
    const track = stored?.tracks[0] as Extract<PersistedTrack, { type: "transform" }>;
    expect(track.objectId).toBe("marker");
    expect(track.position).toEqual([{ time: 2.5, value: [1, 2, 3] }]);
  });

  it("returns false when there is nothing to key, and writes nothing", () => {
    const before = useScene.temporal.getState().pastStates.length;
    expect(captureTransformKey(CLOCK, "no-such-object", 0)).toBe(false);
    expect(captureTransformKey("no-such-clock", "marker", 0)).toBe(false);
    expect(useScene.temporal.getState().pastStates.length).toBe(before);
  });

  it("what the curve editor writes survives the migrator — sparse tangents and easing curves", () => {
    // The editor leaves undefined holes for untouched axes; JSON round-trips them to null.
    // Both must validate, or migrateTrackPayload silently drops the whole track on next read.
    putTrack(CLOCK, {
      type: "transform",
      id: "transform_marker",
      objectId: "marker",
      position: [
        {
          time: 0,
          value: [0, 0, 0],
          easing: { type: "curve", keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
          tangentsAxes: [undefined, { out: [0.3, 0.5] }, null] as never
        },
        { time: 4, value: [0, 3, 0] }
      ]
    });
    const stored = readStoredTimeline(CLOCK);
    expect(stored?.tracks).toHaveLength(1);
    const track = stored?.tracks[0] as Extract<PersistedTrack, { type: "transform" }>;
    expect(track.position?.[0]?.easing).toEqual({
      type: "curve",
      keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    });
    expect(track.position?.[0]?.tangentsAxes?.[1]).toEqual({ out: [0.3, 0.5] });
  });
});
