// Purpose: Registers every node kind this app hosts, synchronously, at module import time —
// Pascal's 46 builtins (via registerNode with a has-guard, exactly as pascalorg/editor's own
// bootstrap does) and the three huma-time kinds (via registerPascalTimeKinds, which routes
// through loadPlugin so the per-project install gate applies). Runs in both the server and
// client module graphs; every call here is idempotent because HMR re-evaluates the module.
import { type AnyNodeDefinition, nodeRegistry, registerNode } from "@pascal-app/core";
import { builtinPlugin } from "@pascal-app/nodes";
import { registerPascalTimeKinds } from "@huma/pascal-time";
import { registerPascalTimeHostPanel } from "@huma/pascal-time/host-panel";

let builtinsLoaded = false;

function loadBuiltinsSync(): void {
  if (builtinsLoaded) return;
  builtinsLoaded = true;
  for (const def of builtinPlugin.nodes ?? []) {
    // The module-closure flag resets on HMR but the registry singleton persists, so the
    // has-guard is what keeps re-evaluation from throwing on the first duplicate kind.
    if (nodeRegistry.has((def as AnyNodeDefinition).kind)) continue;
    registerNode(def as AnyNodeDefinition);
  }
  if (process.env.NODE_ENV !== "production" && typeof console !== "undefined") {
    const kinds = Array.from(nodeRegistry.entries(), ([k]) => k);
    console.info(
      `[pascal:registry] loaded ${builtinPlugin.id} v${builtinPlugin.apiVersion} (${kinds.length} kinds)`,
    );
  }
}

loadBuiltinsSync();
registerPascalTimeKinds();
registerPascalTimeHostPanel();
