// The node kinds this plugin contributes to Pascal's vocabulary. Pascal ships 46
// architectural kinds and none of them can move; these are the ones time needs. Kinds are
// namespaced under the plugin id so they can never collide with Pascal's built-ins, and the
// fields here are the only thing Pascal persists — it round-trips them as opaque node data,
// exactly as it round-trips a wall's thickness. Scope: schema only, no runtime behaviour.
import { z } from "zod";
import { BaseNode } from "@pascal-app/core";
import { PersistedTrackSchema, TRACK_PAYLOAD_VERSION } from "./tracks";

/** Plugin id. Recorded by `loadPlugin` and gated per project by `installedPlugins`. */
export const PASCAL_TIME_PLUGIN_ID = "huma-time";

export const TIMELINE_KIND = "huma-time:timeline";
export const CUE_KIND = "huma-time:cue";
export const SHOT_KIND = "huma-time:shot";

/**
 * The scene's clock. One per scene document: it is what tracks, cues and shots hang off, and
 * what a player reads to know how long the world runs for.
 *
 * It has no position, and that is deliberate. Under the integration design's classification
 * test (R6) a node earns a place in space by being *placed* by a person; a clock is not. It is
 * an organisational node in the same class as Pascal's own site, building, level and zone —
 * present in the hierarchy, inspectable, with no geometry — which is why the definition sets
 * `dirtyTracking: false` and a `hitVolume` of `none`.
 *
 * Track data is NOT here. Tracks land in M1.6 with the persistence work; until then the host
 * supplies them, and this node carries only the clock's own properties.
 */
export const TimelineNode = BaseNode.extend({
  type: z.literal(TIMELINE_KIND).default(TIMELINE_KIND),
  /** Length of the timeline in seconds. Evaluation clamps to it; it is not a hint. */
  durationSeconds: z.number().min(0).default(10),
  /** Whether the clock wraps at `durationSeconds` rather than holding at the end. */
  loop: z.boolean().default(false),
  /** Whether a player starts running on load, rather than waiting to be driven. */
  autoplay: z.boolean().default(false),

  /**
   * The timeline's tracks, persisted with the scene document (M1.6).
   *
   * One versioned field rather than a node per track. The reasons that would have made nodes
   * clearly right — free migration and a free inspector — turned out not to exist: Pascal
   * validates `schemaVersion` and never reads it, and its inspector comes from a hand-declared
   * `parametrics` descriptor, not from the schema. Since the migrator is ours either way, one
   * versioned payload is the smaller thing to migrate. See the README.
   */
  tracks: z.array(PersistedTrackSchema).default([]),

  /**
   * Version of the `tracks` payload. Ours, not Pascal's — a missing value reads as 0, so a
   * document written before versioning existed still migrates rather than being misread as
   * current. That is the trap elastiq's own decks fell into.
   */
  trackPayloadVersion: z.number().int().min(0).default(TRACK_PAYLOAD_VERSION)
});
export type TimelineNodeType = z.infer<typeof TimelineNode>;

/**
 * A named moment on the clock. Products with a narrative call these slides, chapters or steps —
 * the same thing at three granularities, which is why the kind does not say which.
 *
 * It is a scene node for one reason: an author creates it, names it, retimes it, deletes it and
 * expects Ctrl+Z to bring it back. Pascal already does all of that for any registered kind, and
 * a cue kept only in a timeline document would need every one of those behaviours rebuilt.
 *
 * Like the timeline it belongs to, it has no position. Under the classification test a node
 * earns a place in space by being *placed* by a person, and a moment is not placed — so this is
 * organisational, and `parentId` points at the timeline whose clock the time is measured on.
 */
export const CueNode = BaseNode.extend({
  type: z.literal(CUE_KIND).default(CUE_KIND),
  /** Seconds on the parent timeline. The only thing that orders cues. */
  timeSeconds: z.number().min(0).default(0)
});
export type CueNodeType = z.infer<typeof CueNode>;

const Vec3Tuple = z.tuple([z.number(), z.number(), z.number()]);

/**
 * A camera, and the moment it takes over.
 *
 * Unlike the clock and the cue, a shot IS placed — an author drags it, aims it, and expects to
 * see where it is looking from. Under the classification test that makes it an ordinary spatial
 * scene node, so it parents wherever spatial things parent (the root, a level) rather than under
 * the timeline. That is also why it is the one kind here that renders something.
 *
 * Two bodies, both already implemented in `@huma/path-creator`:
 * - `static` — the camera sits at `position` looking along `rotationDeg`.
 * - `orbit`  — the camera orbits `targetNodeId` (or `targetPoint` when no node is named) at
 *   `radius`, `azimuthDeg`, `elevationDeg`. **This is where binding by id pays for itself:** the
 *   shot names the node it frames, so moving that node re-frames the shot with no timeline edit.
 *
 * **Accepted limitation, to revisit at M1.6:** `timeSeconds` puts the shot's moment on the shot,
 * so one shot cannot be reused at two different times. The alternative is a camera track that
 * references shots by id — which is what `@huma/path-creator` models and what a shot list
 * eventually wants — but tracks are not persisted until M1.6, and inventing a second unpersisted
 * concept to avoid this would be the worse trade today.
 */
export const ShotNode = BaseNode.extend({
  type: z.literal(SHOT_KIND).default(SHOT_KIND),
  /** Which clock `timeSeconds` is measured on. A field, not `parentId` — `parentId` is spatial. */
  timelineId: z.string().default(""),
  /** When this shot takes over. */
  timeSeconds: z.number().min(0).default(0),
  /** Seconds to blend in from the previous shot. 0 is a cut. */
  blendSeconds: z.number().min(0).default(1),

  body: z.enum(["static", "orbit"]).default("static"),
  /** Static body: where the camera is. Also where the gizmo draws, for both bodies. */
  position: Vec3Tuple.default([0, 2, 6]),
  /** Static body: where it looks, as Euler degrees. */
  rotationDeg: Vec3Tuple.default([0, 0, 0]),

  /** Orbit body: the node to frame. Empty means use `targetPoint` instead. */
  targetNodeId: z.string().default(""),
  targetPoint: Vec3Tuple.default([0, 0, 0]),
  azimuthDeg: z.number().default(25),
  elevationDeg: z.number().default(18),
  radius: z.number().min(0).default(8),

  /** Vertical field of view in degrees. */
  fov: z.number().min(1).max(179).default(50)
});
export type ShotNodeType = z.infer<typeof ShotNode>;
