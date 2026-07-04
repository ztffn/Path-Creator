// Timeline schema: the versioned, persistable description of a show —
// camera blocks (which vcam is live, with blend-in windows and per-block
// definition overrides such as retargets), cart distance keyframes, and
// opaque host events. Pure data with no engine dependency; the evaluator
// and player live in the timeline entry point.
import type { VirtualCameraBlendCurve, VirtualCameraDefinition } from "./virtual-camera";

export const TIMELINE_SCHEMA_VERSION = 1;

export interface TimelineBlendIn {
  durationSeconds: number;
  curve?: VirtualCameraBlendCurve;
}

export interface CameraBlock {
  id: string;
  vcamId: string;
  start: number;
  end: number;
  /** Blend from the previous block's shot over this window; omit to cut. */
  blendIn?: TimelineBlendIn;
  /**
   * Shallow per-field patch of the vcam definition while this block is live
   * (e.g. { aim: { type: "look-at", target: { targetId } } } retargets the
   * shot). A patched field replaces the definition's field entirely.
   */
  overrides?: Partial<Omit<VirtualCameraDefinition, "id">>;
}

export interface CameraTrack {
  type: "camera";
  id: string;
  name?: string;
  blocks: CameraBlock[];
}

export interface CartKey {
  time: number;
  distance: number;
  /** Interpolation from this key to the next (default linear). */
  easing?: VirtualCameraBlendCurve;
}

export interface CartTrack {
  type: "cart";
  id: string;
  name?: string;
  cartId: string;
  keys: CartKey[];
}

export interface TimelineEvent {
  id: string;
  time: number;
  kind: string;
  payload?: unknown;
}

export interface EventTrack {
  type: "event";
  id: string;
  name?: string;
  events: TimelineEvent[];
}

export type TimelineTrack = CameraTrack | CartTrack | EventTrack;

export interface Timeline {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  duration: number;
  tracks: TimelineTrack[];
}

export function createTimeline(init: Partial<Omit<Timeline, "schemaVersion">> = {}): Timeline {
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    duration: init.duration ?? 0,
    tracks: init.tracks ?? []
  };
}
