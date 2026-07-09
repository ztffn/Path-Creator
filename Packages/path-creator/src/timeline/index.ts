// Timeline runtime: a pure evaluator — evaluateTimeline(timeline, rig, t) is
// a function of t with no internal clock, so scrubbing, playing, and network
// replay all produce identical frames — plus a thin stateful TimelinePlayer
// that owns play/pause/seek and edge-triggers events. Cart distances derive
// from t (keyframes or speed*t); camera blocks hold through gaps and blend
// with both shots resolved live, mirroring the brain's behavior.
import {
  TIMELINE_SCHEMA_VERSION,
  evaluateEasing,
  evaluateVirtualCameraBlendCurve,
  inverseLerp,
  lerp,
  sampleCartFrame,
  type CameraBlock,
  type CameraTrack,
  type CartFrame,
  type CartTrack,
  type PathCart,
  type QuaternionLike,
  type RigRuntime,
  type Timeline,
  type TimelineEvent,
  type Vec3,
  type VirtualCameraDefinition,
  type VirtualCameraLens,
  type VirtualCameraSnapshot
} from "../core";
import type { Camera, Matrix4 } from "three";
import {
  applyVirtualCameraSnapshot,
  blendVirtualCameraSnapshots,
  driveActivation,
  resolveVirtualCameraDefinition,
  setVirtualCameraBrainLive,
  stepComposerAim,
  stepShotOverride,
  type CameraOverrideInput,
  type RigActivationParams,
  type RigDriveResult,
  type RigDriveState
} from "../three";

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
  /** Target world orientation, for target-relative orbit binding (`lockYaw`/`lock`). */
  getTargetOrientation?: (targetId: string) => QuaternionLike | null;
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
/**
 * Fold a block's lens animation into its freshly-resolved snapshot at block-local t.
 * Runs before blend/apply, so overlapping blocks blend their time-varying lenses and
 * every host gets the animation for free (no per-frame override on the host side).
 */
function applyBlockLensAnimation(snapshot: VirtualCameraSnapshot, block: CameraBlock, t: number): void {
  if (!block.lensAnimation || block.end <= block.start) return;
  const local = inverseLerp(block.start, block.end, t);
  // Mutate the snapshot's own fresh lens in place (resolveVirtualCameraDefinition
  // already cloned it) — this runs per active block per frame.
  const lens: VirtualCameraLens = (snapshot.lens ??= {});
  for (const key in block.lensAnimation) {
    const field = block.lensAnimation[key as keyof VirtualCameraLens];
    if (field) lens[key as keyof VirtualCameraLens] = lerp(field.from, field.to, evaluateEasing(local, field.easing ?? "easeInOut"));
  }
}

