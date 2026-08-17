// The node kinds this product actually needs, as a Pascal plugin: a GLB placed in space, and
// a hotspot. Pascal ships 46 architectural kinds (walls, slabs, ducts) and none of them are
// these — the point of the plugin contract is that we contribute our own vocabulary and take
// only the infrastructure underneath: node registry, schema + migrations, store, undo,
// hierarchy, and the id -> Object3D registry the timeline binds to.
import { z } from "zod";
import { BaseNode } from "@pascal-app/core";

const Vec3Tuple = z.tuple([z.number(), z.number(), z.number()]);

/**
 * A GLB placed in the scene. This is the whole scene vocabulary for a presentation: models at
 * transforms. Everything time-varying about it — when it moves, when it is visible — lives in
 * the timeline and references this node by id, never in here.
 */
export const GlbModelNode = BaseNode.extend({
  type: z.literal("huma:glb").default("huma:glb"),
  url: z.string().default(""),
  position: Vec3Tuple.default([0, 0, 0]),
  rotationDeg: Vec3Tuple.default([0, 0, 0]),
  scale: Vec3Tuple.default([1, 1, 1])
});
export type GlbModelNodeType = z.infer<typeof GlbModelNode>;

/**
 * A clickable point bound to a timeline action. Per the integration design's classification
 * test it is a scene node (a person places it, it exists without a timeline) whose *action* is
 * the time layer's. `action` is opaque to Pascal — it round-trips it like a wall's thickness.
 */
export const HotspotAction = z.object({
  /** Which cue to jump to. Cues are the product's "slides". */
  cueId: z.string().default(""),
  transitionSeconds: z.number().default(1.6)
});

export const HotspotNode = BaseNode.extend({
  type: z.literal("huma:hotspot").default("huma:hotspot"),
  position: Vec3Tuple.default([0, 0, 0]),
  label: z.string().default("Hotspot"),
  action: HotspotAction.default({ cueId: "", transitionSeconds: 1.6 })
});
export type HotspotNodeType = z.infer<typeof HotspotNode>;

/** Clicks captured by the hotspot renderer; the product layer drains these into the player. */
export const hotspotClicks: Array<{ id: string; action: HotspotNodeType["action"] }> = [];
