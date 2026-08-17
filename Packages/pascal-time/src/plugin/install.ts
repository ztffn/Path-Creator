// Registration: the two calls that make this plugin's kinds real, and the order they must
// happen in. `registerPascalTimeKinds` puts the kinds in Pascal's registry and records which
// plugin owns them; `installPascalTimeOnScene` opts a scene document into them. Both are
// idempotent, because React strict mode mounts effects twice and hosts re-enter bootstrap.
// Scope: the plugin's front door — a host calls these two functions and nothing else.
import { loadPlugin, nodeRegistry, useScene } from "@pascal-app/core";
import { PASCAL_TIME_PLUGIN_ID, TIMELINE_KIND } from "./kinds";
import { pascalTimePlugin } from "./definitions";

/**
 * Registers the plugin's node kinds. **Call this at module import time**, before any React
 * tree renders — Pascal's viewer resolves nodes against the registry on its first pass, so a
 * kind registered from an effect leaves every node of that kind resolving to null for the
 * first render, which the viewer warns about but does not recover from.
 *
 * It goes through `loadPlugin` rather than `registerNode` because only `loadPlugin` records
 * the kind-to-plugin mapping that `isNodeKindEnabled` consults. Registering a definition
 * directly does not satisfy the per-project install gate, it *bypasses* it — the kind then
 * works everywhere including scenes that never opted in, which is the opposite of the intent.
 */
export function registerPascalTimeKinds(): void {
  if (nodeRegistry.has(TIMELINE_KIND)) return;
  // `loadPlugin` is declared async but its body has no await before the registration loop,
  // so the kinds are live by the time this returns and callers need not await. The promise is
  // still worth attaching a handler to: an apiVersion mismatch throws inside it, and an
  // unawaited rejection would surface as an unhandled promise rejection with no stack
  // pointing back here.
  void loadPlugin(pascalTimePlugin).catch((error: unknown) => {
    console.error(`[pascal-time] plugin "${PASCAL_TIME_PLUGIN_ID}" failed to load`, error);
  });
}

/**
 * Opts a scene document into this plugin's kinds. Namespaced kinds are gated per project:
 * without the plugin id in the scene's `installedPlugins`, a kind-aware renderer refuses to
 * draw the node and nothing says why.
 *
 * Additive on purpose. `setInstalledPlugins` replaces the whole list, so a host running two
 * plugins that each called it with only their own id would leave the second one installed and
 * the first silently uninstalled. Merging is the behaviour a plugin shipped for other people
 * to consume has to have.
 */
export function installPascalTimeOnScene(scene: typeof useScene = useScene): void {
  const state = scene.getState();
  if (state.installedPlugins.includes(PASCAL_TIME_PLUGIN_ID)) return;
  state.setInstalledPlugins([...state.installedPlugins, PASCAL_TIME_PLUGIN_ID], { explicit: true });
}
