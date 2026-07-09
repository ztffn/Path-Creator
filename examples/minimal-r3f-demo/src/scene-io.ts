// Bridges the demo's editing state and the portable RigDocument scene file.
// The package owns the real I/O (serializeRigDocument/parseRigDocument, schema
// validation); this module only assembles a document from the editor's working
// state and hydrates it back — plus the demo's show-timeline build/reverse and
// noise-preset matching. The scene file is a pure RigDocument; editor-only bits
// (active path, noise-preset label) are derived or defaulted on load.
import {
  BezierPath,
  VertexPath,
  createRigDocument,
  createTimeline,
  parseRigDocument,
  serializeRigDocument,
  type CameraBlock,
  type CartTrack,
  type RigCartDefinition,
  type RigDocument,
  type RigPathDefinition,
  type RigTimelineDefinition,
  type Timeline,
  type VirtualCameraDefinition
} from "@huma/path-creator/core";
import {
  DEFAULT_COMPOSER_SETTINGS,
  DEFAULT_DOLLY_EASING,
  NOISE_PRESETS,
  type DemoNoisePreset,
  type DollyRun,
  type FovAnimation,
  type EditorVcam,
  type SceneTarget,
  type ShotTiming
} from "./vcam-model";

const SHOW_TIMELINE_ID = "show";

/** The demo's editing working-set — all package types plus the sidecars the UI edits. */
export interface DemoScene {
  paths: RigPathDefinition[];
  activePathId: string | null;
  dollies: RigCartDefinition[];
  vcamDefs: VirtualCameraDefinition[];
  editorVcams: Record<string, EditorVcam>;
  shotTiming: Record<string, ShotTiming>;
  /** Per-dolly (cartId) run-blocks; a dolly absent here free-runs at rig speed. */
  dollyRuns: Record<string, DollyRun[]>;
  targets: SceneTarget[];
}

/**
 * Builds the show timeline: camera blocks from shot timing (start/end, with a
 * crossfade blendIn where a shot overlaps its predecessor) and one cart track
 * per dolly whose keys are its authored run-blocks (each run a start/end pair).
 */
export function buildShowTimeline(
  vcamDefs: VirtualCameraDefinition[],
  shotTiming: Record<string, ShotTiming>,
  dollyRuns: Record<string, DollyRun[]>,
  // Converts a normalized 0..1 move position to arc-distance for that cart's path.
  cartLength: (cartId: string) => number,
  // Per-vcam FOV push/pull, emitted as the block's CameraBlock.lensAnimation.
  fovAnimations: Record<string, FovAnimation> = {}
): RigTimelineDefinition {
  const shots = vcamDefs
    .map((def) => ({ def, timing: shotTiming[def.id] ?? { start: 0, end: 5 } }))
    .sort((a, b) => a.timing.start - b.timing.start);

  const blocks: CameraBlock[] = shots.map((shot, index) => {
    const previous = index > 0 ? shots[index - 1] : undefined;
    const overlap = previous ? previous.timing.end - shot.timing.start : 0;
    const fovAnim = fovAnimations[shot.def.id];
    return {
      id: `block-${shot.def.id}`,
      vcamId: shot.def.id,
      start: shot.timing.start,
      end: shot.timing.end,
      ...(overlap > 0.01 && { blendIn: { durationSeconds: overlap, curve: "easeInOut" as const } }),
      ...(fovAnim && { lensAnimation: { fov: fovAnim } })
    };
  });

  const cartTracks: CartTrack[] = Object.entries(dollyRuns)
    .map(([cartId, runs]) => {
      const length = cartLength(cartId) || 1;
      return {
        type: "cart" as const,
        id: `dolly-track-${cartId}`,
        cartId,
        keys: [...runs]
          .sort((a, b) => a.start - b.start)
          .flatMap((run) => [
            { time: run.start, distance: run.fromT * length, easing: run.easing ?? DEFAULT_DOLLY_EASING },
            { time: run.end, distance: run.toT * length }
          ])
      };
    })
    .filter((track) => track.keys.length > 0);

  const cartEnd = Object.values(dollyRuns)
    .flat()
    .reduce((max, run) => Math.max(max, run.end), 0);
  const duration = Math.max(cartEnd, ...shots.map((shot) => shot.timing.end), 0);
  return {
    id: SHOW_TIMELINE_ID,
    name: "Show",
    ...createTimeline({ duration, tracks: [{ type: "camera", id: "camera-track", blocks }, ...cartTracks] })
  };
}

