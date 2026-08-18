// Keyframe capture: turn "the pose the author is looking at" into persisted track keys. The
// pure half (withCapturedPose) upserts a full TRS key into an object's transform track and is
// what the tests pin; the impure half (captureTransformKey) reads the live Object3D out of
// Pascal's registry and writes ONE batched track update — one undo entry per press. Capture
// reads the LIVE object, so key it while the scene is yours (not driven), pose-then-key.
import { sceneRegistry } from "@pascal-app/core";
import type { Object3D } from "three";
import { readStoredTimeline, writeTracks } from "./timeline-io";
import type { PersistedTrack } from "./tracks";

type Vec3 = [number, number, number];

export interface CapturedPose {
  position: Vec3;
  /** Euler radians in the object's own rotation order (XYZ for anything Pascal registers). */
  rotation: Vec3;
  scale: Vec3;
}

/** Two keys this close in time are the same key — replace, don't stack. */
const KEY_TIME_EPSILON = 1e-6;

type TransformChannelKey = { time: number; value: Vec3 } & Record<string, unknown>;

/**
 * Insert a key at `time`, or replace the one already there. Replacement keeps the old key's
 * easing and tangents — re-keying a pose is a value edit, not a curve reset, which is how
 * every keyframe editor the author has used behaves.
 */
function upsertKey(
  keys: readonly TransformChannelKey[] | undefined,
  time: number,
  value: Vec3
): TransformChannelKey[] {
  const existing = keys ?? [];
  const at = existing.findIndex((key) => Math.abs(key.time - time) <= KEY_TIME_EPSILON);
  if (at >= 0) {
    return existing.map((key, index) => (index === at ? { ...key, value } : key));
  }
  const next = [...existing, { time, value }];
  next.sort((a, b) => a.time - b.time);
  return next;
}

/**
 * A new track list with `pose` keyed at `time` on the object's transform track — creating the
 * track when the object has none. All three channels are keyed together: a pose is one thing
 * to the author, and channels that key independently drift apart in ways nobody intends.
 * Pure, returns a new array (Pascal's undo snapshot aliases the old one).
 */
export function withCapturedPose(
  tracks: readonly PersistedTrack[],
  objectId: string,
  time: number,
  pose: CapturedPose
): PersistedTrack[] {
  const at = tracks.findIndex(
    (track) => track.type === "transform" && track.objectId === objectId && !track.additive
  );

  if (at < 0) {
    const taken = new Set(tracks.map((track) => ("id" in track ? track.id : "")));
    let id = `transform_${objectId}`;
    for (let n = 2; taken.has(id); n += 1) id = `transform_${objectId}_${n}`;
    return [
      ...tracks,
      {
        type: "transform",
        id,
        objectId,
        position: upsertKey(undefined, time, pose.position),
        rotation: upsertKey(undefined, time, pose.rotation),
        scale: upsertKey(undefined, time, pose.scale)
      }
    ];
  }

  return tracks.map((track, index) => {
    if (index !== at || track.type !== "transform") return track;
    return {
      ...track,
      position: upsertKey(track.position, time, pose.position),
      rotation: upsertKey(track.rotation, time, pose.rotation),
      scale: upsertKey(track.scale, time, pose.scale)
    };
  });
}

/**
 * A new track list with a visibility clip `[start, end)` added to the object's activation
 * track — creating the track when the object has none. An object is visible while inside any
 * clip and hidden outside all of them, so the first clip an author adds is also the moment
 * the object STARTS disappearing everywhere else; that is the semantic, not a bug. Pure.
 */
export function withActivationClip(
  tracks: readonly PersistedTrack[],
  objectId: string,
  start: number,
  end: number
): PersistedTrack[] {
  const at = tracks.findIndex(
    (track) => track.type === "activation" && track.objectId === objectId
  );

  if (at < 0) {
    const taken = new Set(tracks.map((track) => ("id" in track ? track.id : "")));
    let id = `activation_${objectId}`;
    for (let n = 2; taken.has(id); n += 1) id = `activation_${objectId}_${n}`;
    return [
      ...tracks,
      {
        type: "activation",
        id,
        objectId,
        clips: [{ id: "clip_1", start, end }],
        postPlaybackState: "revert"
      }
    ];
  }

  return tracks.map((track, index) => {
    if (index !== at || track.type !== "activation") return track;
    const taken = new Set(track.clips.map((clip) => clip.id));
    let clipId = `clip_${track.clips.length + 1}`;
    for (let n = track.clips.length + 2; taken.has(clipId); n += 1) clipId = `clip_${n}`;
    const clips = [...track.clips, { id: clipId, start, end }];
    clips.sort((a, b) => a.start - b.start);
    return { ...track, clips };
  });
}

/** The live pose of a registered object, as a key captures it. */
export function capturePose(object: Object3D): CapturedPose {
  return {
    position: [object.position.x, object.position.y, object.position.z],
    rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
    scale: [object.scale.x, object.scale.y, object.scale.z]
  };
}

/**
 * Key `objectId`'s live pose at `time` on the scene's timeline. One `writeTracks`, so one undo
 * entry per press. Returns false when there is nothing to key — no timeline node, or no live
 * object registered under that id (a cue, say, which has no renderer and no pose).
 */
export function captureTransformKey(
  timelineId: string,
  objectId: string,
  time: number,
  resolve: (id: string) => Object3D | null = (id) => sceneRegistry.nodes.get(id) ?? null
): boolean {
  const stored = readStoredTimeline(timelineId);
  const object = resolve(objectId);
  if (!stored || !object) return false;
  writeTracks(timelineId, withCapturedPose(stored.tracks, objectId, time, capturePose(object)));
  return true;
}
