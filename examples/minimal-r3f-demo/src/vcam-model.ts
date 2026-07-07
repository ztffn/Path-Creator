// Authoritative demo virtual-camera model: a real package VirtualCameraDefinition
// (body / lens / noise / track aim) plus editor-only sidecars (noise
// preset, composer settings) and shot timing. Projects to/from the flat
// DemoVirtualCamera "view" the authoring UI reads, so the source of truth is the
// portable package type, not a lossy demo superset. Timing stays a sidecar here;
// a later step lifts it into an authored timeline.
import {
  DEFAULT_COMPOSER_SETTINGS,
  EndOfPathInstruction,
  vcamTrackTargetId,
  type ComposerSettings,
  type OrbitBinding,
  type OrbitControlSettings,
  type RigCartDefinition,
  type TrackingTargetDefinition,
  type Vec3,
  type VirtualCameraDefinition,
  type VirtualCameraNoiseSettings,
  type VirtualCameraSnapshot
} from "@huma/path-creator/core";

/** The targets this editor authors: package point/cart targets (no groups yet). */
export type SceneTarget = Exclude<TrackingTargetDefinition, { type: "group" }>;

/**
 * A dolly is just a package cart (RigCartDefinition). The demo authors its name,
 * path, and end-of-path behaviour; distance/orientation/offset stay at defaults
 * and speed rides the global rig speed. This factory fills the rest.
 */
export function makeDolly(init: {
  id: string;
  name: string;
  pathId: string;
  endOfPathInstruction?: EndOfPathInstruction;
  speed?: number;
}): RigCartDefinition {
  return {
    id: init.id,
    name: init.name,
    pathId: init.pathId,
    distance: 0,
    speed: init.speed ?? 1,
    endOfPathInstruction: init.endOfPathInstruction ?? EndOfPathInstruction.Loop,
    orientationMode: "path-frame",
    positionOffset: { x: 0, y: 0, z: 0 }
  };
}

// Re-exported so demo modules get the composer defaults from one place; the
// canonical values live in the package, not here.
export { DEFAULT_COMPOSER_SETTINGS };

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

/** Editor-only extras keyed to a vcam id; not part of the portable definition. */
export type EditorVcam = { noisePreset: DemoNoisePreset; composerSettings: ComposerSettings };

/** A shot's placement on the camera track (seconds). */
export type ShotTiming = { start: number; end: number };

/**
 * One dolly run: over [start, end] the cart eases from fromT to
 * toT along its path. Runs are authored per dolly, independent of camera
 * shots; a new run defaults fromT to the previous run's toT so
 * gaps park rather than teleport. No runs on a dolly = free-run at rig speed.
 */
export type DollyRun = {
  id: string;
  start: number;
  end: number;
  fromT: number;
  toT: number;
};

/**
 * The flat, UI-facing projection the authoring panels/glyphs/lane editor read.
 * Derived from a definition + its sidecars; never the source of truth.
 */
export type DemoVirtualCamera = {
  id: string;
  name: string;
  bodyType: "static" | "cart" | "orbit";
  cartId: string;
  cartOffset: Vec3;
  /** Orbit body (meaningful when bodyType === "orbit"): the follow target it orbits. */
  orbitTargetId: string;
  orbitAzimuthDeg: number;
  orbitElevationDeg: number;
  orbitRadius: number;
  orbitBinding: OrbitBinding;
  /** Auto-orbit rate; 0 holds a static orbital angle. */
  orbitAutoDegPerSec: number;
  /** Per-axis interactive control (locked/free/recenter). */
  orbitControl: OrbitControlSettings;
  trackTargetId: string | null;
  noisePreset: DemoNoisePreset;
  dutchDeg: number;
  shotStart: number;
  shotEnd: number;
  snapshot: VirtualCameraSnapshot;
  composerSettings: ComposerSettings;
};

/** Defaults for the orbit sidecar fields; a static/cart view still carries them. */
export const ORBIT_DEFAULTS = {
  orbitTargetId: "",
  orbitAzimuthDeg: 45,
  orbitElevationDeg: 20,
  orbitRadius: 6,
  orbitBinding: "world" as OrbitBinding,
  orbitAutoDegPerSec: 0,
  orbitControl: {
    azimuth: { mode: "locked" },
    elevation: { mode: "locked" },
    radius: { mode: "locked" }
  } as OrbitControlSettings
};

