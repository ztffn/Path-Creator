// The authoring entry point: `@huma/pascal-time/host-panel`. Editor-coupled and therefore
// Next-coupled — it imports @pascal-app/editor, which the runtime entry must NEVER do; that
// split is the deployment boundary the whole two-app topology rests on (plan §0b). A host that
// uses Pascal's editor calls registerPascalTimeHostPanel() at bootstrap, next to the manifest
// registration; hosts that only play timelines never import this entry.
import { editorHostPanelRegistry, registerEditorHostPanel } from "@pascal-app/editor";
import { CUE_KIND, PASCAL_TIME_PLUGIN_ID, SHOT_KIND, TIMELINE_KIND } from "../plugin/kinds";

export const PASCAL_TIME_PANEL_ID = "huma-time:timeline-panel";

/**
 * Registers the timeline panel with the editor's host-panel registry. Idempotent — the registry
 * throws on a duplicate id in production (and warns under HMR), and bootstrap modules re-run.
 *
 * `component` is a lazy module with a DEFAULT export — the same shape as `def.renderer`, and
 * the same silent failure if got wrong: the rail button appears, the panel body stays blank.
 * `defaultInstalled` opts the plugin into scenes with no explicit plugin-install state, which
 * is what makes the panel show up in a fresh scene without a manual install step.
 */
export function registerPascalTimeHostPanel(): void {
  if (editorHostPanelRegistry.getSnapshot().some((panel) => panel.id === PASCAL_TIME_PANEL_ID)) {
    return;
  }
  registerEditorHostPanel({
    id: PASCAL_TIME_PANEL_ID,
    pluginId: PASCAL_TIME_PLUGIN_ID,
    label: "Timeline",
    description: "Keyframes, cues and camera shots over the scene's clock.",
    creator: { name: "huma" },
    // Self-contained glyph (three lane bars and a playhead wedge) rather than an iconify name,
    // which would fetch icon data from the network at runtime — a headless check must not
    // depend on a CDN being reachable.
    icon: {
      kind: "svg",
      viewBox: "0 0 24 24",
      path: "M3 5h12v2.5H3zM3 10.75h8v2.5H3zM3 16.5h5V19H3zM16 10.5l6 3.5-6 3.5z"
    },
    component: async () => import("./panel"),
    kinds: [TIMELINE_KIND, CUE_KIND, SHOT_KIND],
    defaultInstalled: true
  });
}
