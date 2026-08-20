// The node kinds this plugin contributes to Pascal's vocabulary. Pascal ships 46
// architectural kinds and none of them can move; these are the ones time needs. Kinds are
// namespaced under the plugin id so they can never collide with Pascal's built-ins, and the
// fields here are the only thing Pascal persists — it round-trips them as opaque node data,
// exactly as it round-trips a wall's thickness. Scope: schema only, no runtime behaviour.
import { z } from "zod";
import { BaseNode } from "@pascal-app/core";
import { EasingSchema, PersistedTrackSchema, TRACK_PAYLOAD_VERSION } from "./tracks";

/** Plugin id. Recorded by `loadPlugin` and gated per project by `installedPlugins`. */
export const PASCAL_TIME_PLUGIN_ID = "huma-time";

export const TIMELINE_KIND = "huma-time:timeline";
export const CUE_KIND = "huma-time:cue";
export const SHOT_KIND = "huma-time:shot";
export const PATH_KIND = "huma-time:path";
export const CART_KIND = "huma-time:cart";

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
  /** When this shot takes over — the start of its block. */
  timeSeconds: z.number().min(0).default(0),
  /**
   * When this shot's block ends. A shot whose block ENDS AFTER the next shot's begins overlaps
   * it, and that overlap **is** the crossover: the blend's duration is derived from it, exactly
   * as `@huma/path-creator`'s own demo derives it. So the thing an author drags on the lane is
   * the thing that shapes the hand-off, rather than a number typed somewhere else.
   *
   * `end <= start` reads as UNSET, which is how a document written before this field existed
   * still plays: `readShots` falls back to the legacy `blendSeconds` layout below. A load does
   * not rewrite what it loaded — the same rule the synthesised camera track follows.
   */
  endSeconds: z.number().min(0).default(0),
  /**
   * **Legacy.** Before the span above, a shot carried its blend as a duration and blocks abutted.
   * Nothing authors this any more and it is not an inspector field; it survives only so that
   * `readShots` can reconstruct the same picture for a document that predates `endSeconds`.
   */
  blendSeconds: z.number().min(0).default(1),

  body: z.enum(["static", "orbit", "cart"]).default("static"),
  /** Static body: where the camera is. Also where the gizmo draws, for both bodies. */
  position: Vec3Tuple.default([0, 2, 6]),
  /** Static body: where it looks, as Euler degrees. */
  rotationDeg: Vec3Tuple.default([0, 0, 0]),

  /** Cart body (M1.7): the cart node this shot rides. The rail supplies the pose. */
  cartId: z.string().default(""),
  /** Cart body: rail-local offset from the cart — x right, y up, z forward. */
  cartOffset: Vec3Tuple.default([0, 0, 0]),

  /** Orbit body: the node to frame. Empty means use `targetPoint` instead. */
  targetNodeId: z.string().default(""),
  targetPoint: Vec3Tuple.default([0, 0, 0]),
  azimuthDeg: z.number().default(25),
  elevationDeg: z.number().default(18),
  radius: z.number().min(0).default(8),

  /** Vertical field of view in degrees. */
  fov: z.number().min(1).max(179).default(50),

  // ---- M1.8: the camera language ----
  // Everything below is exposure of evaluation `@huma/path-creator` already does. The shot node
  // is the authoring surface because the panel has no per-block surface: `synthesiseCameraTrack`
  // maps one shot to one camera block, so a field here IS the block's field.

  /**
   * How this shot's blend from the previous one is shaped. A preset name or a full custom curve
   * — the library's `VirtualCameraBlendCurve` is an `Easing`, and this carries all of it. It
   * only matters when this shot overlaps the previous one; with no overlap the cut has no
   * hand-off to shape.
   *
   * Not an inspector field: there is no declarative field kind for a curve. The panel mounts
   * `EasingEditor` for it, which is the widget the library already shipped for exactly this.
   */
  blendCurve: EasingSchema.default("easeInOut"),

  /**
   * Lens animation across the shot's own window — a FOV push. `fov` is the start value (the
   * shot's static lens) and `fovEnd` the end; the panel authors the curve. Off by default, so a
   * shot with no push resolves to a constant lens and no `lensAnimation` is emitted at all.
   */
  animateFov: z.boolean().default(false),
  fovEnd: z.number().min(1).max(179).default(50),
  fovEasing: EasingSchema.default("easeInOut"),

  /**
   * Where the shot LOOKS, independent of where it is. `body` keeps the body's own orientation
   * (a static shot's `rotationDeg`, an orbit shot looking back at what it circles). `track`
   * aims at a node — so a static camera can follow a moving object, and an orbit shot can
   * frame something other than its own pivot.
   *
   * Distinct from `targetNodeId`, which is the ORBIT body's position source. The library keeps
   * them separate for the same reason: what you circle and what you watch need not be the same.
   */
  aimMode: z.enum(["body", "track"]).default("body"),
  /** Track aim: the node to watch. Empty means use `aimTargetPoint`. */
  aimTargetNodeId: z.string().default(""),
  aimTargetPoint: Vec3Tuple.default([0, 0, 0]),

  /**
   * The damped screen composer, on top of a `track` aim. Off means an instant look-at: the
   * target is centred every frame, purely and deterministically. On means the target is only
   * reframed once it leaves the dead zone, damped per axis — the Cinemachine framing model.
   *
   * This is the one stage in the system that is NOT a pure function of `t`: it damps from the
   * previous frame. The director therefore resets it and passes `delta = 0` whenever the
   * transport is not playing, which makes a scrub deterministic (the clamp applies, the damping
   * does not) while playback stays damped.
   */
  composerEnabled: z.boolean().default(false),
  /** Framing anchor in normalized screen space; 0,0 is the centre. */
  composerScreenX: z.number().min(-0.5).max(0.5).default(0),
  composerScreenY: z.number().min(-0.5).max(0.5).default(0),
  /** Inside the dead zone nothing reframes. */
  composerDeadWidth: z.number().min(0).max(1).default(0.18),
  composerDeadHeight: z.number().min(0).max(1).default(0.14),
  /** At the soft edge the reframe becomes a hard clamp. */
  composerSoftWidth: z.number().min(0).max(1).default(0.55),
  composerSoftHeight: z.number().min(0).max(1).default(0.45),
  /** Per-axis heaviness: larger is slower. alpha = 1 - e^(-(12/damping)·dt). */
  composerDampingX: z.number().min(0).default(6),
  composerDampingY: z.number().min(0).default(8),
  /** World-space offset added to the tracked target before framing (aim above a head, say). */
  composerTargetOffset: Vec3Tuple.default([0, 0, 0]),
  /** Lead a moving target by this many seconds of its smoothed velocity. */
  composerLookaheadTime: z.number().min(0).default(0.2),
  composerLookaheadSmoothing: z.number().min(0).default(8),
  composerLookaheadIgnoreY: z.boolean().default(false),
  /** Centre the target exactly on the composer's first frame, ignoring the dead zone. */
  composerCenterOnActivate: z.boolean().default(false),

  /**
   * Seeded procedural wobble — the handheld/impact layer. Pure: it is a function of the seed and
   * the resolve clock, so the same `t` always yields the same wobble and scrubbing is exact.
   * Amplitudes and frequencies are per-axis; the library also accepts a scalar, and a vec3 is
   * strictly the wider of the two shapes.
   */
  noiseEnabled: z.boolean().default(false),
  noiseSeed: z.number().int().default(1),
  /** Camera-local position wobble, in scene units per axis. */
  noisePositionAmplitude: Vec3Tuple.default([0.02, 0.02, 0.02]),
  noisePositionFrequency: Vec3Tuple.default([1, 1, 1]),
  /** Local pitch/yaw/roll wobble, in degrees per axis. */
  noiseRotationAmplitudeDeg: Vec3Tuple.default([0.2, 0.2, 0.1]),
  noiseRotationFrequencyDeg: Vec3Tuple.default([1, 1, 1])
});
export type ShotNodeType = z.infer<typeof ShotNode>;

