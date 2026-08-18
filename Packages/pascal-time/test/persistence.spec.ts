// M1.6: the timeline lives in the scene document, versioned, migrating, and surviving a clone.
// Three things are load-bearing here and each was measured before it was designed on: a nested
// track payload survives Pascal's store round trip; an IN-PLACE edit corrupts undo because the
// history snapshot holds the nodes map by reference; and Pascal reads `schemaVersion` never, so
// the migrator is ours. Scope: persistence, versioning, and the R8 clone remap.
import { beforeEach, describe, expect, it } from "vitest";
import { useScene } from "@pascal-app/core";
import { evaluateTransform } from "@huma/path-creator/core";
import { Group, type Object3D } from "three";
import { sceneRegistry } from "@pascal-app/core";
import {
  buildTimelineNode,
  createPluginNode,
  deleteTrack,
  dropTracksForObject,
  installPascalTimeOnScene,
  migrateTrackPayload,
  PascalNodeDriver,
  pascalSceneBinding,
  putTrack,
  readStoredTimeline,
  readTimeline,
  registerPascalTimeKinds,
  remapTracksAfterClone,
  remapTracksForClone,
  TRACK_PAYLOAD_VERSION,
  upsertTrack,
  writeTracks,
  type PersistedTrack
} from "../src/index";

const CLOCK = "humatime_clock";

const LIFT: PersistedTrack = {
  type: "transform",
  id: "track_lift",
  objectId: "marker_a",
  position: [
    { time: 0, value: [0, 0, 0] },
    { time: 4, value: [0, 4, 0] }
  ]
};

const REVEAL: PersistedTrack = {
  type: "activation",
  id: "track_reveal",
  objectId: "marker_b",
  clips: [{ id: "window", start: 1, end: 3 }],
  postPlaybackState: "revert"
};

function authorTimeline(tracks: PersistedTrack[] = [LIFT, REVEAL]): void {
  useScene.getState().clearScene();
  useScene.temporal.getState().clear();
  sceneRegistry.clear();
  installPascalTimeOnScene();
  createPluginNode(buildTimelineNode({ id: CLOCK, name: "Deck", durationSeconds: 8, tracks }));
}

describe("M1.6 — tracks survive the scene document", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    authorTimeline();
  });

  it("round-trips a nested track payload intact", () => {
    const stored = readStoredTimeline(CLOCK)!;
    expect(stored.tracks).toHaveLength(2);
    const lift = stored.tracks.find((track) => track.id === "track_lift")!;
    expect(lift.type).toBe("transform");
    expect(lift.objectId).toBe("marker_a");
    expect("position" in lift && lift.position).toEqual(LIFT.position);
  });

  it("assembles a genuine path-creator Timeline, stamped with its schema version", () => {
    const timeline = readTimeline(CLOCK)!;
    // Not a lookalike: the driver, the evaluators and the library's own migration path all key
    // off this version, so an object without it would be a quiet forgery.
    expect(timeline.schemaVersion).toBeGreaterThan(0);
    expect(timeline.duration).toBe(8);
    expect(timeline.tracks).toHaveLength(2);
  });

  it("produces tracks the library's own evaluator accepts", () => {
    // The point of persisting is that what comes back out drives something. Evaluating the
    // stored track directly proves the shape is the library's, not merely shaped like it.
    const timeline = readTimeline(CLOCK)!;
    const transforms = timeline.tracks.filter((track) => track.type === "transform");
    const evaluated = evaluateTransform(transforms as never, 2);
    expect(evaluated.get("marker_a")?.position).toEqual([0, 2, 0]);
  });

  it("drives a real object end to end, from document to pose", () => {
    const marker: Object3D = new Group();
    sceneRegistry.nodes.set("marker_a", marker);

    const driver = new PascalNodeDriver(pascalSceneBinding());
    driver.sync(readTimeline(CLOCK)!, { time: 3, playing: true, driving: true });
    expect(marker.position.y).toBe(3);

    driver.release();
    expect(marker.position.y).toBe(0);
  });
});

describe("M1.6 — editing tracks without corrupting undo", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    authorTimeline();
  });

  it("adds a track as one undo entry, and undo takes it back out", () => {
    const before = useScene.temporal.getState().pastStates.length;
    putTrack(CLOCK, { ...LIFT, id: "track_new", objectId: "marker_c" });

    expect(useScene.temporal.getState().pastStates.length - before).toBe(1);
    expect(readStoredTimeline(CLOCK)!.tracks).toHaveLength(3);

    useScene.temporal.getState().undo();
    expect(readStoredTimeline(CLOCK)!.tracks).toHaveLength(2);
  });

  it("replaces a track by id rather than appending a duplicate", () => {
    putTrack(CLOCK, { ...LIFT, position: [{ time: 0, value: [1, 1, 1] }] });
    const tracks = readStoredTimeline(CLOCK)!.tracks;
    expect(tracks).toHaveLength(2);
    const lift = tracks.find((track) => track.id === "track_lift")!;
    expect("position" in lift && lift.position).toEqual([{ time: 0, value: [1, 1, 1] }]);
  });

  it("deletes a track, and drops every track bound to an object", () => {
    deleteTrack(CLOCK, "track_reveal");
    expect(readStoredTimeline(CLOCK)!.tracks).toHaveLength(1);

    dropTracksForObject(CLOCK, "marker_a");
    expect(readStoredTimeline(CLOCK)!.tracks).toHaveLength(0);
  });

  it("never mutates the array it was given — the hazard this API exists to prevent", () => {
    // Pascal's undo snapshot holds the nodes map BY REFERENCE. Measured: mutating a stored
    // array in place and then undoing does NOT restore it, because the past state was mutated
    // too. So the editing functions are pure and this test is what keeps them that way.
    const original = readStoredTimeline(CLOCK)!.tracks;
    const snapshot = JSON.stringify(original);

    const next = upsertTrack(original, { ...LIFT, id: "track_new", objectId: "marker_c" });

    expect(next).not.toBe(original);
    expect(JSON.stringify(original)).toBe(snapshot);
  });

  it("undo restores the previous payload exactly, not approximately", () => {
    useScene.temporal.getState().clear();
    const before = JSON.stringify(readStoredTimeline(CLOCK)!.tracks);

    writeTracks(CLOCK, [{ ...LIFT, position: [{ time: 9, value: [9, 9, 9] }] }]);
    expect(JSON.stringify(readStoredTimeline(CLOCK)!.tracks)).not.toBe(before);

    useScene.temporal.getState().undo();
    expect(JSON.stringify(readStoredTimeline(CLOCK)!.tracks)).toBe(before);
  });
});

