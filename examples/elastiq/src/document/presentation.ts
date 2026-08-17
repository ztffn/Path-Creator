// The elastiq presentation document: what the audience is taken through, and how it should
// look while that happens. Sits beside the scene document (which owns what exists and where);
// the two meet only at node ids. Everything the runtime needs comes from here — nothing is read
// from the URL, because the URL belongs to the presentation system's routing, not to render
// state. Scope: prototype document layer.
import type { VirtualCameraDefinition } from "@huma/path-creator/core";
import type { Cue } from "./cues";
import { ELASTIQ_PLUGIN_ID } from "./scene-plugin";

/**
 * How a moment should be rendered. Two shells, one scene: `polished` for a cinematic reveal
 * (environment lighting, contact shadows, room for bloom and depth of field), `reading` for a
 * technical look (screen-space GI, inked edges, outlines). Both draw the same nodes with the
 * same renderers — only the shell around them differs.
 */
export type RenderMode = "polished" | "reading";

/** A camera shot, anchored at a time. Binds to the scene by node id and nothing else. */
export interface Shot {
  time: number;
  definition: VirtualCameraDefinition;
}

export interface Presentation {
  id: string;
  name: string;
  /** The look this presentation opens in; a cue may override it. */
  renderMode: RenderMode;
  /** Seconds the clock takes to ride between slides. */
  transitionSeconds: number;
  cues: Cue[];
  shots: Shot[];
}

/**
 * The mode in force at time `t`: the current cue's override if it has one, else the
 * presentation's own. Changing mode swaps the renderer, which remounts the canvas — so an
 * override is a deliberate change of chapter, not something to alternate slide by slide.
 */
export function renderModeAt(presentation: Presentation, time: number): RenderMode {
  let mode = presentation.renderMode;
  for (const cue of [...presentation.cues].sort((a, b) => a.time - b.time)) {
    if (cue.time > time + 1e-3) break;
    if (cue.renderMode) mode = cue.renderMode;
  }
  return mode;
}

// ─── The authored fixture ────────────────────────────────────────────────────────────────────
// In the product this is loaded, not literal. Kept here so the split stays legible: the scene
// half below builds nodes, this half describes the journey through them.

const MODEL_URL = "/Fox.glb";

/** Ids are the contract with the timeline — stable, authored, never derived from position. */
const MODELS = [
  { id: "model_a", name: "Left subject", position: [-4, 0, 0] as [number, number, number] },
  { id: "model_b", name: "Centre subject", position: [0, 0, -3] as [number, number, number] },
  { id: "model_c", name: "Right subject", position: [4, 0, 0] as [number, number, number] }
];

const orbitShot = (id: string, targetId: string, azimuthDeg: number, elevationDeg: number, radius: number, fov: number): VirtualCameraDefinition => ({
  id,
  body: { type: "orbit", target: { targetId }, azimuthDeg, elevationDeg, radius, binding: "world" },
  aim: { type: "body" },
  lens: { fov }
});

export const PRESENTATION: Presentation = {
  id: "demo",
  name: "Three subjects",
  renderMode: "polished",
  transitionSeconds: 1.8,
  cues: [
    { id: "overview", name: "The whole stage", time: 0 },
    { id: "left", name: "Left subject", time: 5 },
    // A technical chapter: the same scene, read rather than presented.
    { id: "centre", name: "Centre subject", time: 10, renderMode: "reading" },
    { id: "right", name: "Right subject", time: 15, renderMode: "polished" }
  ],
  shots: [
    {
      time: 0,
      definition: {
        id: "shot_overview",
        body: { type: "orbit", target: { x: 0, y: 0.8, z: -1 }, azimuthDeg: 25, elevationDeg: 24, radius: 14, binding: "world", autoOrbitDegPerSec: 4 },
        aim: { type: "body" },
        lens: { fov: 50 }
      }
    },
    { time: 5, definition: orbitShot("shot_left", "model_a", -40, 14, 4.5, 38) },
    { time: 10, definition: orbitShot("shot_centre", "model_b", 15, 10, 3.6, 34) },
    { time: 15, definition: orbitShot("shot_right", "model_c", 60, 18, 4.5, 38) }
  ]
};

interface SceneStoreLike {
  nodes: Record<string, unknown>;
  createNode: (node: unknown, parentId?: unknown) => void;
  setInstalledPlugins: (ids: string[], options?: { explicit?: boolean }) => void;
}

interface KindRegistryLike {
  get: (kind: string) => { defaults?: () => Record<string, unknown> } | undefined;
}

/**
 * Builds the scene: the models, and a marker beside each wired to that model's slide. Nodes are
 * roots — `parentId` is optional and nothing validates parent kinds, so the architectural
 * site/building/level hierarchy underneath is simply unused. Idempotent; strict mode mounts
 * effects twice.
 */
export function buildScene(store: SceneStoreLike, registry: KindRegistryLike): void {
  // A namespaced kind is gated per project; without this a kind-aware renderer refuses it.
  store.setInstalledPlugins([ELASTIQ_PLUGIN_ID], { explicit: true });

  const model = registry.get("elastiq:model");
  const hotspot = registry.get("elastiq:hotspot");
  if (!model || !hotspot) return;

  MODELS.forEach((entry, index) => {
    if (!store.nodes[entry.id]) {
      store.createNode({
        ...(model.defaults?.() ?? {}),
        id: entry.id, type: "elastiq:model", name: entry.name,
        url: MODEL_URL, position: entry.position, scale: [0.04, 0.04, 0.04]
      });
    }
    const markerId = `${entry.id}_marker`;
    if (!store.nodes[markerId]) {
      store.createNode({
        ...(hotspot.defaults?.() ?? {}),
        id: markerId, type: "elastiq:hotspot", label: entry.name,
        position: [entry.position[0], 1.8, entry.position[2]] as [number, number, number],
        action: {
          cueId: PRESENTATION.cues[index + 1]?.id ?? "overview",
          transitionSeconds: PRESENTATION.transitionSeconds
        }
      });
    }
  });
}
