// The product's scene vocabulary as one Pascal plugin manifest. Loaded through `loadPlugin`,
// which is what records kind -> plugin id and therefore what makes the per-project install gate
// apply; `registerNode` alone bypasses the gate instead of satisfying it. Kinds are namespaced
// so they can never collide with Pascal's built-ins, and every renderer is a lazy module with a
// default export because a direct component reference is dropped without warning.
import type { NodeDefinition, Plugin } from "@pascal-app/core";
import { GlbModelNode, HotspotNode } from "./scene-kinds";

export const SCENE_PLUGIN_ID = "huma:presentation";

// Casts at the boundary: this workspace compiles with `exactOptionalPropertyTypes` and Pascal's
// published types do not, so the shapes match at runtime but not to our compiler.
export const glbModelDefinition = {
  kind: "huma:glb",
  schemaVersion: 1,
  schema: GlbModelNode,
  category: "furnish",
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    url: "",
    position: [0, 0, 0] as [number, number, number],
    rotationDeg: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number]
  }),
  renderer: { kind: "parametric", module: () => import("./glb-model-renderer") },
  capabilities: { selectable: { hitVolume: "bbox" }, duplicable: true, deletable: true }
} as unknown as NodeDefinition<typeof GlbModelNode>;

export const hotspotDefinition = {
  kind: "huma:hotspot",
  schemaVersion: 1,
  schema: HotspotNode,
  category: "analysis",
  defaults: () => ({
    object: "node" as const,
    parentId: null,
    visible: true,
    metadata: {},
    position: [0, 0, 0] as [number, number, number],
    label: "Hotspot",
    action: { cueId: "", transitionSeconds: 1.6 }
  }),
  renderer: { kind: "parametric", module: () => import("./hotspot-renderer") },
  capabilities: { selectable: { hitVolume: "bbox" }, duplicable: true, deletable: true }
} as unknown as NodeDefinition<typeof HotspotNode>;

export const presentationScenePlugin: Plugin = {
  id: SCENE_PLUGIN_ID,
  apiVersion: 1,
  nodes: [glbModelDefinition as never, hotspotDefinition as never]
};
