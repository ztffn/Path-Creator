// Timeline runtime: a pure evaluator — evaluateTimeline(timeline, rig, t) is
// a function of t with no internal clock, so scrubbing, playing, and network
// replay all produce identical frames — plus a thin stateful TimelinePlayer
// that owns play/pause/seek and edge-triggers events. Cart distances derive
// from t (keyframes or speed*t); camera blocks hold through gaps and blend
// with both shots resolved live, mirroring the brain's behavior.
import {
  TIMELINE_SCHEMA_VERSION,
  sampleCartFrame,
  type CameraBlock,
  type CameraTrack,
  type CartFrame,
  type CartTrack,
  type PathCart,
  type RigRuntime,
  type Timeline,
  type TimelineEvent,
  type Vec3,
  type VirtualCameraDefinition,
  type VirtualCameraSnapshot
} from "../core";
import { blendVirtualCameraSnapshots, evaluateVirtualCameraBlendCurve, resolveVirtualCameraDefinition } from "../three";

export type {
  CameraBlock,
  CameraTrack,
  CartKey,
  CartTrack,
  EventTrack,
  Timeline,
  TimelineBlendIn,
  TimelineEvent,
  TimelineTrack
} from "../core";
export { TIMELINE_SCHEMA_VERSION, createTimeline } from "../core";

export interface TimelineRigContext {
  rig: Pick<RigRuntime, "paths" | "carts" | "cartPaths">;
  vcams: Map<string, VirtualCameraDefinition>;
  getTargetPosition?: (targetId: string) => Vec3 | null;
}

export interface TimelineSample {
  camera: VirtualCameraSnapshot | null;
  cartFrames: Map<string, CartFrame>;
  activeBlock: { trackId: string; block: CameraBlock } | null;
  /** 1 outside a blend window. */
  blendProgress: number;
}

/**
 * Pure evaluation at time t. Determinism contract: same (timeline, context,
 * t) always yields the same sample — carts are positioned from t, never
 * stepped, and noise reads t through the resolve context.
 */
