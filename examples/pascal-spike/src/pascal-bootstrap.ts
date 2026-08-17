// Registers Pascal's built-in node kinds into its global registry, as a module side effect,
// before any React tree renders — the same thing Pascal's own app bootstrap does, minus the
// external plugin discovery (which hits the network). Without this every NodeRenderer
// resolves to null and the scene is silently empty.
// Scope: spike harness only.
import { loadPlugin, nodeRegistry, registerNode, type AnyNodeDefinition } from "@pascal-app/core";
import { builtinPlugin } from "@pascal-app/nodes";
import { presentationScenePlugin } from "./scene-plugin";

let loaded = false;

export function loadPascalBuiltins(): string[] {
  if (!loaded) {
    loaded = true;
    for (const def of builtinPlugin.nodes ?? []) {
      const node = def as AnyNodeDefinition;
      // The registry is a module singleton that survives HMR while this flag does not,
      // and registerNode throws on a duplicate kind.
      if (!nodeRegistry.has(node.kind)) registerNode(node);
    }
    // Our own kinds go through `loadPlugin`, the documented path — that is what records
    // kind -> plugin id, which is what makes the per-project install gate (`isNodeKindEnabled`)
    // apply. Registering a definition directly bypasses the gate instead of satisfying it.
    if (!nodeRegistry.has("huma:glb")) loadPlugin(presentationScenePlugin);
  }
  return Array.from(nodeRegistry.entries(), ([kind]) => kind);
}
