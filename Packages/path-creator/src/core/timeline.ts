// Timeline schema: the versioned, persistable description of a show —
// camera blocks (which vcam is live, with blend-in windows and per-block
// definition overrides such as retargets), cart distance keyframes, and
// opaque host events. Pure data with no engine dependency; the evaluator
// and player live in the timeline entry point.
import { normalizeEasing } from "./easing";
import type { Easing } from "./easing";
import type { VirtualCameraBlendCurve, VirtualCameraDefinition, VirtualCameraLens } from "./virtual-camera";

// v2: CartKey.easing / TimelineBlendIn.curve accept a custom cubic-bezier object
// (in addition to the named presets); legacy string easing stays valid.
// v3: CameraBlock.lensAnimation — a per-field lens push/pull over the block window.
export const TIMELINE_SCHEMA_VERSION = 3;

export interface TimelineBlendIn {
  durationSeconds: number;
  curve?: VirtualCameraBlendCurve;
}

/**
 * A single lens field eased from `from`→`to` across a block's window (block-local
 * t, normalized 0..1). `easing` defaults to easeInOut. The resolved value replaces
 * that field on the block's snapshot before blend/apply — so it composes with
 * block-to-block blends automatically.
 */
export interface LensFieldAnimation {
  from: number;
  to: number;
  easing?: Easing;
}

/** Per-field lens automation over a CameraBlock (any numeric lens field). */
export type CameraBlockLensAnimation = Partial<Record<keyof VirtualCameraLens, LensFieldAnimation>>;

export interface CameraBlock {
  id: string;
  vcamId: string;
  start: number;
  end: number;
  /** Blend from the previous block's shot over this window; omit to cut. */
  blendIn?: TimelineBlendIn;
  /**
   * Shallow per-field patch of the vcam definition while this block is live
   * (e.g. { aim: { type: "track", target: { targetId } } } retargets the
   * shot). A patched field replaces the definition's field entirely.
   */
  overrides?: Partial<Omit<VirtualCameraDefinition, "id">>;
  /**
   * Lens fields that animate across this block (e.g. a FOV push). Sampled at
   * block-local t and folded into the resolved lens; blends with neighbours.
   */
  lensAnimation?: CameraBlockLensAnimation;
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
  /**
   * Camera behavior in gaps between blocks: "hold" keeps the last shot
   * (editing-software semantics, default); "release" returns null so the
   * host's live camera takes over (Cinemachine semantics).
   */
  gapMode?: "hold" | "release";
  tracks: TimelineTrack[];
}

export function createTimeline(init: Partial<Omit<Timeline, "schemaVersion">> = {}): Timeline {
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    duration: init.duration ?? 0,
    ...(init.gapMode && { gapMode: init.gapMode }),
    tracks: sortTimelineTracks(init.tracks ?? [])
  };
}

/**
 * Coerce every easing value in a timeline (cart-key easing, camera blend curves) through
 * normalizeEasing, so a malformed/foreign persisted easing degrades to a valid preset
 * rather than reaching the evaluator as NaN. Applied at the deserialization boundary.
 */
/** Coerce each animated lens field's easing through normalizeEasing (deserialize boundary). */
function normalizeLensAnimationEasing(anim: CameraBlockLensAnimation): CameraBlockLensAnimation {
  const out: CameraBlockLensAnimation = {};
  for (const [key, field] of Object.entries(anim) as [keyof VirtualCameraLens, LensFieldAnimation][]) {
    out[key] = field.easing === undefined ? field : { ...field, easing: normalizeEasing(field.easing) };
  }
  return out;
}

export function normalizeTimelineEasing<T extends Timeline>(timeline: T): T {
  const tracks = timeline.tracks.map((track): TimelineTrack => {
    if (track.type === "cart") {
      return { ...track, keys: track.keys.map((k) => (k.easing === undefined ? k : { ...k, easing: normalizeEasing(k.easing) })) };
    }
    if (track.type === "camera") {
      return {
        ...track,
        blocks: track.blocks.map((b) => {
          const blendIn =
            b.blendIn?.curve === undefined ? b.blendIn : { ...b.blendIn, curve: normalizeEasing(b.blendIn.curve) };
          const lensAnimation = b.lensAnimation && normalizeLensAnimationEasing(b.lensAnimation);
          if (blendIn === b.blendIn && lensAnimation === undefined) return b;
          return { ...b, ...(blendIn && { blendIn }), ...(lensAnimation && { lensAnimation }) };
        })
      };
    }
    return track;
  });
  return { ...timeline, tracks };
}

/**
 * Returns tracks with blocks/keys/events sorted by time. Evaluation relies on
 * this order as an invariant so the per-frame hot path never sorts; construct
 * timelines via createTimeline (or run documents through buildRigRuntime),
 * and re-sort after editing block times.
 */
export function sortTimelineTracks(tracks: TimelineTrack[]): TimelineTrack[] {
  return tracks.map((track) => {
    if (track.type === "camera") {
      return { ...track, blocks: [...track.blocks].sort((a, b) => a.start - b.start) };
    }
    if (track.type === "cart") {
      return { ...track, keys: [...track.keys].sort((a, b) => a.time - b.time) };
    }
    return { ...track, events: [...track.events].sort((a, b) => a.time - b.time) };
  });
}
