// The kinds of `kinds.ts` expressed as Pascal node definitions, and the plugin manifest that
// carries them. Four details here are load-bearing and every one of them fails silently if got
// wrong: the renderer must be a lazy module with a default export, registration must go through
// `loadPlugin`, the plugin id must be installed on the scene, and the whole thing must run at
// module import time. Scope: the Pascal-facing boundary; nothing in here knows about time.
import type { NodeDefinition, Plugin } from "@pascal-app/core";
import { PASCAL_TIME_PLUGIN_ID, TIMELINE_KIND, TimelineNode } from "./kinds";

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
    autoplay: false
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

/**
 * The manifest. `apiVersion` is Pascal's plugin contract version, not ours.
 */
export const pascalTimePlugin: Plugin = {
  id: PASCAL_TIME_PLUGIN_ID,
  apiVersion: 1,
  nodes: [timelineDefinition as never]
};