/**
 * A rail: an editable cubic bezier the author draws in the viewport, and the oldest strength of
 * `@huma/path-creator`. Under the classification test this is as spatial as a kind gets — a
 * person places every control point — so it parents where spatial things parent and it draws.
 *
 * **The points are LOCAL to this node, and that is load-bearing.** The reader bakes the node's
 * world matrix into them when it builds the `BezierPath`, so the library always receives a
 * world-space path and every cart frame is world-space. That is what lets Pascal's own move
 * gizmo drag the whole rail — with Pascal's own undo — instead of this package inventing a rig
 * transform and threading it through the library's resolve context.
 *
 * The field names mirror `SerializedBezierPath` exactly, because `BezierPath.fromJSON` takes that
 * shape and a translation layer between two identical shapes is a place for them to drift.
 * Points are `{x,y,z}` objects for the same reason, even though every other vector on these kinds
 * is a tuple (tuples are what Pascal's `vec3` inspector field wants; a point list is never one).
 */
export const PathNode = BaseNode.extend({
  type: z.literal(PATH_KIND).default(PATH_KIND),
  /** Anchor/control points, interleaved as `BezierPath` stores them. Local to this node. */
  points: z.array(z.object({ x: z.number(), y: z.number(), z: z.number() })).default([]),
  perAnchorNormalsAngle: z.array(z.number()).default([]),
  isClosed: z.boolean().default(false),
  /** Which axes the path is free in. `xyz` is a full 3D rail; `xz` keeps it on the ground plane. */
  space: z.enum(["xyz", "xz", "xy"]).default("xyz"),
  controlMode: z.enum(["aligned", "mirrored", "free", "automatic"]).default("automatic"),
  /** Floored at 0.01 by `BezierPath` itself; the schema agrees rather than allowing a 0 it
   *  would silently raise. */
  autoControlLength: z.number().min(0.01).default(0.3),
  flipNormals: z.boolean().default(false),
  globalNormalsAngle: z.number().default(0),

  /** Sampling tolerances for the vertex path the runtime actually measures distance along. */
  maxAngleError: z.number().min(0).default(0.3),
  minVertexDistance: z.number().min(0).default(0.01),
  /** Fixed spacing in metres; 0 means adaptive (use `maxAngleError` instead). */
  spacing: z.number().min(0).default(0),

  /** Where the node sits. The points above are measured from here. */
  position: Vec3Tuple.default([0, 0, 0])
});
export type PathNodeType = z.infer<typeof PathNode>;

