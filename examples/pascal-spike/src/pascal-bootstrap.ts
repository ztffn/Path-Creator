// Registers this product's node kinds, at module import time — before any React tree renders,
// which Pascal's registry requires. Pascal's own 46 architectural kinds are NOT loaded: we take
// the node infrastructure (registry, schemas, store, undo, hierarchy, id -> Object3D registry)
// and contribute our own vocabulary, so `@pascal-app/core` is the only Pascal dependency.
// Scope: prototype bootstrap.
import { loadPlugin, nodeRegistry } from "@pascal-app/core";
import { presentationScenePlugin } from "./scene-plugin";

let loaded = false;

export function loadSceneKinds(): string[] {
  if (!loaded) {
    loaded = true;
    // `loadPlugin` (not `registerNode`) is what records kind -> plugin id, which is what makes
    // the per-project install gate apply rather than be bypassed.
    if (!nodeRegistry.has("huma:glb")) loadPlugin(presentationScenePlugin);
  }
  return Array.from(nodeRegistry.entries(), ([kind]) => kind);
}
