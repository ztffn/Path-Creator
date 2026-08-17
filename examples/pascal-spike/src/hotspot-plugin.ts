// Q4: the hotspot as a Pascal plugin manifest. This is the feature that started the spike —
// world-anchored, so by rule R6 of the integration design it belongs to whoever owns space.
// Nothing here is special-cased: it is the same `Plugin` shape the built-in `pascal:core` pack
// uses, loaded through the same `loadPlugin`, which is the claim the plugin contract makes.
// Scope: spike harness proving the contract, not a shipped kind.
import type { NodeDefinition, Plugin } from "@pascal-app/core";
import { HotspotNode } from "./hotspot-schema";

export const HOTSPOT_PLUGIN_ID = "huma:hotspots";

// Cast at the boundary: this workspace compiles with `exactOptionalPropertyTypes` and Pascal's
// published types do not, so the shape matches exactly at runtime but not to our compiler.
// Recorded as an integration cost rather than hidden — see README Q4.
export const hotspotDefinition = {
  kind: "huma:hotspot",
  schemaVersion: 1,
  schema: HotspotNode,
  // 'analysis' is the closest of Pascal's five buckets for a non-structural annotation. A
  // hotspot is not really any of them; the vocabulary is architectural, as expected.
  category: "analysis",
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    position: [0, 0, 0] as [number, number, number],
    label: "Hotspot",
    action: { type: "seek" as const, seconds: 0 }
  }),
  // Must be a lazy module with a default export; a direct component reference is dropped.
  renderer: { kind: "parametric", module: () => import("./hotspot-renderer") },
  capabilities: {
    selectable: { hitVolume: "bbox" },
    duplicable: true,
    deletable: true
  }
} as unknown as NodeDefinition<typeof HotspotNode>;

export const humaHotspotPlugin: Plugin = {
  id: HOTSPOT_PLUGIN_ID,
  apiVersion: 1,
  nodes: [hotspotDefinition as never]
};
