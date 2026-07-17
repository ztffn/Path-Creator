// Timeline runtime: a pure evaluator — evaluateTimeline(timeline, rig, t) is
// a function of t with no internal clock, so scrubbing, playing, and network
// replay all produce identical frames — plus a thin stateful TimelinePlayer
// that owns play/pause/seek and edge-triggers events. Cart distances derive
// from t (keyframes or speed*t); camera blocks hold through gaps and blend
// with both shots resolved live, mirroring the brain's behavior.
import {
  TIMELINE_SCHEMA_VERSION,
  createArmState,
  evaluateEasing,
  evaluateSceneLayers,
  evaluateVirtualCameraBlendCurve,
  inverseLerp,
  lerp,
  sampleCartFrame,
  stepArmPolicy,
  stepProximity,
  type ActionDefinition,
  type ArmState,
  type ProximityState,
  type TriggerBinding,
  type TriggerDefinition,
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
  type VirtualCameraBlendCurve,
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
  ActivationClip,
  ActivationTrack,
  AnimationClip,
  AnimationTrack,
  AudioClip,
  AudioTrack,
  CameraBlock,
  CameraTrack,
  CartKey,
  CartTrack,
  EventTrack,
  SceneClip,
  SceneLayer,
  SceneTrack,
  Timeline,
  TimelineBlendIn,
  TimelineEvent,
  TimelineTrack,
  TransformKey,
  TransformTrack
} from "../core";
export {
  TIMELINE_SCHEMA_VERSION,
  createTimeline,
  evaluateActivation,
  evaluateAnimation,
  evaluateAudio,
  evaluateSceneLayers,
  evaluateTransform,
  insertTransformKey,
  snapSeconds,
  transformKeyTimes,
  transformSpan,
  upsertTransformKey
} from "../core";

export interface TimelineRigContext {
  rig: Pick<RigRuntime, "paths" | "carts" | "cartPaths">;
  vcams: Map<string, VirtualCameraDefinition>;
  getTargetPosition?: (targetId: string) => Vec3 | null;
  /** Target world orientation, for target-relative orbit binding (`lockYaw`/`lock`). */
  getTargetOrientation?: (targetId: string) => QuaternionLike | null;
  /** Resolves a Story scene by id, enabling scene tracks (deterministic
   *  master-embed). Omit to leave scene tracks inert. */
  getScene?: (sceneId: string) => Timeline | null;
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

