// Bridges the demo's editing state and the portable RigDocument story file.
// The package owns the real I/O (serializeRigDocument/parseRigDocument, schema
// validation); this module assembles a document from the editor's working state and
// hydrates it back — plus the per-scene timeline build/reverse and noise-preset
// matching. A story is shared pools (paths/dollies/vcams/targets) + N scenes, each
// persisted as one document timeline; entrySceneId marks the master. Legacy
// single-timeline files and x-demo-tracks sidecars remain readable via migration.
import {
  BezierPath,
  VertexPath,
  createRigDocument,
  createTimeline,
  parseRigDocument,
  type CameraBlock,
  type CartTrack,
  type RigCartDefinition,
  type RigDocument,
  type RigPathDefinition,
  type RigTimelineDefinition,
  type Timeline,
  type VirtualCameraDefinition
} from "@huma/path-creator/core";
import { EMPTY_EXTRA_TRACKS, maxClipEnd, normalizeExtraTracks, type ExtraTracks } from "./extra-tracks";
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
// Namespaced RigDocument key carrying the demo's extra tracks (activation/audio/
// animation/transform) — the core Timeline union can't express them, so they ride
// alongside as an extension the package parser ignores (glTF-extensions style).
const EXTRA_TRACKS_KEY = "x-demo-tracks";

/** The demo's editing working-set — the shared pools plus ONE scene's content,
 *  flattened (the shape the editor's state hooks work in). */
export interface DemoScene {
  paths: RigPathDefinition[];
  activePathId: string | null;
  dollies: RigCartDefinition[];
  vcamDefs: VirtualCameraDefinition[];
  editorVcams: Record<string, EditorVcam>;
  shotTiming: Record<string, ShotTiming>;
  /** Per-dolly (cartId) run-blocks; a dolly absent here free-runs at rig speed. */
  dollyRuns: Record<string, DollyRun[]>;
  /** Per-vcam FOV push/pull over the shot; persisted portably as CameraBlock.lensAnimation. */
  fovAnimations: Record<string, FovAnimation>;
  targets: SceneTarget[];
  /** Portable activation/audio/animation/transform tracks embedded in the show timeline. */
  extraTracks: ExtraTracks;
}

/** One scene's timeline-derived content. A vcam participates in a scene iff it
 *  has a shotTiming entry here — the pool of vcams/dollies is story-shared. */
export interface DemoSceneContent {
  id: string;
  name?: string;
  shotTiming: Record<string, ShotTiming>;
  dollyRuns: Record<string, DollyRun[]>;
  fovAnimations: Record<string, FovAnimation>;
  extraTracks: ExtraTracks;
}

/** The full authored story: shared pools + every scene, entry marked. */
export interface DemoStory {
  paths: RigPathDefinition[];
  activePathId: string | null;
  dollies: RigCartDefinition[];
  vcamDefs: VirtualCameraDefinition[];
  editorVcams: Record<string, EditorVcam>;
  targets: SceneTarget[];
  scenes: DemoSceneContent[];
  entrySceneId: string | null;
}

export const EMPTY_SCENE_CONTENT: Omit<DemoSceneContent, "id" | "name"> = {
  shotTiming: {},
  dollyRuns: {},
  fovAnimations: {},
  extraTracks: EMPTY_EXTRA_TRACKS
};

/** The working set's scene-content half, stamped with the scene's identity. */
export function contentFromScene(scene: DemoScene, id: string, name?: string): DemoSceneContent {
  return {
    id,
    ...(name !== undefined && { name }),
    shotTiming: scene.shotTiming,
    dollyRuns: scene.dollyRuns,
    fovAnimations: scene.fovAnimations,
    extraTracks: scene.extraTracks
  };
}

/** Flattens the story's pools + one scene's content into the editing working-set. */
export function sceneFromStory(story: DemoStory, sceneId: string): DemoScene | null {
  const content = story.scenes.find((scene) => scene.id === sceneId);
  if (!content) return null;
  return {
    paths: story.paths,
    activePathId: story.activePathId,
    dollies: story.dollies,
    vcamDefs: story.vcamDefs,
    editorVcams: story.editorVcams,
    targets: story.targets,
    shotTiming: content.shotTiming,
    dollyRuns: content.dollyRuns,
    fovAnimations: content.fovAnimations,
    extraTracks: content.extraTracks
  };
}

