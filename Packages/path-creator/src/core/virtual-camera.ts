// Pure data types for virtual cameras: snapshots, lenses, noise settings,
// body/aim definitions, and blend-curve vocabulary. Live in core (no three.js
// dependency) so rig documents and timeline schemas can reference them; the
// resolver/blend/brain FUNCTIONS that operate on these types live in the
// three adapter. Re-exported from @huma/path-creator/three for convenience.
import type { CartFrame } from "./cart";
import type { Vec3 } from "./types";

export interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export type VirtualCameraBlendCurve =
  | "cut"
  | "linear"
  | "easeInOut"
  | "easeIn"
  | "easeOut"
  | "hardIn"
  | "hardOut";

/** Shapes a 0..1 progress value; the shared easing vocabulary for camera blends and cart keyframes. */
export function evaluateVirtualCameraBlendCurve(
  t: number,
  curve: VirtualCameraBlendCurve = "easeInOut"
): number {
  const alpha = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));

  switch (curve) {
    case "cut":
      return 1;
    case "linear":
      return alpha;
    case "easeIn":
      return alpha * alpha;
    case "easeOut":
      return 1 - (1 - alpha) * (1 - alpha);
    case "hardIn":
      return alpha * alpha * alpha;
    case "hardOut":
      return 1 - (1 - alpha) * (1 - alpha) * (1 - alpha);
    case "easeInOut":
    default:
      return alpha * alpha * (3 - 2 * alpha);
  }
}

export interface VirtualCameraLens {
  fov?: number;
  zoom?: number;
  near?: number;
  far?: number;
  orthographicSize?: number;
  /** Roll around the view axis in degrees (positive tilts the horizon CW). */
  dutchDeg?: number;
}

export interface VirtualCameraNoiseSettings {
  seed?: number;
  /** Camera-local position wobble amplitude in scene units (scalar or per-axis). */
  positionAmplitude?: number | Vec3;
  /** Position wobble frequency in Hz (scalar or per-axis; default 1). */
  positionFrequency?: number | Vec3;
  /** Local pitch/yaw/roll wobble amplitude in degrees (scalar or per-axis). */
  rotationAmplitudeDeg?: number | Vec3;
  /** Rotation wobble frequency in Hz (scalar or per-axis; default 1). */
  rotationFrequencyDeg?: number | Vec3;
}

export interface VirtualCameraSnapshot {
  name?: string;
  position: Vec3;
  quaternion: QuaternionLike;
  lens?: VirtualCameraLens;
  settings?: Record<string, number>;
}

/**
 * How an orbit body interprets its azimuth/elevation offset frame:
 * - `world`: angles in world (rig) axes; the target's rotation is ignored (a
 *   compass-anchored orbit — the shot holds as the target spins underneath).
 * - `lockYaw`: the frame follows the target's yaw only, world up preserved
 *   (level horizon, no roll); the camera stays on the same side as the target
 *   turns. The default target-relative mode.
 * - `lock`: the frame inherits the target's full orientation (yaw+pitch+roll);
 *   the camera is welded to the target and rolls/tilts with it.
 * Target-relative modes need the target's orientation from the resolve context;
 * when it is unavailable (a literal point, or no orientation registered) they
 * degrade to `world`.
 */
export type OrbitBinding = "world" | "lockYaw" | "lock";

/**
 * Per-axis interactive control for an orbit body, Cinemachine OrbitalFollow's
 * input-axis + recentering model:
 * - `locked`: user input ignored; the coded value is authoritative (the pure
 *   default — the camera holds its authored/auto-orbit pose).
 * - `free`: user input drives the axis and it stays where the user leaves it.
 * - `recenter`: user input drives the axis, then after `recenterWait` idle
 *   seconds it eases back to the coded value over ~`recenterTime` seconds
 *   (shortest angular path for azimuth).
 */
export type OrbitAxisMode = "locked" | "free" | "recenter";

export interface OrbitAxisControl {
  mode: OrbitAxisMode;
  /** Idle seconds before recentering begins (recenter mode; default 1). */
  recenterWait?: number;
  /** Seconds to ease back to the coded value (recenter mode; default 1). */
  recenterTime?: number;
}