  // Later camera/scene tracks override earlier ones (layering).
  for (const track of timeline.tracks) {
    if (track.type === "camera") {
      const result = evaluateCameraTrack(track, t, timeline.gapMode ?? "hold", resolveBlock);
      if (result) {
        camera = result.snapshot;
        activeBlock = { trackId: track.id, block: result.block };
        blendProgress = result.blendProgress;
      }
    } else if (track.type === "scene" && context.getScene) {
      // Deterministic master-embed: evaluate the embedded scene at its mapped
      // local time. Depth-1 by construction — the sub-evaluation gets no
      // getScene, so nested (and self-referential) scene tracks are inert.
      const { getScene, ...subContext } = context;
      for (const layer of evaluateSceneLayers([track], getScene, t)) {
        const sub = evaluateTimeline(layer.timeline, subContext, layer.time);
        // Merge only carts the embedded scene actually TRACKS — its free-running
        // defaults for other carts must not clobber the master's frames.
        for (const subTrack of layer.timeline.tracks) {
          if (subTrack.type !== "cart") continue;
          const frame = sub.cartFrames.get(subTrack.cartId);
          if (frame) cartFrames.set(subTrack.cartId, frame);
        }
        if (sub.camera) {
          // Boundary blend: ease between the underlying camera and the embedded
          // scene's over blendSeconds at each window edge (0 = hard cut). Pure
          // in t, so scrubbing across the edge stays exact.
          const blend = layer.clip.blendSeconds ?? 0;
          let pose = sub.camera;
          if (blend > 0 && camera) {
            const factor = Math.max(
              0,
              Math.min(1, (t - layer.clip.start) / blend, (layer.clip.end - t) / blend)
            );
            if (factor < 1) {
              pose = blendVirtualCameraSnapshots(camera, sub.camera, factor, { curve: "easeInOut" });
            }
          }
          camera = pose;
          activeBlock = sub.activeBlock;
          blendProgress = sub.blendProgress;
        }
      }
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

// --- Active-scene runtime -----------------------------------------------------
// The stateful layer above the pure per-scene evaluators: it owns the branch
// (which scene is invoked, its local clock, the camera take/blend/release
// handoff) so evaluateTimeline stays a pure f(t). A sibling of the other
// stateful post-stages (stepCameraOverride, driveActivation): plain mutable
// state stepped once per frame by the host's drive loop.

/** Invoke a scene as a live branch (the runtime's only entry besides stop). */
export interface PlaySceneCommand {
  sceneId: string;
  /** Scene-local start time (default 0). */
  fromTime?: number;
  /** When true (default), user override input cancels the camera takeover and
   *  blends back early. Only meaningful while the scene owns the camera. */
  skippable?: boolean;
  /** Take/release handoff blend (default 1s easeInOut; 0 or "cut" snaps). */
  blend?: { durationSeconds?: number; curve?: VirtualCameraBlendCurve };
}

interface ActiveScene {
  sceneId: string;
  /** The scene's local clock — independent of the master player. */
  player: TimelinePlayer;
  skippable: boolean;
  blendSeconds: number;
  blendCurve: VirtualCameraBlendCurve;
  ownsCamera: boolean;
  /** take = blending caller→scene, live = scene owns, release = blending back. */
  phase: "take" | "live" | "release";
  phaseElapsed: number;
  /** Caller pose frozen at invocation: take-blend source, and the release
   *  target when the base intent is idle (the pose the user had). */
  takeFrom: VirtualCameraSnapshot | null;
  /** Scene pose frozen at completion/cancel: release-blend source. */
  releaseFrom: VirtualCameraSnapshot | null;
  /** The master player was playing at invocation; resume it on return. */
  resumeMaster: boolean;
}

export interface SceneRuntimeState {
  pending: PlaySceneCommand | null;
  active: ActiveScene | null;
  /** Set by stopScene; the next drive step begins the release. */
  stopRequested: boolean;
}

export function createSceneRuntimeState(): SceneRuntimeState {
  return { pending: null, active: null, stopRequested: false };
}

/** Queue a scene invocation; it takes effect on the next drive step (which
 *  freezes the caller's live pose as the blend source). Replaces any active
 *  scene. */
export function playScene(state: SceneRuntimeState, command: PlaySceneCommand): void {
  state.pending = { ...command };
  state.stopRequested = false;
}

/** Request an early return: the active scene blends back (or snaps, for a
 *  camera-less scene) on the next drive step. */
export function stopScene(state: SceneRuntimeState): void {
  state.pending = null;
  if (state.active) state.stopRequested = true;
}

export interface SceneDriveParams {
  camera: Camera;
  /** Scenes by id (e.g. RigRuntime.timelines). */
  scenes: ReadonlyMap<string, Timeline>;
  /** Resolve context the scenes evaluate against (usually the master's). */
  context: TimelineRigContext;
  /** Shared frames map the host reads; scene cart tracks publish into it. */
  cartFrames: Map<string, CartFrame>;
  /** What drives when no scene is active — and the pose control returns to on
   *  release. Give it its own overrideInput exactly as for driveRig. */
  base: RigDriveIntent;
  /** This frame's user override input, for the skippable cancel edge. Pass the
   *  same object embedded in `base`. */
  overrideInput?: CameraOverrideInput;
  up?: Vec3;
  rigMatrix?: Matrix4;
}

export interface SceneDriveResult extends RigDriveResult {
  /** The invoked scene this frame, or null when the base intent drove. While
   *  set, hosts feed their non-camera directors (activation/audio/animation/
   *  transform) from this timeline + local time instead of the master's. */
  activeScene: { sceneId: string; timeline: Timeline; time: number; playing: boolean } | null;
  /** Take/release handoff progress (1 outside a handoff blend). */
  handoffProgress: number;
}

const freezeSnapshot = (snapshot: VirtualCameraSnapshot): VirtualCameraSnapshot => ({
  ...snapshot,
  position: { ...snapshot.position },
  quaternion: { ...snapshot.quaternion },
  ...(snapshot.lens && { lens: { ...snapshot.lens } }),
  ...(snapshot.settings && { settings: { ...snapshot.settings } })
});

const hasOverrideInput = (input: CameraOverrideInput | undefined): boolean =>
  input !== undefined &&
  ((input.azimuthDeltaDeg ?? 0) !== 0 ||
    (input.elevationDeltaDeg ?? 0) !== 0 ||
    (input.panXDelta ?? 0) !== 0 ||
    (input.panYDelta ?? 0) !== 0 ||
    (input.dollyDelta ?? 0) !== 0);

/** The scene owns the camera iff it has a camera track with blocks (mirrors
 *  core's sceneOwnsCamera; local so the runtime works on any Timeline). */
const timelineOwnsCamera = (timeline: Timeline): boolean =>
  timeline.tracks.some((track) => track.type === "camera" && track.blocks.length > 0);

/** The master player of the base intent, when it has one. */
const basePlayer = (base: RigDriveIntent): TimelinePlayer | null =>
  base.mode === "timeline" ? base.player : null;

/** The pose the base intent would show right now — the release-blend target.
 *  Falls back to the frozen caller pose (idle base, released gaps). */
function resolveBaseCameraPose(base: RigDriveIntent): VirtualCameraSnapshot | null {
  if (base.mode === "timeline") {
    return evaluateTimeline(base.timeline, base.context, base.player.time).camera;
  }
  if (base.mode === "activation" && base.activeVcamId) {
    const definition = base.vcams.get(base.activeVcamId);
    if (definition) return resolveVirtualCameraDefinition(definition, base.context);
  }
  return null;
}

function finishActiveScene(state: SceneRuntimeState, base: RigDriveIntent): void {
  const master = basePlayer(base);
  if (state.active?.resumeMaster && master) master.playing = true;
  state.active = null;
  state.stopRequested = false;
}

/**
 * Drive dispatch with the active-scene runtime layered on top of driveRig:
 * with no invoked scene it is exactly driveRig(base); with one, the scene's
 * local clock advances, its cart tracks publish, and — when the scene owns a
 * camera — the take/live/release handoff drives the camera (caller pose →
 * scene camera → back), bypassing composer/override for the takeover's
 * duration. A camera-less scene leaves the camera entirely to the base intent.
 * The master player pauses for the branch and resumes on return.
 */
export function driveRigWithScenes(
  scenes: SceneRuntimeState,
  state: RigDriveState,
  params: SceneDriveParams,
  deltaSeconds: number
): SceneDriveResult {
  const { camera, base } = params;

  // Activate a pending invocation: freeze the caller pose, pause the master.
  if (scenes.pending) {
    const command = scenes.pending;
    scenes.pending = null;
    const timeline = params.scenes.get(command.sceneId);
    if (timeline) {
      const master = basePlayer(base);
      const resumeMaster = scenes.active?.resumeMaster ?? Boolean(master?.playing);
      if (master) master.playing = false;
      const takeFrom = state.brain.live ? freezeSnapshot(state.brain.live) : null;
      const ownsCamera = timelineOwnsCamera(timeline);
      const blendSeconds =
        command.blend?.curve === "cut" ? 0 : Math.max(0, command.blend?.durationSeconds ?? 1);
      scenes.active = {
        sceneId: command.sceneId,
        player: createTimelinePlayer({ time: Math.max(0, command.fromTime ?? 0), playing: true }),
        skippable: command.skippable ?? true,
        blendSeconds,
        blendCurve: command.blend?.curve ?? "easeInOut",
        ownsCamera,
        phase: ownsCamera && takeFrom && blendSeconds > 0 ? "take" : "live",
        phaseElapsed: 0,
        takeFrom,
        releaseFrom: null,
        resumeMaster
      };
      scenes.stopRequested = false;
    }
  }

  const active = scenes.active;
  const timeline = active ? params.scenes.get(active.sceneId) : undefined;

  // Author deleted the scene mid-flight: return control without a blend source.
  if (active && !timeline) finishActiveScene(scenes, base);

  if (!active || !timeline) {
    const result = driveRig(state, camera, base, deltaSeconds);
    return { ...result, activeScene: null, handoffProgress: 1 };
  }

  // The frame that begins the release spent its dt playing the scene tail (or
  // detecting the cancel); it renders the frozen pose at progress 0 and the
  // blend advances from the next frame, so no dt is double-counted.
  let releaseJustBegan = false;
  const beginRelease = (): void => {
    active.phase = "release";
    active.phaseElapsed = 0;
    active.releaseFrom = state.brain.live ? freezeSnapshot(state.brain.live) : null;
    active.player.playing = false;
    releaseJustBegan = true;
  };

  // A skippable takeover cancels on the first user gesture; stopScene() ends
  // any scene. Camera-less scenes stop immediately (nothing to blend back).
  const cancelled =
    scenes.stopRequested ||
    (active.skippable && active.ownsCamera && active.phase !== "release" && hasOverrideInput(params.overrideInput));
  scenes.stopRequested = false;
  if (cancelled) {
    if (active.ownsCamera && active.blendSeconds > 0) beginRelease();
    else {
      finishActiveScene(scenes, base);
      const result = driveRig(state, camera, base, deltaSeconds);
      return { ...result, activeScene: null, handoffProgress: 1 };
    }
  }

  if (active.player.playing) stepTimelinePlayer(active.player, timeline, deltaSeconds);

  // Completion: the local clock reached the end (stepTimelinePlayer paused it).
  if (!active.player.playing && active.phase !== "release") {
    if (active.ownsCamera && active.blendSeconds > 0) beginRelease();
    else if (active.player.time >= timeline.duration) {
      finishActiveScene(scenes, base);
      const result = driveRig(state, camera, base, deltaSeconds);
      return { ...result, activeScene: null, handoffProgress: 1 };
    }
  }

  const sample = evaluateTimeline(timeline, params.context, active.player.time);
  for (const [cartId, frame] of sample.cartFrames) params.cartFrames.set(cartId, frame);

  const activeScene = {
    sceneId: active.sceneId,
    timeline,
    time: active.player.time,
    playing: active.player.playing
  };

  // Camera-less scene: the base intent keeps the camera (user piloting intact);
  // only the local clock + cart frames above belong to the scene.
  if (!active.ownsCamera) {
    const result = driveRig(state, camera, base, deltaSeconds);
    return { ...result, activeScene, handoffProgress: 1 };
  }

  // Camera handoff. The scene's evaluated shot (with its own block blends) is
  // the target; take/release wrap it in the invocation blend. While the scene
  // owns the camera the composer/override stages idle so they reseed cleanly.
  const held = state.brain.live ?? null;
  const sceneCam = sample.camera ?? held;
  let pose: VirtualCameraSnapshot | null = sceneCam;
  let handoffProgress = 1;

  if (active.phase === "take") {
    active.phaseElapsed += Math.max(0, deltaSeconds);
    const progress =
      active.blendSeconds > 0 ? Math.min(1, active.phaseElapsed / active.blendSeconds) : 1;
    handoffProgress = progress;
    if (active.takeFrom && sceneCam && progress < 1) {
      pose = blendVirtualCameraSnapshots(active.takeFrom, sceneCam, progress, {
        curve: active.blendCurve
      });
    }
    if (progress >= 1) active.phase = "live";
  } else if (active.phase === "release") {
    if (!releaseJustBegan) active.phaseElapsed += Math.max(0, deltaSeconds);
    const progress =
      active.blendSeconds > 0 ? Math.min(1, active.phaseElapsed / active.blendSeconds) : 1;
    handoffProgress = progress;
    const target = resolveBaseCameraPose(base) ?? active.takeFrom ?? active.releaseFrom;
    if (active.releaseFrom && target) {
      pose =
        progress < 1
          ? blendVirtualCameraSnapshots(active.releaseFrom, target, progress, {
              curve: active.blendCurve
            })
          : target;
    } else {
      pose = target ?? pose;
    }
    if (progress >= 1) {
      finishActiveScene(scenes, base);
      // Hand the base drivers a clean slate next frame; this frame holds the
      // landed pose so there is no double-step.
    }
  }

  state.composer.vcamId = null;
  state.body.vcamId = null;
  if (pose) {
    setVirtualCameraBrainLive(state.brain, pose);
    applyVirtualCameraSnapshot(camera, pose, params.rigMatrix);
  }

  return {
    cameraSnapshot: pose,
    activeVcamId: sample.activeBlock?.block.vcamId ?? null,
    composerTarget: null,
    blendProgress: sample.blendProgress,
    blendDone: sample.blendProgress >= 1,
    activeScene: scenes.active ? activeScene : { ...activeScene, playing: false },
    handoffProgress
  };
}

// --- Reactive trigger runtime ---------------------------------------------------
// The stateful bridge between live world state and the pure trigger predicates:
// consumes a per-frame snapshot (camera position, entity resolver, forward-
// playback windows, clicks), steps each trigger's proximity/arm state through
// the /core reducers, and emits the bound action commands for the host (and the
// scene runtime) to execute. Present-mode only; inert (and reset) otherwise.

export interface TriggerWorldSnapshot {
  /** Present-mode gate: while false (authoring, scrubbing) every trigger is
   *  inert and volatile state resets, so scrubs can never fire anything. */
  present: boolean;
  /** The live camera's world position — the proximity subject. */
  cameraPosition: Vec3 | null;
  /** Live world position of a proximity target (target/entity id). */
  resolvePosition: (id: string) => Vec3 | null;
  /** Object ids clicked this frame (present-mode pointer). */
  clicks?: readonly string[];
  /** Forward-playback windows advanced this frame, one per playing clock:
   *  marker events in (from, to] fire. Report ONLY real playback steps —
   *  never scrubs or seeks. */
  playback?: readonly { sceneId?: string; timeline: Timeline; from: number; to: number }[];
  /** Freeze proximity state this frame (no edges, no re-arms) — set while a
   *  runtime takeover drives the camera, so its motion can't churn triggers. */
  holdProximity?: boolean;
}

export interface TriggerCommand {
  triggerId: string;
  bindingId: string;
  action: ActionDefinition;
  priority: number;
}

export interface TriggerRuntimeState {
  proximity: Map<string, ProximityState>;
  arm: Map<string, ArmState>;
}

export function createTriggerRuntimeState(): TriggerRuntimeState {
  return { proximity: new Map(), arm: new Map() };
}

export interface TriggerRuntimeInput {
  triggers: readonly TriggerDefinition[];
  actions: readonly ActionDefinition[];
  bindings: readonly TriggerBinding[];
}

/** The commands bound to one trigger (also the simulate affordance's path). */
export function resolveTriggerCommands(defs: TriggerRuntimeInput, triggerId: string): TriggerCommand[] {
  const commands: TriggerCommand[] = [];
  for (const binding of defs.bindings) {
    if (binding.triggerId !== triggerId) continue;
    const action = defs.actions.find((candidate) => candidate.id === binding.actionId);
    if (action) {
      commands.push({ triggerId, bindingId: binding.id, action, priority: binding.priority ?? 0 });
    }
  }
  return commands;
}

/**
 * One trigger-runtime step. Deterministic in (state, defs, snapshot, dt):
 * proximity edges via the hysteresis predicate, marker crossings via
 * collectTimelineEvents over the reported playback windows (forward-only by
 * construction), clicks by id — each gated through its trigger's arm-policy
 * reducer. Conflict rule: at most one playScene command per step (highest
 * binding priority wins, first authored breaks ties); other verbs all pass.
 */
export function stepTriggers(
  state: TriggerRuntimeState,
  defs: TriggerRuntimeInput,
  snapshot: TriggerWorldSnapshot,
  deltaSeconds: number
): TriggerCommand[] {
  if (!snapshot.present) {
    // Leave present mode ⇒ full reset: a stale "inside" or spent "once" from a
    // previous run must not leak into the next presentation.
    state.proximity.clear();
    state.arm.clear();
    return [];
  }

  const commands: TriggerCommand[] = [];
  for (const trigger of defs.triggers) {
    if (trigger.enabled === false) continue;
    const source = trigger.source;
    let conditionFired = false;
    let exited = false;

    if (source.type === "proximity") {
      const target = snapshot.holdProximity ? null : snapshot.resolvePosition(source.targetId);
      const subject = snapshot.cameraPosition;
      if (target && subject) {
        const previous = state.proximity.get(trigger.id) ?? { inside: false };
        const edge = stepProximity(previous, subject, target, source.radius, source.hysteresis);
        state.proximity.set(trigger.id, { inside: edge.inside });
        conditionFired = edge.entered;
        exited = edge.exited;
      }
    } else if (source.type === "marker") {
      for (const window of snapshot.playback ?? []) {
        if (source.sceneId !== undefined && window.sceneId !== source.sceneId) continue;
        conditionFired ||= collectTimelineEvents(window.timeline, window.from, window.to).some(
          (event) =>
            (source.eventId === undefined || event.id === source.eventId) &&
            (source.eventKind === undefined || event.kind === source.eventKind)
        );
      }
    } else {
      conditionFired = (snapshot.clicks ?? []).includes(source.objectId);
    }

    const previousArm = state.arm.get(trigger.id) ?? createArmState();
    const { state: nextArm, fire } = stepArmPolicy(previousArm, trigger.arm, { conditionFired, exited }, deltaSeconds);
    state.arm.set(trigger.id, nextArm);
    if (fire) commands.push(...resolveTriggerCommands(defs, trigger.id));
  }

  const playSceneCommands = commands.filter((command) => command.action.type === "playScene");
  if (playSceneCommands.length > 1) {
    const winner = playSceneCommands.reduce((best, command) =>
      command.priority > best.priority ? command : best
    );
    return commands.filter((command) => command.action.type !== "playScene" || command === winner);
  }
  return commands;
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