export function evaluateTimeline(
  timeline: Timeline,
  context: TimelineRigContext,
  timeSeconds: number
): TimelineSample {
  if (timeline.schemaVersion !== TIMELINE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported timeline schema version ${String(timeline.schemaVersion)}; expected ${TIMELINE_SCHEMA_VERSION}`
    );
  }

  const t = Math.max(0, timeSeconds);
  const cartFrames = evaluateCartFrames(timeline, context, t);

  const resolveContext = {
    getCartFrame: (cartId: string) => cartFrames.get(cartId) ?? null,
    ...(context.getTargetPosition && { getTargetPosition: context.getTargetPosition }),
    elapsedSeconds: t
  };

  const resolveBlock = (block: CameraBlock): VirtualCameraSnapshot | null => {
    const definition = context.vcams.get(block.vcamId);
    if (!definition) return null;
    const patched = block.overrides ? { ...definition, ...block.overrides } : definition;
    return resolveVirtualCameraDefinition(patched, resolveContext);
  };

  let camera: VirtualCameraSnapshot | null = null;
  let activeBlock: TimelineSample["activeBlock"] = null;
  let blendProgress = 1;

  // Later camera tracks override earlier ones (layering).
  for (const track of timeline.tracks) {
    if (track.type !== "camera") continue;
    const result = evaluateCameraTrack(track, t, resolveBlock);
    if (result) {
      camera = result.snapshot;
      activeBlock = { trackId: track.id, block: result.block };
      blendProgress = result.blendProgress;
    }
  }

  return { camera, cartFrames, activeBlock, blendProgress };
}

/** Events with t0 < time <= t1; empty when scrubbing backwards (t1 < t0). */
export function collectTimelineEvents(
  timeline: Timeline,
  fromSeconds: number,
  toSeconds: number
): TimelineEvent[] {
  if (toSeconds < fromSeconds) return [];
  const fired: TimelineEvent[] = [];
  for (const track of timeline.tracks) {
    if (track.type !== "event") continue;
    for (const event of track.events) {
      if (event.time > fromSeconds && event.time <= toSeconds) {
        fired.push(event);
      }
    }
  }
  return fired.sort((a, b) => a.time - b.time);
}

export interface TimelinePlayer {
  time: number;
  playing: boolean;
  rate: number;
  loop: boolean;
}

export function createTimelinePlayer(init: Partial<TimelinePlayer> = {}): TimelinePlayer {
  return {
    time: init.time ?? 0,
    playing: init.playing ?? false,
    rate: init.rate ?? 1,
    loop: init.loop ?? false
  };
}

/**
 * Advances the player clock and returns events crossed this step, fired
 * exactly once each. Pauses at the end unless looping (loop wraps and fires
 * the pre-wrap remainder's events only, to keep edges unambiguous).
 */
export function stepTimelinePlayer(
  player: TimelinePlayer,
  timeline: Timeline,
  deltaSeconds: number
): TimelineEvent[] {
  if (!player.playing || deltaSeconds <= 0) return [];

  const from = player.time;
  let to = from + deltaSeconds * player.rate;

  if (to >= timeline.duration) {
    if (player.loop && timeline.duration > 0) {
      const fired = collectTimelineEvents(timeline, from, timeline.duration);
      player.time = (to - timeline.duration) % timeline.duration;
      return fired;
    }
    to = timeline.duration;
    player.playing = false;
  }

  player.time = to;
  return collectTimelineEvents(timeline, from, to);
}

/** Jumps the clock without firing events (scrub semantics). */
export function seekTimelinePlayer(player: TimelinePlayer, timeSeconds: number): void {
  player.time = Math.max(0, timeSeconds);
}

function evaluateCameraTrack(
  track: CameraTrack,
  t: number,
  resolveBlock: (block: CameraBlock) => VirtualCameraSnapshot | null
): { snapshot: VirtualCameraSnapshot; block: CameraBlock; blendProgress: number } | null {
  const blocks = [...track.blocks].sort((a, b) => a.start - b.start);

  let activeIndex = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].start <= t) activeIndex = i;
  }
  // Before the first block the host camera is free; gaps after a block hold
  // its shot until the next block starts.
  if (activeIndex < 0) return null;

  const block = blocks[activeIndex];
  const snapshot = resolveBlock(block);
  if (!snapshot) return null;

  const blend = block.blendIn;
  if (blend && blend.durationSeconds > 0 && blend.curve !== "cut" && activeIndex > 0) {
    const progress = (t - block.start) / blend.durationSeconds;
    if (progress < 1) {
      const previous = resolveBlock(blocks[activeIndex - 1]);
      if (previous) {
        return {
          snapshot: blendVirtualCameraSnapshots(previous, snapshot, progress, {
            curve: blend.curve ?? "easeInOut"
          }),
          block,
          blendProgress: progress
        };
      }
    }
  }

  return { snapshot, block, blendProgress: 1 };
}

function evaluateCartFrames(
  timeline: Timeline,
  context: TimelineRigContext,
  t: number
): Map<string, CartFrame> {
  const cartTracks = new Map<string, CartTrack>();
  for (const track of timeline.tracks) {
    if (track.type === "cart") cartTracks.set(track.cartId, track);
  }

  const frames = new Map<string, CartFrame>();
  for (const [cartId, cart] of context.rig.carts) {
    const pathId = context.rig.cartPaths.get(cartId);
    const path = pathId ? context.rig.paths.get(pathId) : undefined;
    if (!path) continue;

    const track = cartTracks.get(cartId);
    const distance = track
      ? evaluateCartKeys(track, cart, t)
      : cart.distance + cart.speed * t;
    frames.set(cartId, sampleCartFrame(path, cart, distance));
  }
  return frames;
}

function evaluateCartKeys(track: CartTrack, cart: PathCart, t: number): number {
  const keys = [...track.keys].sort((a, b) => a.time - b.time);
  if (keys.length === 0) return cart.distance;
  if (t <= keys[0].time) return keys[0].distance;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t > b.time) continue;
    const span = b.time - a.time;
    const raw = span > 0 ? (t - a.time) / span : 1;
    const alpha = evaluateVirtualCameraBlendCurve(raw, a.easing ?? "linear");
    return a.distance + (b.distance - a.distance) * alpha;
  }

  return keys[keys.length - 1].distance;
}
