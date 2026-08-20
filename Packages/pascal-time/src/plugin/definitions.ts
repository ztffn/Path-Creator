// The kinds of `kinds.ts` expressed as Pascal node definitions, and the plugin manifest that
// carries them. Four details here are load-bearing and every one of them fails silently if got
// wrong: the renderer must be a lazy module with a default export, registration must go through
// `loadPlugin`, the plugin id must be installed on the scene, and the whole thing must run at
// module import time. Scope: the Pascal-facing boundary; nothing in here knows about time.
import type { NodeDefinition, Plugin } from "@pascal-app/core";
import {
  CART_KIND, CartNode, CUE_KIND, CueNode, PASCAL_TIME_PLUGIN_ID, PATH_KIND, PathNode,
  SHOT_KIND, ShotNode, TIMELINE_KIND, TimelineNode
} from "./kinds";
import { TRACK_PAYLOAD_VERSION } from "./tracks";

/**
 * Cast at the boundary, once, deliberately. This workspace compiles with
 * `exactOptionalPropertyTypes` and Pascal's published definition types do not, so an optional
 * field Pascal declares as `x?: T` is `x?: T | undefined` to us and the shapes stop matching at
 * the type level while remaining identical at runtime. Casting here keeps the strictness for
 * every other file in the package rather than relaxing the whole compiler for one mismatch.
 */
export const timelineDefinition = {
  kind: TIMELINE_KIND,
  schemaVersion: 1,
  schema: TimelineNode,
  // One of five architectural buckets, none of which is "time". `analysis` is the closest
  // fit and the mismatch is cosmetic — it decides which drawer the editor files the kind in.
  category: "analysis",
  // Organisational kind: no geometry, no system, nothing rebuilds it on a dirty mark. Pascal
  // documents this flag for exactly this class (site, building, level, zone, guide); without
  // it the node's marks accumulate for the session and defeat every consumer's early exit.
  dirtyTracking: false,
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    durationSeconds: 10,
    loop: false,
    autoplay: false,
    tracks: [],
    trackPayloadVersion: TRACK_PAYLOAD_VERSION
  }),
  renderer: { kind: "parametric", module: () => import("../render/timeline-renderer") },
  // Inspector title, tree label. Hidden from the build palette: the timeline panel is the
  // creation surface for every kind here, and a palette button with no placement tool is a
  // dead affordance. Icons are self-contained svg paths — an iconify name would fetch from a
  // CDN at runtime, which a headless check must not depend on.
  presentation: {
    label: "Timeline",
    icon: { kind: "svg", viewBox: "0 0 24 24", path: "M3 5h12v2.5H3zM3 10.75h8v2.5H3zM3 16.5h5V19H3zM16 10.5l6 3.5-6 3.5z" },
    hidden: true
  },
  // The inspector is NOT derived from the Zod schema — it comes from this hand-declared
  // descriptor, and a kind without one has no inspector at all. Tracks and the payload
  // version are deliberately absent: they are the panel's surface, not field-editable data.
  parametrics: {
    groups: [
      {
        label: "Clock",
        fields: [
          { key: "durationSeconds", kind: "number", unit: "s", min: 0.1, step: 0.5 },
          { key: "loop", kind: "boolean" },
          { key: "autoplay", kind: "boolean" }
        ]
      }
    ]
  },
  // Parametrics makes a kind presettable by default; a preset of the scene's one clock is
  // meaningless, so opt out explicitly.
  presettable: false,
  capabilities: {
    // Selectable from the hierarchy, never hit-tested in the viewport — there is no geometry
    // to click, and a bbox around an empty group would be a target the author cannot see.
    selectable: { hitVolume: "none" },
    deletable: true,
    // One clock per scene. Duplicating it would produce a second, equally authoritative
    // timeline with no rule for which one a track belongs to.
    duplicable: false
  }
} as unknown as NodeDefinition<typeof TimelineNode>;