/**
 * A cart riding a rail — Cinemachine's dolly cart. It names its path by id, so moving or
 * reshaping the rail moves the cart with no edit here at all.
 *
 * It has no position, deliberately, and this is the one kind where that is interesting: a cart
 * IS placed by a person, but placed *along a path by distance* rather than in space. Its world
 * position is derived every frame from the rail, so storing one would create a second, always
 * stale answer to where it is. It still draws (the rail gizmo), so it parents at the root where
 * spatial things parent — trap 11's rule applies to anything that draws, not just to anything
 * with a position.
 *
 * `distance` here is the cart's RESTING place. Where it sits at time t is a cart track's
 * business; with no track it holds this distance.
 */
export const CartNode = BaseNode.extend({
  type: z.literal(CART_KIND).default(CART_KIND),
  /** Which clock a cart track for this cart is measured on. A field, like the shot's. */
  timelineId: z.string().default(""),
  /** The path node this cart rides. Empty means the cart is inert. */
  pathId: z.string().default(""),
  /** Resting distance along the rail, in metres. */
  distance: z.number().default(0),
  /** Metres per second, for the live (non-timeline) advance. 0 leaves it to the timeline. */
  speed: z.number().default(0),
  /** What happens at the end of the rail. */
  endOfPathInstruction: z.enum(["loop", "reverse", "stop"]).default("loop"),
  /**
   * `path-frame` banks with the rail (full frame), `path-yaw` follows the rail's heading with a
   * level horizon, `fixed` keeps a world orientation. All three, because the library has all
   * three — a narrower mirror would reject a document that used the one it left out.
   */
  orientationMode: z.enum(["path-frame", "path-yaw", "fixed"]).default("path-frame"),
  /** Rail-local offset — x along right, y along up, z along forward. */
  positionOffset: Vec3Tuple.default([0, 0, 0])
});
export type CartNodeType = z.infer<typeof CartNode>;
