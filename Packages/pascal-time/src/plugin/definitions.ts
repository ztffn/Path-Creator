// The kinds of `kinds.ts` expressed as Pascal node definitions, and the plugin manifest that
// carries them. Four details here are load-bearing and every one of them fails silently if got
// wrong: the renderer must be a lazy module with a default export, registration must go through
// `loadPlugin`, the plugin id must be installed on the scene, and the whole thing must run at
// module import time. Scope: the Pascal-facing boundary; nothing in here knows about time.
import type { NodeDefinition, Plugin } from "@pascal-app/core";
import {
  CUE_KIND, CueNode, PASCAL_TIME_PLUGIN_ID, SHOT_KIND, ShotNode, TIMELINE_KIND, TimelineNode
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
    blendSeconds: 1,
    body: "static" as const,
    position: [0, 2, 6] as [number, number, number],
    rotationDeg: [0, 0, 0] as [number, number, number],
    targetNodeId: "",
    targetPoint: [0, 0, 0] as [number, number, number],
    azimuthDeg: 25,
    elevationDeg: 18,
    radius: 8,
    fov: 50
  }),
  renderer: { kind: "parametric", module: () => import("../render/shot-renderer") },
  capabilities: {
    selectable: { hitVolume: "bbox" },
    movable: { axes: ["x", "y", "z"] as const },
    rotatable: {},
    deletable: true,
    duplicable: true
  }
} as unknown as NodeDefinition<typeof ShotNode>;

/**
 * The manifest. `apiVersion` is Pascal's plugin contract version, not ours.
 */
export const pascalTimePlugin: Plugin = {
  id: PASCAL_TIME_PLUGIN_ID,
  apiVersion: 1,
  nodes: [timelineDefinition as never, cueDefinition as never, shotDefinition as never]
};