/** Same boundary cast as above, same reason. */
export const cueDefinition = {
  kind: CUE_KIND,
  schemaVersion: 1,
  schema: CueNode,
  category: "analysis",
  // Organisational, like the timeline: no geometry, nothing rebuilds it on a dirty mark.
  dirtyTracking: false,
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    timeSeconds: 0
  }),
  // NO renderer, deliberately. `def.renderer` is optional and `<NodeRenderer>` null-guards it,
  // and a cue is a moment rather than a thing — there is no geometry to draw. It would also be
  // unreachable if it existed: Pascal's `<NodeRenderer>` renders a node's OWN renderer and does
  // not dispatch children, so anything parented to the timeline node only mounts if the
  // timeline's renderer dispatches it, which it does not. Shipping a renderer here would be
  // dead code that looks alive. See the README's trap 11, which M1.4 has to decide on.
  presentation: {
    label: "Cue",
    icon: { kind: "svg", viewBox: "0 0 24 24", path: "M12 4l7 8-7 8-7-8z" },
    hidden: true
  },
  parametrics: {
    groups: [{ label: "Cue", fields: [{ key: "timeSeconds", kind: "number", unit: "s", min: 0, step: 0.1 }] }]
  },
  presettable: false,
  capabilities: {
    // Selectable from the hierarchy, never hit-tested — a moment has nothing to click in a
    // viewport, and the author picks it from the tree or, later, from the timeline panel.
    selectable: { hitVolume: "none" },
    deletable: true,
    // Unlike the timeline, a scene wants many of these, and duplicating one to retime it is a
    // reasonable way to author. Fresh ids on clone are correct here — a cue is addressed by
    // its own id, and nothing else in the document references it by identity yet. When
    // hotspots start naming cue ids (M1.5 consumers do), the clone remap of M1.6 covers it.
    duplicable: true
  }
} as unknown as NodeDefinition<typeof CueNode>;

/** The shot fields the inspector's `visibleIf` predicates read. Hand-declared, like the rest of
 *  the descriptor — the definition is cast at the boundary, so tsc cannot check these keys and a
 *  spec pins every one of them against `defaults()` instead. */
type ShotFields = {
  body?: string;
  pathId?: string;
  aimMode?: string;
  composerEnabled?: boolean;
  animateFov?: boolean;
  noiseEnabled?: boolean;
};

/**
 * The shot: the one kind here an author places, so the one with a position, a renderer, a
 * gizmo and ordinary spatial capabilities. It parents where spatial things parent — not under
 * the timeline — which is both correct under the classification test and the reason it dodges
 * the container problem in trap 11.
 */
