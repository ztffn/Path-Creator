// The node kinds this plugin contributes to Pascal's vocabulary. Pascal ships 46
// architectural kinds and none of them can move; these are the ones time needs. Kinds are
// namespaced under the plugin id so they can never collide with Pascal's built-ins, and the
// fields here are the only thing Pascal persists — it round-trips them as opaque node data,
// exactly as it round-trips a wall's thickness. Scope: schema only, no runtime behaviour.
import { z } from "zod";
import { BaseNode } from "@pascal-app/core";

/** Plugin id. Recorded by `loadPlugin` and gated per project by `installedPlugins`. */
export const PASCAL_TIME_PLUGIN_ID = "huma-time";

export const TIMELINE_KIND = "huma-time:timeline";

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
  autoplay: z.boolean().default(false)
});
export type TimelineNodeType = z.infer<typeof TimelineNode>;
