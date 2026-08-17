// The authored content of the prototype, in one place: the scene Pascal owns (GLB models and
// hotspots), and the cues and shots the timeline owns. Kept separate from the runtime so the
// split is visible — everything above the line is "what exists, where", everything below is
// "when, and from what angle". In the product both halves come from saved documents.
// Scope: prototype fixture.
import type { NodeRegistry } from "@pascal-app/core";
import type { VirtualCameraDefinition } from "@huma/path-creator/core";
import type { Cue } from "./cues";
import { SCENE_PLUGIN_ID } from "./scene-plugin";

export const TRANSITION_SECONDS = 1.8;

const MODEL_URL = "/Fox.glb";

/** Where each model sits. Ids are the contract with the timeline — stable, never derived. */
const MODELS = [
  { id: "model_a", name: "Left subject", position: [-4, 0, 0] as [number, number, number] },
  { id: "model_b", name: "Centre subject", position: [0, 0, -3] as [number, number, number] },
  { id: "model_c", name: "Right subject", position: [4, 0, 0] as [number, number, number] }
];

/** Slides. A cue is only a name and a time; the camera work is separate, below. */
export const CUES: Cue[] = [
  { id: "overview", name: "The whole stage", time: 0 },
  { id: "left", name: "Left subject", time: 5 },
  { id: "centre", name: "Centre subject", time: 10 },
  { id: "right", name: "Right subject", time: 15 }
];

/**
 * One shot per cue. Each is an orbit bound to a scene node BY ID, which is the only thing the
 * time layer knows about the scene — move the model in Pascal and the shot follows, with no
 * timeline edit. The overview orbits a point instead, because it frames the stage, not a thing.
 */
export const SHOTS: Array<{ time: number; definition: VirtualCameraDefinition }> = [
  {
    time: 0,
    definition: {
      id: "shot_overview",
      body: { type: "orbit", target: { x: 0, y: 0.8, z: -1 }, azimuthDeg: 25, elevationDeg: 24, radius: 14, binding: "world", autoOrbitDegPerSec: 4 },
      aim: { type: "body" },
      lens: { fov: 50 }
    }
  },
  {
    time: 5,
    definition: {
      id: "shot_left",
      body: { type: "orbit", target: { targetId: "model_a" }, azimuthDeg: -40, elevationDeg: 14, radius: 4.5, binding: "world" },
      aim: { type: "body" },
      lens: { fov: 38 }
    }
  },
  {
    time: 10,
    definition: {
      id: "shot_centre",
      body: { type: "orbit", target: { targetId: "model_b" }, azimuthDeg: 15, elevationDeg: 10, radius: 3.6, binding: "world" },
      aim: { type: "body" },
      lens: { fov: 34 }
    }
  },
  {
    time: 15,
    definition: {
      id: "shot_right",
      body: { type: "orbit", target: { targetId: "model_c" }, azimuthDeg: 60, elevationDeg: 18, radius: 4.5, binding: "world" },
      aim: { type: "body" },
      lens: { fov: 38 }
    }
  }
];

interface SceneStoreLike {
  nodes: Record<string, unknown>;
  createNode: (node: unknown, parentId?: unknown) => void;
  setInstalledPlugins: (ids: string[], options?: { explicit?: boolean }) => void;
  loadScene: () => void;
}

/**
 * Builds the scene in Pascal's store: the models, and a hotspot beside each one wired to that
 * model's cue. Idempotent — React strict mode mounts effects twice.
 */
export function buildPresentationScene(store: SceneStoreLike, registry: NodeRegistry): void {
  if (Object.keys(store.nodes).length === 0) store.loadScene();
  // A namespaced kind is gated per project; without this the renderer refuses it silently.
  store.setInstalledPlugins([SCENE_PLUGIN_ID], { explicit: true });

  const site = Object.values(store.nodes).find(
    (n) => (n as { type?: string }).type === "site"
  ) as { id: string } | undefined;
  if (!site) return;

  const glb = registry.get("huma:glb");
  const hotspot = registry.get("huma:hotspot");
  if (!glb || !hotspot) return;

  MODELS.forEach((model, index) => {
    if (!store.nodes[model.id]) {
      store.createNode({
        ...(glb.defaults?.() ?? {}),
        id: model.id, type: "huma:glb", parentId: site.id, name: model.name,
        url: MODEL_URL, position: model.position, scale: [0.04, 0.04, 0.04]
      }, site.id);
    }
    const markerId = `${model.id}_marker`;
    if (!store.nodes[markerId]) {
      store.createNode({
        ...(hotspot.defaults?.() ?? {}),
        id: markerId, type: "huma:hotspot", parentId: site.id,
        label: model.name,
        position: [model.position[0], 1.8, model.position[2]] as [number, number, number],
        action: { cueId: CUES[index + 1]?.id ?? "overview", transitionSeconds: TRANSITION_SECONDS }
      }, site.id);
    }
  });
}