export const shotDefinition = {
  kind: SHOT_KIND,
  schemaVersion: 1,
  schema: ShotNode,
  category: "analysis",
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    timelineId: "",
    timeSeconds: 0,
    endSeconds: 0,
    blendSeconds: 1,
    body: "static" as const,
    position: [0, 2, 6] as [number, number, number],
    rotationDeg: [0, 0, 0] as [number, number, number],
    cartId: "",
    cartOffset: [0, 0, 0] as [number, number, number],
    targetNodeId: "",
    targetPoint: [0, 0, 0] as [number, number, number],
    azimuthDeg: 25,
    elevationDeg: 18,
    radius: 8,
    fov: 50,
    // M1.8. The composer block mirrors DEFAULT_COMPOSER_SETTINGS field for field; a spec pins
    // them together, because a drift here would frame every composed shot differently from the
    // library's own default and nothing would report it.
    blendCurve: "easeInOut",
    animateFov: false,
    fovEnd: 50,
    fovEasing: "easeInOut",
    aimMode: "body" as const,
    aimTargetNodeId: "",
    aimTargetPoint: [0, 0, 0] as [number, number, number],
    composerEnabled: false,
    composerScreenX: 0,
    composerScreenY: 0,
    composerDeadWidth: 0.18,
    composerDeadHeight: 0.14,
    composerSoftWidth: 0.55,
    composerSoftHeight: 0.45,
    composerDampingX: 6,
    composerDampingY: 8,
    composerTargetOffset: [0, 0, 0] as [number, number, number],
    composerLookaheadTime: 0.2,
    composerLookaheadSmoothing: 8,
    composerLookaheadIgnoreY: false,
    composerCenterOnActivate: false,
    noiseEnabled: false,
    noiseSeed: 1,
    noisePositionAmplitude: [0.02, 0.02, 0.02] as [number, number, number],
    noisePositionFrequency: [1, 1, 1] as [number, number, number],
    noiseRotationAmplitudeDeg: [0.2, 0.2, 0.1] as [number, number, number],
    noiseRotationFrequencyDeg: [1, 1, 1] as [number, number, number]
  }),
  renderer: { kind: "parametric", module: () => import("../render/shot-renderer") },
  presentation: {
    label: "Shot",
    icon: { kind: "svg", viewBox: "0 0 24 24", path: "M4 7h10v10H4zM14 10l6-3v10l-6-3z" },
    hidden: true
  },
  // Declarative fields only — no custom components, because a parametrics component ships in
  // the MANIFEST entry and this package's manifest depends on core alone. `targetNodeId` has
  // no declarative field kind (there is no free-text field, and `ref` filters by one kind);
  // the panel owns it with a use-the-viewport-selection affordance instead.
  parametrics: {
    groups: [
      {
        label: "Timing",
        fields: [
          { key: "timeSeconds", kind: "number", unit: "s", min: 0, step: 0.1 },
          // The block's end. Reaching past the next shot's start is what authors a crossover —
          // the overlap IS the blend, so there is no separate blend duration to set.
          // `blendSeconds` is legacy: nothing authors it, and it is deliberately not here.
          { key: "endSeconds", kind: "number", unit: "s", min: 0, step: 0.1 }
        ]
      },
      {
        label: "Camera",
        fields: [
          { key: "body", kind: "enum", options: ["static", "orbit", "cart"], display: "segmented" },
          { key: "fov", kind: "number", unit: "°", min: 1, max: 179, step: 1 },
          // A FOV push: `fov` is the start, `fovEnd` the end, eased across the shot's own
          // window. The curve itself has no declarative field kind, so the panel owns it.
          { key: "animateFov", kind: "boolean" },
          {
            key: "fovEnd",
            kind: "number",
            unit: "°",
            min: 1,
            max: 179,
            step: 1,
            visibleIf: (n: ShotFields) => n.animateFov === true
          }
        ]
      },
      {
        label: "Static",
        fields: [
          { key: "position", kind: "vec3", visibleIf: (n: { body: string }) => n.body === "static" },
          { key: "rotationDeg", kind: "vec3", visibleIf: (n: { body: string }) => n.body === "static" }
        ]
      },
      {
        label: "Orbit",
        fields: [
          { key: "targetPoint", kind: "vec3", visibleIf: (n: { body: string }) => n.body === "orbit" },
          { key: "radius", kind: "number", unit: "m", min: 0, step: 0.5, visibleIf: (n: { body: string }) => n.body === "orbit" },
          { key: "azimuthDeg", kind: "number", unit: "°", step: 1, visibleIf: (n: { body: string }) => n.body === "orbit" },
          { key: "elevationDeg", kind: "number", unit: "°", step: 1, visibleIf: (n: { body: string }) => n.body === "orbit" }
        ]
      },
      {
        // The rail body (M1.7). `cartId` is absent for the same reason every other node
        // reference here is: no free-text field kind, and `ref` filters by a single kind.
        label: "Cart",
        fields: [
          { key: "cartOffset", kind: "vec3", visibleIf: (n: ShotFields) => n.body === "cart" }
        ]
      },
      {
        // Where the shot LOOKS, independent of where it is. `aimTargetNodeId` is absent for the
        // same reason `targetNodeId` is: no free-text field kind, and `ref` filters by a single
        // node kind, which "anything you might watch" is not. The panel owns both.
        label: "Aim",
        fields: [
          { key: "aimMode", kind: "enum", options: ["body", "track"], display: "segmented" },
          { key: "aimTargetPoint", kind: "vec3", visibleIf: (n: ShotFields) => n.aimMode === "track" },
          { key: "composerEnabled", kind: "boolean", visibleIf: (n: ShotFields) => n.aimMode === "track" }
        ]
      },
      {
        // The damped framing profile. Only reachable with a track aim AND the composer on: with
        // the composer off the aim is an instant look-at and none of these do anything, so
        // showing them would advertise settings that cannot bite.
        label: "Composer",
        fields: (
          [
            { key: "composerScreenX", kind: "number", min: -0.5, max: 0.5, step: 0.01 },
            { key: "composerScreenY", kind: "number", min: -0.5, max: 0.5, step: 0.01 },
            { key: "composerDeadWidth", kind: "number", min: 0, max: 1, step: 0.01 },
            { key: "composerDeadHeight", kind: "number", min: 0, max: 1, step: 0.01 },
            { key: "composerSoftWidth", kind: "number", min: 0, max: 1, step: 0.01 },
            { key: "composerSoftHeight", kind: "number", min: 0, max: 1, step: 0.01 },
            { key: "composerDampingX", kind: "number", min: 0, step: 0.5 },
            { key: "composerDampingY", kind: "number", min: 0, step: 0.5 },
            { key: "composerTargetOffset", kind: "vec3" },
            { key: "composerLookaheadTime", kind: "number", unit: "s", min: 0, step: 0.05 },
            { key: "composerLookaheadSmoothing", kind: "number", min: 0, step: 0.5 },
            { key: "composerLookaheadIgnoreY", kind: "boolean" },
            { key: "composerCenterOnActivate", kind: "boolean" }
          ] as { key: string; kind: string; unit?: string; min?: number; max?: number; step?: number }[]
        ).map((field) => ({
          ...field,
          visibleIf: (n: ShotFields) => n.aimMode === "track" && n.composerEnabled === true
        }))
      },
      {
        // Seeded wobble. Pure in the resolve clock, so it never costs scrub-exactness.
        label: "Noise",
        fields: [
          { key: "noiseEnabled", kind: "boolean" },
          { key: "noiseSeed", kind: "number", step: 1, visibleIf: (n: ShotFields) => n.noiseEnabled === true },
          { key: "noisePositionAmplitude", kind: "vec3", visibleIf: (n: ShotFields) => n.noiseEnabled === true },
          { key: "noisePositionFrequency", kind: "vec3", visibleIf: (n: ShotFields) => n.noiseEnabled === true },
          { key: "noiseRotationAmplitudeDeg", kind: "vec3", visibleIf: (n: ShotFields) => n.noiseEnabled === true },
          { key: "noiseRotationFrequencyDeg", kind: "vec3", visibleIf: (n: ShotFields) => n.noiseEnabled === true }
        ]
      }
    ]
  },
  presettable: false,
  capabilities: {
    selectable: { hitVolume: "bbox" },
    movable: { axes: ["x", "y", "z"] as const },
    rotatable: {},
    deletable: true,
    duplicable: true
  }
} as unknown as NodeDefinition<typeof ShotNode>;


