// A node kind belonging to THIS harness, not to @huma/pascal-time — deliberately. The time
// layer's central claim is that it binds by node id and never asks what a thing is, and the
// cleanest way to demonstrate that is to drive a kind the time package has never heard of,
// contributed by a different plugin, with its own schema and its own renderer.
// Scope: harness scene vocabulary. Nothing here is shipped.
import { z } from "zod";
import { BaseNode, type NodeDefinition, type Plugin } from "@pascal-app/core";

export const HARNESS_PLUGIN_ID = "pascal-time-harness";
export const MARKER_KIND = "harness:marker";

const Vec3Tuple = z.tuple([z.number(), z.number(), z.number()]);

/** A coloured box at a position. Enough geometry to see, and to measure a drive against. */
export const MarkerNode = BaseNode.extend({
  type: z.literal(MARKER_KIND).default(MARKER_KIND),
  position: Vec3Tuple.default([0, 0, 0]),
  color: z.string().default("#38bdf8")
});
export type MarkerNodeType = z.infer<typeof MarkerNode>;

// Cast at the boundary: this workspace compiles with `exactOptionalPropertyTypes` and Pascal's
// published definition types do not. Same reason, same shape, as the cast in the package.
export const markerDefinition = {
  kind: MARKER_KIND,
  schemaVersion: 1,
  schema: MarkerNode,
  category: "furnish",
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    position: [0, 0, 0] as [number, number, number],
    color: "#38bdf8"
  }),
  renderer: { kind: "parametric", module: () => import("./marker-renderer") },
  capabilities: {
    selectable: { hitVolume: "bbox" },
    movable: { axes: ["x", "y", "z"] as const },
    deletable: true,
    duplicable: true
  }
} as unknown as NodeDefinition<typeof MarkerNode>;

export const harnessPlugin: Plugin = {
  id: HARNESS_PLUGIN_ID,
  apiVersion: 1,
  nodes: [markerDefinition as never]
};
