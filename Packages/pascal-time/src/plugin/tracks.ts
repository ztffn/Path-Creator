// The timeline's tracks, as schema and as pure edits. Tracks live in one versioned field on the
// timeline node rather than as nodes of their own — see the README's "where tracks live" for the
// measurements behind that. Every function here RETURNS A NEW ARRAY and never mutates: Pascal's
// undo snapshot holds the nodes map by reference, so an in-place edit corrupts the past state
// and undo cannot restore it. Measured, not assumed. Scope: track schema and pure editing.
import { z } from "zod";

const Vec3Tuple = z.tuple([z.number(), z.number(), z.number()]);

/** Mirrors `TransformKey` in @huma/path-creator/core. */
export const TransformKeySchema = z.object({
  time: z.number(),
  value: Vec3Tuple,
  easing: z.string().optional()
});

export const TransformTrackSchema = z.object({
  type: z.literal("transform"),
  id: z.string(),
  name: z.string().optional(),
  /** The node this track drives. A node id, and the only thing tying time to space. */
  objectId: z.string(),
  position: z.array(TransformKeySchema).optional(),
  rotation: z.array(TransformKeySchema).optional(),
  scale: z.array(TransformKeySchema).optional(),
  additive: z.boolean().optional()
});

export const ActivationClipSchema = z.object({
  id: z.string(),
  start: z.number(),
  end: z.number()
});

export const ActivationTrackSchema = z.object({
  type: z.literal("activation"),
  id: z.string(),
  name: z.string().optional(),
  objectId: z.string(),
  clips: z.array(ActivationClipSchema).default([]),
  postPlaybackState: z.enum(["revert", "active", "inactive", "leaveAsIs"]).default("revert")
});

/** Mirrors `TimelineBlendIn`. `durationSeconds`, not `seconds` — the shape is the library's. */
export const BlendInSchema = z.object({
  durationSeconds: z.number().min(0),
  curve: z.string().optional()
});

/**
 * Mirrors `CameraBlock`. `vcamId` is a **shot node id** — the same identity every other
 * reference in this system uses, so a block naming a shot is a node reference like any other.
 */
export const CameraBlockSchema = z.object({
  id: z.string(),
  vcamId: z.string(),
  start: z.number(),
  end: z.number(),
  blendIn: BlendInSchema.optional()
});

export const CameraTrackSchema = z.object({
  type: z.literal("camera"),
  id: z.string(),
  name: z.string().optional(),
  blocks: z.array(CameraBlockSchema).default([])
});

/**
 * Only the track kinds the runtime actually applies. Audio and animation tracks are deliberately
 * absent: a schema that persists something nothing reads is a promise the document does not
 * keep, and each would need a migration when it arrives anyway.
 */
export const PersistedTrackSchema = z.discriminatedUnion("type", [
  TransformTrackSchema,
  ActivationTrackSchema,
  CameraTrackSchema
]);

export type PersistedTrack = z.infer<typeof PersistedTrackSchema>;

/** The tracks that drive a scene object, i.e. every kind except the camera track. */
export type ObjectBoundTrack = Extract<PersistedTrack, { objectId: string }>;

/**
 * Narrows to the tracks that name a scene object. A camera track binds to shots through its
 * blocks instead, so anything reasoning about "which node does this track drive" has to ask.
 */
export const isObjectBoundTrack = (track: PersistedTrack): track is ObjectBoundTrack =>
  "objectId" in track;

/**
 * Version of the tracks payload, ours alone.
 *
 * Pascal validates `NodeDefinition.schemaVersion` as a positive integer at registration and then
 * never reads it again — there is no per-kind migration hook anywhere in its contract, and its
 * own migrations are two hand-written functions. So a plugin that changes its stored shape
 * writes and runs its own migrator, which is what `migrateTrackPayload` is.
 */
export const TRACK_PAYLOAD_VERSION = 1;

/** Replace one track by id, or append it when the id is new. Returns a new array. */
export function upsertTrack(
  tracks: readonly PersistedTrack[],
  track: PersistedTrack
): PersistedTrack[] {
  const index = tracks.findIndex((candidate) => candidate.id === track.id);
  if (index === -1) return [...tracks, track];
  const next = [...tracks];
  next[index] = track;
  return next;
}

/** Drop a track by id. Returns a new array. */
export function removeTrack(
  tracks: readonly PersistedTrack[],
  trackId: string
): PersistedTrack[] {
  return tracks.filter((track) => track.id !== trackId);
}

/** Drop every track bound to an object — what a host does when a node is deleted for good. */
export function removeTracksForObject(
  tracks: readonly PersistedTrack[],
  objectId: string
): PersistedTrack[] {
  // A camera track binds to shots through its blocks, not through an `objectId`, so it is
  // never object-scoped and must survive this filter rather than being dropped by accident.
  return tracks.filter((track) => !("objectId" in track) || track.objectId !== objectId);
}

/**
 * Migrate a stored payload to the current version.
 *
 * Deliberately tolerant of a payload with no version at all: anything written before versioning
 * existed reads as version 0, which is the same trap elastiq's own decks fell into and the
 * reason the plan wants a version field from day one.
 */
export function migrateTrackPayload(
  raw: unknown,
  storedVersion: number | undefined
): { tracks: PersistedTrack[]; migratedFrom: number } {
  const from = storedVersion ?? 0;
  const list = Array.isArray(raw) ? raw : [];

  // v0 -> v1: the payload gained a version. Its shape was already this shape, so the migration
  // is a re-parse — which still matters, because it drops anything that never validated.
  const tracks: PersistedTrack[] = [];
  for (const entry of list) {
    const parsed = PersistedTrackSchema.safeParse(entry);
    if (parsed.success) tracks.push(parsed.data);
  }
  return { tracks, migratedFrom: from };
}

/**
 * Rewrite track bindings for a cloned subtree — the decided answer to R8's clone problem.
 *
 * Pascal's `cloneNodesInto` mints fresh ids, which is what a prefab needs and what a timeline
 * reference cannot survive. So when a subtree is duplicated, every track bound to a node inside
 * it is duplicated too and its `objectId` rewritten to the copy. The duplicate animates like the
 * original.
 *
 * Accepted limitation: N copies means N track sets, so re-animating a duplicated object means
 * editing it N times. That bites only at authoring scale, and the upgrade is binding
 * indirection — tracks name a slot, instances map slots to ids. Remapping does not foreclose it.
 *
 * `idMap` is original node id -> clone node id, which is what `cloneNodesInto` reports.
 */
export function remapTracksForClone(
  tracks: readonly PersistedTrack[],
  idMap: ReadonlyMap<string, string>,
  newTrackId: (originalTrackId: string, cloneObjectId: string) => string
): PersistedTrack[] {
  const added: PersistedTrack[] = [];
  for (const track of tracks) {
    // Camera tracks reference shots, not driven objects; cloning a subtree of geometry does not
    // duplicate the shot list, so they are skipped rather than mis-remapped.
    if (!("objectId" in track)) continue;
    const cloneObjectId = idMap.get(track.objectId);
    if (!cloneObjectId) continue;
    added.push({
      ...track,
      id: newTrackId(track.id, cloneObjectId),
      objectId: cloneObjectId
    } as PersistedTrack);
  }
  return [...tracks, ...added];
}