/**
 * The rail. Fully spatial: an author places every control point, and Pascal's own move and rotate
 * gizmos transform the whole thing — the reader folds this node's world matrix into its local
 * points, so the library receives a world-space path and needs no rig transform of its own.
 *
 * `points` and `perAnchorNormalsAngle` are deliberately absent from the inspector: they are
 * lists, there is no field kind for one, and the surface for editing them is the viewport (the
 * library's `PathEditor`, mounted by the host) with the panel for add/remove.
 */
export const pathDefinition = {
  kind: PATH_KIND,
  schemaVersion: 1,
  schema: PathNode,
  category: "analysis",
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    points: [],
    perAnchorNormalsAngle: [],
    isClosed: false,
    space: "xyz" as const,
    controlMode: "automatic" as const,
    autoControlLength: 0.3,
    flipNormals: false,
    globalNormalsAngle: 0,
    maxAngleError: 0.3,
    minVertexDistance: 0.01,
    spacing: 0,
    position: [0, 0, 0] as [number, number, number]
  }),
  renderer: { kind: "parametric", module: () => import("../render/path-renderer") },
  presentation: {
    label: "Path",
    icon: { kind: "svg", viewBox: "0 0 24 24", path: "M4 18c4-10 12 2 16-10" },
    hidden: true
  },
  parametrics: {
    groups: [
      {
        label: "Shape",
        fields: [
          { key: "position", kind: "vec3" },
          { key: "isClosed", kind: "boolean" },
          // Constrains the axes an author can drag a point in: `xz` keeps a rail on the ground.
          { key: "space", kind: "enum", options: ["xyz", "xz", "xy"], display: "segmented" },
          {
            key: "controlMode",
            kind: "enum",
            options: ["automatic", "aligned", "mirrored", "free"]
          },
          { key: "autoControlLength", kind: "number", unit: "m", min: 0.01, step: 0.05 }
        ]
      },
      {
        // How finely the curve is walked into the vertex path distance is measured along. These
        // decide how faithfully a cart follows a tight corner.
        label: "Sampling",
        fields: [
          { key: "maxAngleError", kind: "number", unit: "°", min: 0, step: 0.05 },
          { key: "minVertexDistance", kind: "number", unit: "m", min: 0, step: 0.01 },
          { key: "spacing", kind: "number", unit: "m", min: 0, step: 0.1 }
        ]
      },
      {
        label: "Normals",
        fields: [
          { key: "flipNormals", kind: "boolean" },
          { key: "globalNormalsAngle", kind: "number", unit: "°", step: 1 }
        ]
      }
    ]
  },
  presettable: false,
  capabilities: {
    selectable: { hitVolume: "bbox" },
    // Moving and rotating the rail as a whole is Pascal's job, with Pascal's undo — which is the
    // entire reason the points are stored local and baked to world on read.
    movable: { axes: ["x", "y", "z"] as const },
    rotatable: {},
    deletable: true,
    duplicable: true
  }
} as unknown as NodeDefinition<typeof PathNode>;