export function evaluateTimeline(
  timeline: Timeline,
  context: TimelineRigContext,
  timeSeconds: number
): TimelineSample {
  // Accept any version up to current: older timelines (string-only easing) are
  // structurally compatible with the v2 easing union.
  if (timeline.schemaVersion < 1 || timeline.schemaVersion > TIMELINE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported timeline schema version ${String(timeline.schemaVersion)}; expected 1..${TIMELINE_SCHEMA_VERSION}`
    );
  }

  const t = Math.max(0, timeSeconds);
  const cartFrames = evaluateCartFrames(timeline, context, t);

  const resolveContext = {
    getCartFrame: (cartId: string) => cartFrames.get(cartId) ?? null,
    ...(context.getTargetPosition && { getTargetPosition: context.getTargetPosition }),
    ...(context.getTargetOrientation && { getTargetOrientation: context.getTargetOrientation }),
    elapsedSeconds: t
  };

  const resolveBlock = (block: CameraBlock): VirtualCameraSnapshot | null => {
    const definition = context.vcams.get(block.vcamId);
    if (!definition) return null;
    const patched = block.overrides ? { ...definition, ...block.overrides } : definition;
    const snapshot = resolveVirtualCameraDefinition(patched, resolveContext);
    if (snapshot && block.lensAnimation) applyBlockLensAnimation(snapshot, block, t);
    return snapshot;
  };

  let camera: VirtualCameraSnapshot | null = null;
  let activeBlock: TimelineSample["activeBlock"] = null;
  let blendProgress = 1;

  // Later camera tracks override earlier ones (layering).
  for (const track of timeline.tracks) {
    if (track.type !== "camera") continue;
    const result = evaluateCameraTrack(track, t, timeline.gapMode ?? "hold", resolveBlock);
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

export interface RigTimelineParams {
  camera: Camera;
  timeline: Timeline;
  player: TimelinePlayer;
  context: TimelineRigContext;
  /** Shared frames map the host reads (glyphs, cart-mounted targets). */
  cartFrames: Map<string, CartFrame>;
  up?: Vec3;
  /** World matrix of the group the rig is mounted under; composes rig-space poses
   *  into world so the driven (world-root) camera frames level under a rotated
   *  parent. Omit for a rig at world root (the default). */
  rigMatrix?: Matrix4;
  /** Live manual-override input for the active block's vcam (LMB/RMB/wheel deltas).
   *  The timeline picks WHICH vcam + blends; the vcam's override axes still respond
   *  per its `control` modes — like OrbitControls under a timeline. Omit for pure
   *  playback. */
  overrideInput?: CameraOverrideInput;
}

/**
 * Playback driver: step the clock, evaluate the timeline (which does block-to-
 * block blending itself), publish cart frames, then park the evaluated pose in
 * the shared brain and apply it — the brain stays the single live-pose holder so
 * a later activation blends from the true last pose. Runs the composer stage for
 * the active block's vcam against the same shared state, so aim continuity
 * survives a timeline->activation switch too (no double-blend: evaluateTimeline
 * already blended, the brain only parks). Used by playback: twin, elastiq
 * preview, final render.
 */
export function driveTimeline(
  state: RigDriveState,
  params: RigTimelineParams,
  deltaSeconds: number
): RigDriveResult {
  const { camera, timeline, player, context, cartFrames } = params;

  if (player.playing) stepTimelinePlayer(player, timeline, deltaSeconds);
  const sample = evaluateTimeline(timeline, context, player.time);

  for (const [cartId, frame] of sample.cartFrames) cartFrames.set(cartId, frame);

  if (!sample.camera) {
    // Released gap: nothing drives the camera; the host holds the last pose.
    state.composer.vcamId = null;
    state.body.vcamId = null;
    return {
      cameraSnapshot: null,
      activeVcamId: null,
      composerTarget: null,
      blendProgress: sample.blendProgress,
      blendDone: true
    };
  }

  const activeVcamId = sample.activeBlock?.block.vcamId ?? null;
  const definition = activeVcamId ? context.vcams.get(activeVcamId) ?? null : null;

  // Manual pivot-orbit override stays live under timeline playback: evaluateTimeline
  // stays pure (scrub-safe), and — mirroring how the composer overrides orientation
  // as a live post-stage — the override transforms the active shot's pose around its
  // pivot here. Stepped every frame to keep its state/damping alive; only applied
  // when not mid-blend, so block transitions remain the authored blend.
  const resolveTarget = context.getTargetPosition ?? (() => null);
  let pose = sample.camera;
  let overrideActive = false;
  if (definition) {
    // Mid-blend the override is stepped (to keep its damping/recenter state alive)
    // but not applied, so transitions stay the authored blend. Withhold input while
    // blending so a gesture doesn't silently accumulate and then jump the pose the
    // frame the blend completes — piloting takes effect once the block is fully live.
    const midBlend = sample.blendProgress < 1;
    const override = stepShotOverride(
      definition,
      sample.camera,
      resolveTarget,
      state.body,
      midBlend ? undefined : params.overrideInput,
      deltaSeconds
    );
    if (!midBlend) {
      pose = override.snapshot;
      overrideActive = override.active;
    }
  } else {
    state.body.vcamId = null;
  }

  setVirtualCameraBrainLive(state.brain, pose);
  applyVirtualCameraSnapshot(camera, pose, params.rigMatrix);

  let composerTarget: Vec3 | null = null;
  if (definition && !overrideActive) {
    composerTarget = stepComposerAim(
      camera,
      definition,
      state.composer,
      resolveTarget,
      deltaSeconds,
      params.up,
      params.rigMatrix
    );
  } else {
    state.composer.vcamId = null;
  }

  return {
    cameraSnapshot: pose,
    activeVcamId,
    composerTarget,
    blendProgress: sample.blendProgress,
    blendDone: true
  };
}

/**
 * What to drive this frame. `idle` holds the last pose (nothing drives the
 * camera); `timeline` plays the show; `activation` follows an explicit shot.
 * The camera is passed to driveRig(), so intents omit it.
 */
export type RigDriveIntent =
  | { mode: "idle" }
  | ({ mode: "timeline" } & Omit<RigTimelineParams, "camera">)
  | ({ mode: "activation" } & Omit<RigActivationParams, "camera">);

const IDLE_RESULT: RigDriveResult = {
  cameraSnapshot: null,
  activeVcamId: null,
  composerTarget: null,
  blendProgress: 1,
  blendDone: true
};

/**
 * Framework-agnostic drive dispatch: routes a per-frame RigDriveIntent to the
 * right driver (idle / timeline / activation) against one shared RigDriveState,
 * so any host drives the rig with a single call — the r3f `useRigDrive` hook is a
 * thin wrapper, and a non-r3f runtime (headless render, elastiq) calls this
 * directly with its own camera + loop. One shared brain + composer means position
 * and aim continuity survive a timeline<->activation switch.
 */
export function driveRig(
  state: RigDriveState,
  camera: Camera,
  intent: RigDriveIntent,
  deltaSeconds: number
): RigDriveResult {
  if (intent.mode === "timeline") {
    const { mode, ...params } = intent;
    return driveTimeline(state, { camera, ...params }, deltaSeconds);
  }
  if (intent.mode === "activation") {
    const { mode, ...params } = intent;
    return driveActivation(state, { camera, ...params }, deltaSeconds);
  }
  // Idle: mirror the activation idle path so re-entry re-activates cleanly.
  state.composer.vcamId = null;
  state.body.vcamId = null;
  state.activation = { key: null, vcamId: null };
  return { ...IDLE_RESULT, cameraSnapshot: state.brain.live ?? null };
}

function evaluateCameraTrack(
  track: CameraTrack,
  t: number,
  gapMode: "hold" | "release",
  resolveBlock: (block: CameraBlock) => VirtualCameraSnapshot | null
): { snapshot: VirtualCameraSnapshot; block: CameraBlock; blendProgress: number } | null {
  // Sorted-by-start is a construction invariant (sortTimelineTracks) so this
  // per-frame path never copies or sorts.
  const blocks = track.blocks;

  let activeIndex = -1;
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].start <= t) activeIndex = i;
  }
  // Before the first block the host camera is always free.
  if (activeIndex < 0) return null;

  const block = blocks[activeIndex];
  // In a gap after the block: "hold" keeps its shot until the next block,
  // "release" hands control back to the host's live camera.
  if (gapMode === "release" && t > block.end) return null;
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
  const keys = track.keys;
  if (keys.length === 0) return cart.distance;
  if (t <= keys[0].time) return keys[0].distance;

  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t > b.time) continue;
    const span = b.time - a.time;
    const raw = span > 0 ? (t - a.time) / span : 1;
    return lerp(a.distance, b.distance, evaluateVirtualCameraBlendCurve(raw, a.easing ?? "linear"));
  }

  return keys[keys.length - 1].distance;
}
