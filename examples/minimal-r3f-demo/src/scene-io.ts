// Bridges the demo's editing state and the portable RigDocument scene file.
// The package owns the real I/O (serializeRigDocument/parseRigDocument, schema
// validation); this module only assembles a document from the editor's working
// state and hydrates it back — plus the demo's show-timeline build/reverse and
// noise-preset matching. The scene file is a pure RigDocument; editor-only bits
// (active path, noise-preset label) are derived or defaulted on load.
import {
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
  NOISE_PRESETS,
  type DemoNoisePreset,
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
  targets: SceneTarget[];
}

/**
 * Builds the show timeline from shot timing: camera blocks (start/end, with a
 * crossfade blendIn where a shot overlaps its predecessor) and one cart track
 * per dolly whose keys are the rail moves at each cart shot's boundaries.
 */
export function buildShowTimeline(
  vcamDefs: VirtualCameraDefinition[],
  shotTiming: Record<string, ShotTiming>,
  dollies: RigCartDefinition[]
): RigTimelineDefinition {
  const shots = vcamDefs
    .map((def) => ({ def, timing: shotTiming[def.id] ?? { start: 0, end: 5, railFrom: null, railTo: null } }))
    .sort((a, b) => a.timing.start - b.timing.start);

  const blocks: CameraBlock[] = shots.map((shot, index) => {
    const previous = index > 0 ? shots[index - 1] : undefined;
    const overlap = previous ? previous.timing.end - shot.timing.start : 0;
    return {
      id: `block-${shot.def.id}`,
      vcamId: shot.def.id,
      start: shot.timing.start,
      end: shot.timing.end,
      ...(overlap > 0.01 && { blendIn: { durationSeconds: overlap, curve: "easeInOut" as const } })
    };
  });

  const cartTracks: CartTrack[] = dollies
    .map((dolly) => ({
      type: "cart" as const,
      id: `dolly-track-${dolly.id}`,
      cartId: dolly.id,
      keys: shots
        .filter(
          (shot) =>
            shot.def.body.type === "cart" &&
            shot.def.body.cartId === dolly.id &&
            shot.timing.railFrom !== null &&
            shot.timing.railTo !== null
        )
        .flatMap((shot) => [
          { time: shot.timing.start, distance: shot.timing.railFrom ?? 0, easing: "easeInOut" as const },
          { time: shot.timing.end, distance: shot.timing.railTo ?? 0 }
        ])
    }))
    .filter((track) => track.keys.length > 0);

  const duration = shots.length ? Math.max(...shots.map((shot) => shot.timing.end)) : 0;
  return {
    id: SHOW_TIMELINE_ID,
    name: "Show",
    ...createTimeline({ duration, tracks: [{ type: "camera", id: "camera-track", blocks }, ...cartTracks] })
  };
}

/** Reverses the show timeline back into per-shot timing (start/end + rail from/to). */
function timingFromTimeline(
  timeline: Timeline | undefined,
  vcamDefs: VirtualCameraDefinition[]
): Record<string, ShotTiming> {
  const cameraTrack = timeline?.tracks.find((track) => track.type === "camera");
  const cartTracks = new Map(
    (timeline?.tracks ?? []).flatMap((track) => (track.type === "cart" ? [[track.cartId, track] as const] : []))
  );
  const timing: Record<string, ShotTiming> = {};
  for (const def of vcamDefs) {
    const block = cameraTrack?.blocks.find((b) => b.vcamId === def.id);
    const start = block?.start ?? 0;
    const end = block?.end ?? start + 5;
    let railFrom: number | null = null;
    let railTo: number | null = null;
    if (def.body.type === "cart") {
      const track = cartTracks.get(def.body.cartId);
      const from = track?.keys.find((k) => Math.abs(k.time - start) < 1e-6);
      const to = track?.keys.find((k) => Math.abs(k.time - end) < 1e-6);
      if (from && to) {
        railFrom = from.distance;
        railTo = to.distance;
      }
    }
    timing[def.id] = { start, end, railFrom, railTo };
  }
  return timing;
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
    timelines: [buildShowTimeline(scene.vcamDefs, scene.shotTiming, scene.dollies)]
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