/** Per-axis interactive control; an omitted axis (or omitted `control`) is `locked`. */
export interface OrbitControlSettings {
  azimuth?: OrbitAxisControl;
  elevation?: OrbitAxisControl;
  radius?: OrbitAxisControl;
}

export type VirtualCameraBodyDefinition =
  | { type: "static"; position: Vec3; quaternion: QuaternionLike }
  | { type: "cart"; cartId: string; positionOffset?: Vec3 }
  | {
      type: "orbit";
      /** Position source (distinct from the aim target); orbits around this point. */
      target: Vec3 | { targetId: string };
      /** Azimuth around the frame up in degrees; 0 sits on the frame +Z of the target. */
      azimuthDeg: number;
      /** Elevation above the horizon in degrees; clamped to ±80 off the poles. */
      elevationDeg: number;
      radius: number;
      /** Offset frame; defaults to `world` (compass-anchored). */
      binding?: OrbitBinding;
      /** Pure time-driven spin: azimuth advances by this × the resolve clock. */
      autoOrbitDegPerSec?: number;
      /** Interactive control per axis; omitted = all axes `locked` (coded-only). */
      control?: OrbitControlSettings;
    };

/**
 * Screen-composer framing: dead/soft zones as frame fractions (0..1), per-axis
 * damping heaviness (larger = slower reframe), a world-space target offset, and
 * lookahead. Consumed by the live, stateful composer stage in the drive-loop;
 * there is no "hard zone" — the soft edge is the clamp boundary.
 */
export interface ComposerSettings {
  /** Framing anchor in normalized screen space (0 = centre). */
  screenX: number;
  screenY: number;
  deadWidth: number;
  deadHeight: number;
  softWidth: number;
  softHeight: number;
  /** Per-axis damping heaviness (larger = slower); alpha = 1 - e^(-(12/damping)·dt). */
  dampingX: number;
  dampingY: number;
  /** World-space offset added to the tracked target before framing. */
  targetOffsetX: number;
  targetOffsetY: number;
  targetOffsetZ: number;
  lookaheadTime: number;
  lookaheadSmoothing: number;
  lookaheadIgnoreY: boolean;
  centerOnActivate: boolean;
}

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

/**
 * Aim at a target. `settings` selects the framing profile:
 * - omitted → instant look-at: the target is centred every frame, so it is
 *   pure/deterministic and `resolveVirtualCameraDefinition` computes it directly.
 * - present → the damped screen composer (dead/soft zones): stateful (depends on
 *   the previous frame), so it is a live post-stage owned by the drive-loop and
 *   pure resolution leaves the body orientation for the composer to damp from.
 * An instant look-at is just the degenerate composer, so there is one aim, not two.
 */
export type VirtualCameraAimDefinition =
  | { type: "body" }
  | { type: "track"; target: Vec3 | { targetId: string }; settings?: ComposerSettings };

export interface VirtualCameraDefinition {
  id: string;
  name?: string;
  body: VirtualCameraBodyDefinition;
  aim?: VirtualCameraAimDefinition;
  noise?: VirtualCameraNoiseSettings;
  lens?: VirtualCameraLens;
  settings?: Record<string, number>;
}

/** The tracked target id of a `track` aim that references a target by id, or null. */
export function vcamTrackTargetId(def: VirtualCameraDefinition): string | null {
  return def.aim?.type === "track" && "targetId" in def.aim.target
    ? def.aim.target.targetId
    : null;
}

export interface VirtualCameraResolveContext {
  getCartFrame?: (cartId: string) => CartFrame | null;
  getTargetPosition?: (targetId: string) => Vec3 | null;
  /** Live world orientation of a target, for target-relative orbit binding
   *  (`lockYaw`/`lock`); null (or absent) makes those bindings fall back to `world`. */
  getTargetOrientation?: (targetId: string) => QuaternionLike | null;
  /** Clock feeding the noise stage and auto-orbit; same time always yields the same pose. */
  elapsedSeconds?: number;
}
