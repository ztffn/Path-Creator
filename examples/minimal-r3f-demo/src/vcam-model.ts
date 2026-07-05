// Authoritative demo virtual-camera model: a real package VirtualCameraDefinition
// (body / lens / noise / screen-composer aim) plus editor-only sidecars (noise
// preset, composer settings) and shot timing. Projects to/from the flat
// DemoVirtualCamera "view" the authoring UI reads, so the source of truth is the
// portable package type, not a lossy demo superset. Timing stays a sidecar here;
// a later step lifts it into an authored timeline.
import {
  type ComposerSettings,
  type Vec3,
  type VirtualCameraDefinition,
  type VirtualCameraNoiseSettings,
  type VirtualCameraSnapshot
} from "@huma/path-creator/core";

export type DemoNoisePreset = "off" | "subtle" | "rough";

export const NOISE_PRESETS: Record<DemoNoisePreset, VirtualCameraNoiseSettings | undefined> = {
  off: undefined,
  subtle: {
    seed: 11,
    positionAmplitude: 0.03,
    positionFrequency: 0.9,
    rotationAmplitudeDeg: 0.6,
    rotationFrequencyDeg: 0.7
  },
  rough: {
    seed: 23,
    positionAmplitude: 0.12,
    positionFrequency: 1.8,
    rotationAmplitudeDeg: 2.4,
    rotationFrequencyDeg: 1.6
  }
};

export const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = {
  screenX: 0,
  screenY: 0,
  deadWidth: 0.18,
  deadHeight: 0.14,
  softWidth: 0.55,
  softHeight: 0.45,
  dampingX: 6,
  dampingY: 8,
  targetOffsetX: 0,
  targetOffsetY: 0,
  targetOffsetZ: 0,
  lookaheadTime: 0.2,
  lookaheadSmoothing: 8,
  lookaheadIgnoreY: false,
  centerOnActivate: false
};

/** Editor-only extras keyed to a vcam id; not part of the portable definition. */
export type EditorVcam = { noisePreset: DemoNoisePreset; composerSettings: ComposerSettings };

/** Shot placement on the show timeline; a later step lifts this into the timeline. */
export type ShotTiming = { start: number; end: number; railFrom: number | null; railTo: number | null };

/**
 * The flat, UI-facing projection the authoring panels/glyphs/lane editor read.
 * Derived from a definition + its sidecars; never the source of truth.
 */
export type DemoVirtualCamera = {
  id: string;
  name: string;
  bodyType: "static" | "cart";
  cartId: string;
  cartOffset: Vec3;
  trackTargetId: string | null;
  noisePreset: DemoNoisePreset;
  dutchDeg: number;
  shotStart: number;
  shotEnd: number;
  railFrom: number | null;
  railTo: number | null;
  snapshot: VirtualCameraSnapshot;
  composerSettings: ComposerSettings;
};

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 } as const;

export function expandNoisePreset(preset: DemoNoisePreset): VirtualCameraNoiseSettings | undefined {
  return NOISE_PRESETS[preset];
}

/** The tracked target id of a screen-composer aim, or null for a body aim. */
export function vcamTrackTargetId(def: VirtualCameraDefinition): string | null {
  return def.aim?.type === "screen-composer" && "targetId" in def.aim.target
    ? def.aim.target.targetId
    : null;
}

/** Builds the flat UI view from a definition and its editor/timing sidecars. */
export function toVcamView(
  def: VirtualCameraDefinition,
  editor: EditorVcam,
  timing: ShotTiming
): DemoVirtualCamera {
  const dutchDeg = def.lens?.dutchDeg ?? 0;
  const name = def.name ?? def.id;
  const snapshot: VirtualCameraSnapshot =
    def.body.type === "static"
      ? { name, position: def.body.position, quaternion: def.body.quaternion, ...(def.lens && { lens: def.lens }) }
      : { name, position: { x: 0, y: 0, z: 0 }, quaternion: { ...IDENTITY_QUAT }, ...(def.lens && { lens: def.lens }) };
  return {
    id: def.id,
    name: def.name ?? def.id,
    bodyType: def.body.type,
    cartId: def.body.type === "cart" ? def.body.cartId : "",
    cartOffset: def.body.type === "cart" ? def.body.positionOffset ?? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 },
    trackTargetId: vcamTrackTargetId(def),
    noisePreset: editor.noisePreset,
    dutchDeg,
    shotStart: timing.start,
    shotEnd: timing.end,
    railFrom: timing.railFrom,
    railTo: timing.railTo,
    snapshot,
    composerSettings: editor.composerSettings
  };
}

/**
 * Assembles a definition from the flat view + its editor sidecar. Used on load
 * (migrating the stored view shape) and when adding a camera. The screen-composer
 * aim carries the composer settings so the definition stays self-contained.
 */
export function vcamDefFromView(
  view: DemoVirtualCamera,
  editor: EditorVcam
): VirtualCameraDefinition {
  const lens = {
    ...view.snapshot.lens,
    ...(view.dutchDeg !== 0 && { dutchDeg: view.dutchDeg })
  };
  const noise = expandNoisePreset(editor.noisePreset);
  const def: VirtualCameraDefinition = {
    id: view.id,
    name: view.name,
    body:
      view.bodyType === "cart"
        ? { type: "cart", cartId: view.cartId, positionOffset: view.cartOffset }
        : { type: "static", position: view.snapshot.position, quaternion: view.snapshot.quaternion }
  };
  if (view.trackTargetId) {
    def.aim = {
      type: "screen-composer",
      target: { targetId: view.trackTargetId },
      settings: editor.composerSettings
    };
  }
  if (noise) def.noise = noise;
  if (Object.keys(lens).length > 0) def.lens = lens;
  return def;
}