describe("M1.6 — versioning, because Pascal does not do it for us", () => {
  beforeEach(() => registerPascalTimeKinds());

  it("stamps the payload version on every write", () => {
    authorTimeline();
    putTrack(CLOCK, { ...LIFT, id: "track_new", objectId: "marker_c" });
    const node = useScene.getState().nodes[CLOCK as never] as unknown as Record<string, unknown>;
    expect(node.trackPayloadVersion).toBe(TRACK_PAYLOAD_VERSION);
  });

  it("reads an unversioned payload as version 0 rather than as current", () => {
    // The trap elastiq's own decks fell into: with no version field, a migrator has to sniff
    // the shape and guess. Absent reads as 0, and 0 is a version we can migrate FROM.
    const { migratedFrom, tracks } = migrateTrackPayload([LIFT], undefined);
    expect(migratedFrom).toBe(0);
    expect(tracks).toHaveLength(1);
  });

  it("drops entries that never validated instead of carrying them forward", () => {
    const { tracks } = migrateTrackPayload(
      [LIFT, { type: "transform", id: "broken" }, { type: "nonsense" }, null],
      0
    );
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.id).toBe("track_lift");
  });

  it("survives a payload that is not an array at all", () => {
    expect(migrateTrackPayload(undefined, undefined).tracks).toEqual([]);
    expect(migrateTrackPayload("nonsense", 1).tracks).toEqual([]);
  });
});

describe("M1.6 — R8, a duplicated object keeps its animation", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    authorTimeline();
  });

  it("duplicates the tracks bound inside a cloned subtree and rebinds them", () => {
    // Pascal's cloneNodesInto mints fresh ids by design — right for a prefab, fatal for a
    // timeline reference. Without this, duplicating an animated object yields an inert copy.
    const idMap = new Map([["marker_a", "marker_a_copy"]]);
    remapTracksAfterClone(CLOCK, idMap);

    const tracks = readStoredTimeline(CLOCK)!.tracks;
    expect(tracks).toHaveLength(3);
    const copy = tracks.find((track) => track.objectId === "marker_a_copy")!;
    expect(copy.type).toBe("transform");
    expect("position" in copy && copy.position).toEqual(LIFT.position);
    // The original is untouched.
    expect(tracks.find((track) => track.id === "track_lift")!.objectId).toBe("marker_a");
  });

  it("gives the duplicate a distinct track id", () => {
    remapTracksAfterClone(CLOCK, new Map([["marker_a", "marker_a_copy"]]));
    const ids = readStoredTimeline(CLOCK)!.tracks.map((track) => track.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ignores a clone whose nodes no track references", () => {
    const before = readStoredTimeline(CLOCK)!.tracks.length;
    remapTracksAfterClone(CLOCK, new Map([["something_else", "its_copy"]]));
    expect(readStoredTimeline(CLOCK)!.tracks).toHaveLength(before);
  });

  it("the copy really animates — the whole point of remapping", () => {
    const original: Object3D = new Group();
    const copy: Object3D = new Group();
    sceneRegistry.nodes.set("marker_a", original);
    sceneRegistry.nodes.set("marker_a_copy", copy);

    remapTracksAfterClone(CLOCK, new Map([["marker_a", "marker_a_copy"]]));

    const driver = new PascalNodeDriver(pascalSceneBinding());
    driver.sync(readTimeline(CLOCK)!, { time: 2, playing: true, driving: true });
    expect(original.position.y).toBe(2);
    expect(copy.position.y).toBe(2);
  });

  it("remaps N copies independently, the accepted cost of this decision", () => {
    // N copies means N track sets — recorded as the known limitation, and the reason binding
    // indirection is the named upgrade if authoring at scale ever demands it.
    const tracks = remapTracksForClone(
      [LIFT],
      new Map([["marker_a", "copy_1"]]),
      (id, obj) => `${id}__${obj}`
    );
    const twice = remapTracksForClone(
      tracks,
      new Map([["marker_a", "copy_2"]]),
      (id, obj) => `${id}__${obj}`
    );
    expect(twice.filter((track) => track.objectId.startsWith("copy_"))).toHaveLength(2);
  });
});