/**
 * The cart. It draws, so it lives where spatial things live (trap 11 applies to anything that
 * draws, not only to anything with a position) — but it has NO position field and is NOT movable,
 * because its world position is derived from its rail every frame. Storing one would be a second,
 * always stale answer to where it is. An author moves it by `distance`, or by a cart track.
 */
export const cartDefinition = {
  kind: CART_KIND,
  schemaVersion: 1,
  schema: CartNode,
  category: "analysis",
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    timelineId: "",
    pathId: "",
    distance: 0,
    speed: 0,
    endOfPathInstruction: "loop" as const,
    orientationMode: "path-frame" as const,
    positionOffset: [0, 0, 0] as [number, number, number]
  }),
  renderer: { kind: "parametric", module: () => import("../render/cart-renderer") },
  presentation: {
    label: "Cart",
    icon: { kind: "svg", viewBox: "0 0 24 24", path: "M3 16c4-8 14-8 18 0M8 16a2 2 0 104 0 2 2 0 10-4 0" },
    hidden: true
  },
  parametrics: {
    groups: [
      {
        label: "Ride",
        fields: [
          { key: "distance", kind: "number", unit: "m", step: 0.1 },
          { key: "speed", kind: "number", unit: "m/s", step: 0.1 },
          {
            key: "endOfPathInstruction",
            kind: "enum",
            options: ["loop", "reverse", "stop"],
            display: "segmented"
          },
          { key: "orientationMode", kind: "enum", options: ["path-frame", "path-yaw", "fixed"] },
          { key: "positionOffset", kind: "vec3" }
        ]
      }
    ]
  },
  presettable: false,
  capabilities: {
    selectable: { hitVolume: "bbox" },
    deletable: true,
    // Duplicating a cart to run a second camera along the same rail is a reasonable way to
    // author. The clone remap rebinds `pathId` only when the PATH was cloned too.
    duplicable: true
  }
} as unknown as NodeDefinition<typeof CartNode>;

/**
 * The manifest. `apiVersion` is Pascal's plugin contract version, not ours.
 */
export const pascalTimePlugin: Plugin = {
  id: PASCAL_TIME_PLUGIN_ID,
  apiVersion: 1,
  nodes: [
    timelineDefinition as never,
    cueDefinition as never,
    shotDefinition as never,
    pathDefinition as never,
    cartDefinition as never
  ]
};