/** A freshly added orbit vcam is interactive out of the box — a user can spin it
 *  (azimuth free), it recenters elevation after idle, and zoom is free — so the
 *  Cinemachine override/recenter behaviour is demonstrable immediately. */
export const ORBIT_INTERACTIVE_CONTROL: OrbitControlSettings = {
  azimuth: { mode: "free" },
  elevation: { mode: "recenter", recenterWait: 1.5, recenterTime: 1 },
  radius: { mode: "free" }
};

const IDENTITY_QUAT = { x: 0, y: 0, z: 0, w: 1 } as const;

export function expandNoisePreset(preset: DemoNoisePreset): VirtualCameraNoiseSettings | undefined {
  return NOISE_PRESETS[preset];
}

// vcamTrackTargetId now lives in the package core; re-exported so demo modules
// keep importing it from the model they already use.
export { vcamTrackTargetId };

/** Builds the flat UI view from a definition and its editor/timing sidecars. */
export function toVcamView(
  def: VirtualCameraDefinition,
  editor: EditorVcam,
  timing: ShotTiming
): DemoVirtualCamera {
  const dutchDeg = def.lens?.dutchDeg ?? 0;
  const name = def.name ?? def.id;
  const snapshot: VirtualCameraSnapshot = {
    name,
    position: def.body.type === "static" ? def.body.position : { x: 0, y: 0, z: 0 },
    quaternion: def.body.type === "static" ? def.body.quaternion : { ...IDENTITY_QUAT },
    ...(def.lens && { lens: def.lens })
  };
  const orbit =
    def.body.type === "orbit"
      ? {
          orbitTargetId: "targetId" in def.body.target ? def.body.target.targetId : "",
          orbitAzimuthDeg: def.body.azimuthDeg,
          orbitElevationDeg: def.body.elevationDeg,
          orbitRadius: def.body.radius,
          orbitBinding: def.body.binding ?? "world",
          orbitAutoDegPerSec: def.body.autoOrbitDegPerSec ?? 0,
          orbitControl: def.body.control ?? ORBIT_DEFAULTS.orbitControl
        }
      : ORBIT_DEFAULTS;
  return {
    id: def.id,
    name,
    bodyType: def.body.type,
    cartId: def.body.type === "cart" ? def.body.cartId : "",
    cartOffset: def.body.type === "cart" ? def.body.positionOffset ?? { x: 0, y: 0, z: 0 } : { x: 0, y: 0, z: 0 },
    ...orbit,
    trackTargetId: vcamTrackTargetId(def),
    noisePreset: editor.noisePreset,
    dutchDeg,
    shotStart: timing.start,
    shotEnd: timing.end,
    snapshot,
    composerSettings: editor.composerSettings
  };
}

/**
 * Assembles a definition from the flat view + its editor sidecar. Used on load
 * (migrating the stored view shape) and when adding a camera. The demo always
 * frames tracked targets through the damped composer, so the track aim carries
 * composer settings and the definition stays self-contained.
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
        : view.bodyType === "orbit"
          ? {
              type: "orbit",
              target: view.orbitTargetId
                ? { targetId: view.orbitTargetId }
                : { x: 0, y: 0, z: 0 },
              azimuthDeg: view.orbitAzimuthDeg,
              elevationDeg: view.orbitElevationDeg,
              radius: view.orbitRadius,
              binding: view.orbitBinding,
              control: view.orbitControl,
              ...(view.orbitAutoDegPerSec !== 0 && {
                autoOrbitDegPerSec: view.orbitAutoDegPerSec
              })
            }
          : { type: "static", position: view.snapshot.position, quaternion: view.snapshot.quaternion }
  };
  if (view.trackTargetId) {
    def.aim = {
      type: "track",
      target: { targetId: view.trackTargetId },
      settings: editor.composerSettings
    };
  }
  if (noise) def.noise = noise;
  if (Object.keys(lens).length > 0) def.lens = lens;
  return def;
}
