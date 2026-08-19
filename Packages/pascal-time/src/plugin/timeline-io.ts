// Reading a timeline out of the scene document and writing edits back into it. This is the
// persistence seam: Pascal owns the document and its undo, `@huma/path-creator` owns evaluation,
// and neither knows about the other. Every write goes through `updateNode` with a NEW array,
// because Pascal's undo snapshot holds the nodes map by reference and an in-place edit silently
// corrupts the past state. Scope: document <-> Timeline, plus the clone remap.
import { useScene } from "@pascal-app/core";
import {
  createTimeline, type Timeline, type VirtualCameraDefinition
} from "@huma/path-creator/core";
import { TIMELINE_KIND } from "./kinds";
import {
  migrateTrackPayload,
  remapTracksForClone,
  removeTrack,
  removeTracksForObject,
  TRACK_PAYLOAD_VERSION,
  upsertTrack,
  type PersistedTrack
} from "./tracks";
import { readPluginNode, readShots } from "./scene-ops";

export interface StoredTimeline {
  id: string;
  name: string;
  durationSeconds: number;
  loop: boolean;
  autoplay: boolean;
  tracks: PersistedTrack[];
  /** The version the document actually carried, before migration. 0 means unversioned. */
  storedVersion: number;
}

/** The timeline node's own fields, migrated, without building a path-creator Timeline. */
export function readStoredTimeline(timelineId: string): StoredTimeline | null {
  const node = readPluginNode(timelineId);
  if (!node || node.type !== TIMELINE_KIND) return null;

  const { tracks, migratedFrom } = migrateTrackPayload(
    node.tracks,
    node.trackPayloadVersion as number | undefined
  );

  return {
    id: timelineId,
    name: (node.name as string | undefined) ?? timelineId,
    durationSeconds: (node.durationSeconds as number | undefined) ?? 0,
    loop: (node.loop as boolean | undefined) ?? false,
    autoplay: (node.autoplay as boolean | undefined) ?? false,
    tracks,
    storedVersion: migratedFrom
  };
}

/**
 * The scene's shot definitions, keyed by node id — which is what a camera block's `vcamId`
 * names, so the map and the blocks address shots the same way everything else in this system
 * addresses anything.
 */
export function readShotDefinitions(timelineId: string): Map<string, VirtualCameraDefinition> {
  return new Map(readShots(timelineId).map((shot) => [shot.id, shot.definition]));
}

/**
 * A camera track built from the shot nodes' own `timeSeconds` / `blendSeconds`.
 *
 * This is the compatibility path for a document authored before camera tracks existed, and it
 * runs at READ time rather than rewriting the document. That is deliberate: a load should not
 * mutate what it loaded, and a synthesised track costs nothing to recompute. An explicit camera
 * track in the payload always wins — the moment an author edits the shot list properly, the
 * synthesis stops applying.
 *
 * Each shot holds until the next begins; the last runs to the timeline's duration.
 */
export function synthesiseCameraTrack(timelineId: string, duration: number): PersistedTrack | null {
  const shots = [...readShots(timelineId)].sort((a, b) => a.time - b.time);
  if (shots.length === 0) return null;

  const blocks = shots.map((shot, index) => {
    const end = shots[index + 1]?.time ?? Math.max(duration, shot.time);
    return {
      id: `block_${shot.id}`,
      vcamId: shot.id,
      start: shot.time,
      end,
      // The first shot has nothing to blend FROM, so it never carries a blend however it is
      // authored — the library would look up block -1 and find no previous snapshot.
      ...(shot.blendSeconds > 0 && index > 0
        ? { blendIn: { durationSeconds: shot.blendSeconds, curve: shot.blendCurve } }
        : {}),
      // A FOV push is block-local (the evaluator samples it on the block's own window), which
      // is exactly why it belongs here rather than on the resolved definition: two blocks naming
      // the same shot can push differently, and the blend between them interpolates both lenses.
      ...(shot.lensAnimation ? { lensAnimation: shot.lensAnimation } : {})
    };
  });

  return { type: "camera", id: `camera_${timelineId}`, blocks };
}

/**
 * The scene's timeline, as the thing `@huma/path-creator` evaluates.
 *
 * `createTimeline` stamps the library's own schema version, so the returned object is a genuine
 * Timeline rather than a lookalike — which matters because the driver, the evaluators and the
 * migration path all key off that version.
 */
export function readTimeline(timelineId: string): Timeline | null {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return null;

  // An authored camera track wins; otherwise synthesise one from the shot nodes so a document
  // written before camera tracks existed still plays back its shots.
  const tracks = [...stored.tracks];
  if (!tracks.some((track) => track.type === "camera")) {
    const synthesised = synthesiseCameraTrack(timelineId, stored.durationSeconds);
    if (synthesised) tracks.push(synthesised);
  }

  return createTimeline({
    duration: stored.durationSeconds,
    tracks: tracks as Timeline["tracks"]
  });
}

/**
 * Persist a track list. One `updateNode` call, so one undo entry — Pascal's history is granular
 * over operations, not over nodes or fields, so batching is the only lever on undo shape.
 *
 * Writing the version alongside is what makes a document self-describing. Without it the next
 * schema change has to guess what it is reading, which is exactly the position elastiq's decks
 * are in today.
 */
export function writeTracks(timelineId: string, tracks: readonly PersistedTrack[]): void {
  useScene.getState().updateNode(timelineId as never, {
    tracks: [...tracks],
    trackPayloadVersion: TRACK_PAYLOAD_VERSION
  } as never);
}

/** Add or replace one track. Reads, edits purely, writes once. */
export function putTrack(timelineId: string, track: PersistedTrack): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  writeTracks(timelineId, upsertTrack(stored.tracks, track));
}

/** Delete one track by id. */
export function deleteTrack(timelineId: string, trackId: string): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  writeTracks(timelineId, removeTrack(stored.tracks, trackId));
}

/**
 * Drop every track bound to a node. A host calls this when a node is deleted for good — NOT on
 * an ordinary delete, because Pascal's undo restores the node and the tracks should come back
 * with it. The time layer tolerates a track pointing at a missing node (it skips), so leaving
 * them is safe; this exists for a deliberate purge.
 */
export function dropTracksForObject(timelineId: string, objectId: string): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  writeTracks(timelineId, removeTracksForObject(stored.tracks, objectId));
}

/**
 * The clone remap, decided 2026-08-17. Pascal's `cloneNodesInto` mints fresh ids by design;
 * a timeline reference cannot survive that, so duplicating an animated object would otherwise
 * produce an inert copy. Every track bound to a node inside the cloned subtree is duplicated
 * and rebound to the copy.
 *
 * `idMap` is original id -> clone id, which is what a clone reports. Call this immediately after
 * the clone, in the same gesture, so the two land as one undo entry from the author's side.
 */
export function remapTracksAfterClone(
  timelineId: string,
  idMap: ReadonlyMap<string, string>
): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  const next = remapTracksForClone(
    stored.tracks,
    idMap,
    (trackId, cloneObjectId) => `${trackId}__${cloneObjectId}`
  );
  if (next.length !== stored.tracks.length) writeTracks(timelineId, next);
}