/** Reverses camera-track blocks into per-shot timing (start/end). */
function timingFromTimeline(
  timeline: Timeline | undefined,
  vcamDefs: VirtualCameraDefinition[]
): Record<string, ShotTiming> {
  const cameraTrack = timeline?.tracks.find((track) => track.type === "camera");
  const timing: Record<string, ShotTiming> = {};
  for (const def of vcamDefs) {
    const block = cameraTrack?.blocks.find((b) => b.vcamId === def.id);
    const start = block?.start ?? 0;
    timing[def.id] = { start, end: block?.end ?? start + 5 };
  }
  return timing;
}

/** Reverses each cart track's keys into run-blocks (keys come in start/end pairs). */
function runsFromTimeline(
  timeline: Timeline | undefined,
  cartLength: (cartId: string) => number
): Record<string, DollyRun[]> {
  const runs: Record<string, DollyRun[]> = {};
  for (const track of timeline?.tracks ?? []) {
    if (track.type !== "cart") continue;
    const length = cartLength(track.cartId) || 1;
    const list: DollyRun[] = [];
    for (let i = 0; i + 1 < track.keys.length; i += 2) {
      const from = track.keys[i];
      const to = track.keys[i + 1];
      if (!from || !to) continue;
      list.push({
        id: `run-${track.cartId}-${i / 2}`,
        start: from.time,
        end: to.time,
        fromT: from.distance / length,
        toT: to.distance / length,
        ...(from.easing !== undefined && { easing: from.easing })
      });
    }
    if (list.length > 0) runs[track.cartId] = list;
  }
  return runs;
}

/** Arc-length of each cart's path, keyed by cartId (for 0..1 ↔ distance). */
function cartPathLengths(
  paths: RigPathDefinition[],
  carts: RigCartDefinition[]
): (cartId: string) => number {
  const pathLength = new Map<string, number>();
  for (const path of paths) {
    pathLength.set(path.id, new VertexPath(BezierPath.fromJSON(path.bezier)).length);
  }
  const byCart = new Map<string, number>();
  for (const cart of carts) byCart.set(cart.id, pathLength.get(cart.pathId) ?? 1);
  return (cartId) => byCart.get(cartId) ?? 1;
}

/** The noise-preset label whose expansion matches these settings, else "off". */
export function matchNoisePreset(noise: VirtualCameraDefinition["noise"]): DemoNoisePreset {
  if (!noise) return "off";
  const serialized = JSON.stringify(noise);
  for (const preset of ["subtle", "rough"] as const) {
    if (JSON.stringify(NOISE_PRESETS[preset]) === serialized) return preset;
  }
  return "off";
}

/** Assembles a portable RigDocument from the editor's working state. */
export function assembleDocument(scene: DemoScene): RigDocument {
  return createRigDocument({
    paths: scene.paths,
    carts: scene.dollies,
    vcams: scene.vcamDefs,
    targets: scene.targets,
    timelines: [
      buildShowTimeline(
        scene.vcamDefs,
        scene.shotTiming,
        scene.dollyRuns,
        cartPathLengths(scene.paths, scene.dollies)
      )
    ]
  });
}

/** Hydrates the editor working state from a document (editor sidecars derived). */
export function hydrateScene(document: RigDocument): DemoScene {
  const vcamDefs = document.vcams ?? [];
  const editorVcams: Record<string, EditorVcam> = {};
  for (const def of vcamDefs) {
    editorVcams[def.id] = {
      noisePreset: matchNoisePreset(def.noise),
      composerSettings: def.aim?.type === "track" && def.aim.settings ? def.aim.settings : DEFAULT_COMPOSER_SETTINGS
    };
  }
  return {
    paths: document.paths,
    activePathId: document.paths[0]?.id ?? null,
    dollies: document.carts,
    vcamDefs,
    editorVcams,
    shotTiming: timingFromTimeline(document.timelines?.[0], vcamDefs),
    dollyRuns: runsFromTimeline(
      document.timelines?.[0],
      cartPathLengths(document.paths, document.carts)
    ),
    targets: (document.targets ?? []).filter(
      (target): target is SceneTarget => target.type === "point" || target.type === "cart"
    )
  };
}

/** Serializes the scene to the portable RigDocument JSON. */
export function serializeScene(scene: DemoScene): string {
  return serializeRigDocument(assembleDocument(scene));
}

/** Parses + hydrates a scene from RigDocument JSON (throws on bad schema). */
export function deserializeScene(json: string): DemoScene {
  return hydrateScene(parseRigDocument(json));
}
