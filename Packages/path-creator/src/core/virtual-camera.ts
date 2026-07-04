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

export type VirtualCameraBodyDefinition =
  | { type: "static"; position: Vec3; quaternion: QuaternionLike }
  | { type: "cart"; cartId: string; positionOffset?: Vec3 };

export type VirtualCameraAimDefinition =
  | { type: "body" }
  | { type: "look-at"; target: Vec3 | { targetId: string } };

export interface VirtualCameraDefinition {
  id: string;
  name?: string;
  body: VirtualCameraBodyDefinition;
  aim?: VirtualCameraAimDefinition;
  noise?: VirtualCameraNoiseSettings;
  lens?: VirtualCameraLens;
  settings?: Record<string, number>;
}

export interface VirtualCameraResolveContext {
  getCartFrame?: (cartId: string) => CartFrame | null;
  getTargetPosition?: (targetId: string) => Vec3 | null;
  /** Clock feeding the noise stage; same time always yields the same pose. */
  elapsedSeconds?: number;
}
