// Reading a timeline out of the scene document and writing edits back into it. This is the
// persistence seam: Pascal owns the document and its undo, `@huma/path-creator` owns evaluation,
// and neither knows about the other. Every write goes through `updateNode` with a NEW array,
// because Pascal's undo snapshot holds the nodes map by reference and an in-place edit silently
// corrupts the past state. Scope: document <-> Timeline, plus the clone remap.
import { useScene } from "@pascal-app/core";
import { createTimeline, type Timeline } from "@huma/path-creator/core";
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
import { readPluginNode } from "./scene-ops";

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
 * The scene's timeline, as the thing `@huma/path-creator` evaluates.
 *
 * `createTimeline` stamps the library's own schema version, so the returned object is a genuine
 * Timeline rather than a lookalike — which matters because the driver, the evaluators and the
 * migration path all key off that version.
 */
export function readTimeline(timelineId: string): Timeline | null {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return null;
  return createTimeline({
    duration: stored.durationSeconds,
    tracks: stored.tracks as Timeline["tracks"]
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