/**
 * Builds one scene's timeline: camera blocks from shot timing (start/end, with a
 * crossfade blendIn where a shot overlaps its predecessor) and one cart track
 * per dolly whose keys are its authored run-blocks (each run a start/end pair).
 * Only vcams WITH a timing entry participate — a scene without camera entries
 * has no camera track, so invoking it leaves the camera with the user.
 */
export function buildShowTimeline(
  vcamDefs: VirtualCameraDefinition[],
  shotTiming: Record<string, ShotTiming>,
  dollyRuns: Record<string, DollyRun[]>,
  // Converts a normalized 0..1 move position to arc-distance for that cart's path.
  cartLength: (cartId: string) => number,
  // Per-vcam FOV push/pull, emitted as the block's CameraBlock.lensAnimation.
  fovAnimations: Record<string, FovAnimation> = {},
  extraTracks: ExtraTracks = EMPTY_EXTRA_TRACKS,
  sceneMeta: { id?: string; name?: string } = {}
): RigTimelineDefinition {
  const shots = vcamDefs
    .filter((def) => shotTiming[def.id])
    .map((def) => ({ def, timing: shotTiming[def.id]! }))
    .sort((a, b) => a.timing.start - b.timing.start);

  const blocks: CameraBlock[] = shots.map((shot, index) => {
    const previous = index > 0 ? shots[index - 1] : undefined;
    const overlap = previous ? previous.timing.end - shot.timing.start : 0;
    // Only animate a shot whose fov is actually authored (an override is set); a
    // stale sidecar entry for an inherited-fov shot must not force a phantom push.
    const fovAnim = shot.def.lens?.fov !== undefined ? fovAnimations[shot.def.id] : undefined;
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
  const duration = Math.max(cartEnd, ...shots.map((shot) => shot.timing.end), maxClipEnd(extraTracks), 0);
  return {
    id: sceneMeta.id ?? SHOW_TIMELINE_ID,
    name: sceneMeta.name ?? "Show",
    // No camera track when no vcam participates: camera ownership is composition.
    ...createTimeline({ duration, tracks: [
      ...(blocks.length > 0 ? [{ type: "camera" as const, id: "camera-track", blocks }] : []),
      ...cartTracks,
      ...extraTracks.activationTracks,
      ...extraTracks.audioTracks,
      ...extraTracks.animationTracks,
      ...extraTracks.transformTracks
    ] })
  };
}

/** Reverses camera-track blocks into per-shot timing. Only vcams with a block
 *  get an entry — participation in the scene is exactly "has a timing entry". */
function timingFromTimeline(
  timeline: Timeline | undefined,
  vcamDefs: VirtualCameraDefinition[]
): Record<string, ShotTiming> {
  const cameraTrack = timeline?.tracks.find((track) => track.type === "camera");
  const timing: Record<string, ShotTiming> = {};
  for (const def of vcamDefs) {
    const block = cameraTrack?.blocks.find((b) => b.vcamId === def.id);
    if (block) timing[def.id] = { start: block.start, end: block.end };
  }
  return timing;
}

/** Reverses camera-track blocks' lensAnimation.fov back into the per-vcam sidecar. */
function fovAnimationsFromTimeline(
  timeline: Timeline | undefined,
  vcamDefs: VirtualCameraDefinition[]
): Record<string, FovAnimation> {
  const cameraTrack = timeline?.tracks.find((track) => track.type === "camera");
  const animations: Record<string, FovAnimation> = {};
  for (const def of vcamDefs) {
    const fov = cameraTrack?.blocks.find((b) => b.vcamId === def.id)?.lensAnimation?.fov;
    // Our buildShowTimeline always writes an easing; default a foreign/older doc's.
    if (fov) animations[def.id] = { from: fov.from, to: fov.to, easing: fov.easing ?? "easeInOut" };
  }
  return animations;
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

/** Assembles a portable RigDocument (schema v7 Story) from the editor's story. */
export function assembleDocument(story: DemoStory): RigDocument {
  const cartLength = cartPathLengths(story.paths, story.dollies);
  return createRigDocument({
    paths: story.paths,
    carts: story.dollies,
    vcams: story.vcamDefs,
    targets: story.targets,
    timelines: story.scenes.map((scene) =>
      buildShowTimeline(
        story.vcamDefs,
        scene.shotTiming,
        scene.dollyRuns,
        cartLength,
        scene.fovAnimations,
        scene.extraTracks,
        { id: scene.id, ...(scene.name !== undefined && { name: scene.name }) }
      )
    ),
    ...(story.entrySceneId !== null && { entrySceneId: story.entrySceneId })
  });
}

/** Decomposes one document timeline into a scene's editable content. */
function contentFromTimeline(
  timeline: RigTimelineDefinition,
  vcamDefs: VirtualCameraDefinition[],
  cartLength: (cartId: string) => number
): DemoSceneContent {
  return {
    id: timeline.id,
    ...(timeline.name !== undefined && { name: timeline.name }),
    shotTiming: timingFromTimeline(timeline, vcamDefs),
    dollyRuns: runsFromTimeline(timeline, cartLength),
    fovAnimations: fovAnimationsFromTimeline(timeline, vcamDefs),
    extraTracks: {
      activationTracks: timeline.tracks.filter((track) => track.type === "activation"),
      audioTracks: timeline.tracks.filter((track) => track.type === "audio"),
      animationTracks: timeline.tracks.filter((track) => track.type === "animation"),
      transformTracks: timeline.tracks.filter((track) => track.type === "transform")
    }
  };
}

/** Hydrates the full story from a document (editor sidecars derived). A document
 *  with no timelines gets one empty entry scene so the editor always has a scene. */
export function hydrateStory(document: RigDocument): DemoStory {
  const vcamDefs = document.vcams ?? [];
  const editorVcams: Record<string, EditorVcam> = {};
  for (const def of vcamDefs) {
    editorVcams[def.id] = {
      noisePreset: matchNoisePreset(def.noise),
      composerSettings: def.aim?.type === "track" && def.aim.settings ? def.aim.settings : DEFAULT_COMPOSER_SETTINGS
    };
  }
  const cartLength = cartPathLengths(document.paths, document.carts);
  const scenes = (document.timelines ?? []).map((timeline) =>
    contentFromTimeline(timeline, vcamDefs, cartLength)
  );
  if (scenes.length === 0) scenes.push({ id: SHOW_TIMELINE_ID, name: "Show", ...EMPTY_SCENE_CONTENT });
  return {
    paths: document.paths,
    activePathId: document.paths[0]?.id ?? null,
    dollies: document.carts,
    vcamDefs,
    editorVcams,
    targets: (document.targets ?? []).filter(
      (target): target is SceneTarget => target.type === "point" || target.type === "cart"
    ),
    scenes,
    entrySceneId: document.entrySceneId ?? scenes[0]?.id ?? null
  };
}

/** Serializes the story as a portable RigDocument with all tracks embedded. */
export function serializeStory(story: DemoStory): string {
  return JSON.stringify(assembleDocument(story));
}

/** Parses current documents and migrates the legacy x-demo-tracks sidecar on load
 *  (legacy sidecar tracks land on the entry scene). */
export function deserializeStory(json: string): DemoStory {
  const story = hydrateStory(parseRigDocument(json));
  const raw = JSON.parse(json) as Record<string, unknown>;
  if (!raw[EXTRA_TRACKS_KEY]) return story;
  const extraTracks = normalizeExtraTracks(raw[EXTRA_TRACKS_KEY]);
  const entryId = story.entrySceneId ?? story.scenes[0]?.id;
  return {
    ...story,
    scenes: story.scenes.map((scene) => (scene.id === entryId ? { ...scene, extraTracks } : scene))
  };
}
