import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, PivotControls } from "@react-three/drei";
import {
  BezierPath,
  ControlMode,
  EndOfPathInstruction,
  PathSpace,
  TargetRegistry,
  VertexPath,
  createPathCart,
  sampleCartFrame,
  type CartFrame,
  sampleEasingCurve,
  type ComposerSettings,
  type Easing,
  type EasingCurve,
  type RigCartDefinition,
  type RigPathDefinition,
  type SerializedBezierPath,
  type Vec3
} from "@huma/path-creator/core";
import {
  CameraOverrideSurface,
  CartGizmo,
  CartVcamGlyphRig,
  EditorHelpers,
  OrbitVcamGlyphRig,
  PathEditor,
  PointTargets,
  VirtualCameraGlyph,
  getSuggestedNextAnchor,
  normalizeAnchorScales,
  useEditorHelpersVisible,
  useRegisteredTargets,
  useRigDrive,
  type RigDriveIntent
} from "@huma/path-creator/r3f";
import {
  captureVirtualCameraSnapshot,
  registerObjectTarget,
  createOverrideInputAccumulator,
  ActivationTrackDirector,
  AnimationTrackDirector,
  TransformTrackDirector,
  type OverrideInputAccumulator,
  type VirtualCameraBlendCurve,
  type VirtualCameraDefinition,
  type VirtualCameraLens,
  type VirtualCameraResolveContext,
  type VirtualCameraSnapshot
} from "@huma/path-creator/three";
import {
  createSceneRuntimeState,
  createTimelinePlayer,
  createTriggerRuntimeState,
  driveRigWithScenes,
  evaluateSceneLayers,
  playScene,
  resolveTriggerCommands,
  seekTimelinePlayer,
  stepTriggers,
  type Timeline,
  type TimelinePlayer,
  type TimelineRigContext,
  type TriggerCommand
} from "@huma/path-creator/timeline";
import type { DemoInteractions } from "./scene-io";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { TimelineLanes } from "@huma/path-creator/timeline-ui";
import {
  Activatable,
  ActivatablesProvider,
  ActivatablesRegistry,
  useActivatables,
  useActivatablesRegistry
} from "./activatables";
import { GltfActivatable } from "./gltf-activatable";
import {
  EMPTY_DESIRED,
  EMPTY_EXTRA_TRACKS,
  evaluateAudio,
  resizeAudioClip,
  maxClipEnd,
  transformKeyTimes,
  insertTransformKey,
  normalizeExtraTracks,
  hasExtraTracks,
  type ActivationTrack,
  type AnimationTrack,
  type AudioTrack,
  type DesiredAudio,
  type ExtraTracks,
  type TransformKey,
  type TransformTrack
} from "./extra-tracks";
import { AudioTrackPlayer } from "./audio-player";
import { clipPeaks } from "./audio-peaks";
import { dollyMoveSpeedSeries } from "./dolly-speed";
import { DollyCameraPip, DollyPreviewChrome, updateDollyTargetOverlay } from "./camera-pip";
import { Hierarchy } from "./hierarchy";
import { Inspector } from "./inspector";
import { panelGlobalCss, BG, BORDER, MUTED, TEXT, FAINT, SANS } from "./panel-theme";
import { IconEye, IconVideo, IconTrack, IconVolume } from "./icons";
import { isSelected, selectedIdOf, type EntityKind, type Selection } from "./selection";
import {
  DEFAULT_COMPOSER_SETTINGS,
  expandNoisePreset,
  hasActiveOverrideAxis,
  makeDolly,
  ORBIT_DEFAULTS,
  DEFAULT_DOLLY_EASING,
  ORBIT_INTERACTIVE_CONTROL,
  toVcamView,
  vcamDefFromView,
  type FovAnimation,
  type DemoShotPatch,
  type DemoVirtualCamera,
  type DollyRun,
  type EditorVcam,
  type SceneTarget,
  type ShotTiming
} from "./vcam-model";
import {
  CameraHelper,
  Color,
  MOUSE,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Group
} from "three";

export type VirtualCameraActivation = {
  toId: string;
  durationSeconds: number;
  curve: VirtualCameraBlendCurve;
  key: number;
};

export type VirtualCameraResolved = {
  snapshot: VirtualCameraSnapshot;
  progress: number;
  done: boolean;
};

function getComposerLookaheadTarget(target: Vec3, settings: ComposerSettings, velocity?: Vec3): Vec3 {
  if (!velocity || settings.lookaheadTime <= 0) return target;
  return {
    x: target.x + velocity.x * settings.lookaheadTime,
    y: target.y + velocity.y * settings.lookaheadTime,
    z: target.z + velocity.z * settings.lookaheadTime
  };
}

const DOLLY_PIP_ASPECT = 16 / 9;

function getSnapshotMatrix(snapshot: VirtualCameraSnapshot): Matrix4 {
  return new Matrix4().compose(
    new Vector3(snapshot.position.x, snapshot.position.y, snapshot.position.z),
    new Quaternion(
      snapshot.quaternion.x,
      snapshot.quaternion.y,
      snapshot.quaternion.z,
      snapshot.quaternion.w
    ),
    new Vector3(1, 1, 1)
  );
}

function updateSnapshotTransform(snapshot: VirtualCameraSnapshot, matrix: Matrix4): VirtualCameraSnapshot {
  const position = new Vector3();
  const quaternion = new Quaternion();
  const scale = new Vector3();
  matrix.decompose(position, quaternion, scale);

  return {
    ...snapshot,
    position: { x: position.x, y: position.y, z: position.z },
    quaternion: {
      x: quaternion.x,
      y: quaternion.y,
      z: quaternion.z,
      w: quaternion.w
    }
  };
}

const VCAM_PIVOT_PROPS = {
  autoTransform: false,
  fixed: true,
  scale: 75,
  lineWidth: 2,
  depthTest: false
} as const;

/**
 * A slowly yawing scene object registered as an oriented tracking target — the
 * wind-turbine stand-in. Because it exposes orientation (via registerObjectTarget),
 * an orbit vcam bound `lockYaw`/`lock` to it visibly follows its rotation, while a
 * `world`-bound orbit stays compass-anchored as it spins. A pointer nub marks the
 * target's forward so the yaw is legible.
 */
function SpinningTargetProbe({
  targetRegistry,
  id,
  name,
  position,
  degPerSec
}: {
  targetRegistry: TargetRegistry;
  id: string;
  name: string;
  position: [number, number, number];
  degPerSec: number;
}) {
  const groupRef = useRef<Group>(null);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    return registerObjectTarget(targetRegistry, id, group, name);
  }, [targetRegistry, id, name]);
  useFrame((_, delta) => {
    const group = groupRef.current;
    if (group) group.rotation.y += (degPerSec * Math.PI) / 180 * delta;
  });
  return (
    <group ref={groupRef} position={position}>
      <mesh>
        <boxGeometry args={[0.5, 0.5, 0.5]} />
        <meshStandardMaterial color="#a3a3a3" />
      </mesh>
      {/* forward nub (local +Z), so the yaw is visible */}
      <mesh position={[0, 0, 0.45]}>
        <boxGeometry args={[0.12, 0.12, 0.4]} />
        <meshStandardMaterial color="#f59e0b" emissive="#f59e0b" emissiveIntensity={0.4} />
      </mesh>
    </group>
  );
}

// A few bindable demo props so an Activation track has something obvious to
// show/hide (the demo's stand-in for "GameObjects you drag onto the track").
const DEMO_PROP_DEFS: { id: string; name: string; position: [number, number, number]; color: string }[] = [
  { id: "prop/beacon", name: "Beacon", position: [2.6, 0.6, 1.8], color: "#ef4444" },
  { id: "prop/marker", name: "Marker", position: [-1.4, 1.4, 1.2], color: "#22c55e" },
  { id: "prop/pylon", name: "Pylon", position: [0.4, 1.9, -1.6], color: "#3b82f6" }
];

function DemoProps({ selectedId, onSelect, gizmoEnabled, onTransformingChange }: { selectedId?: string | null; onSelect?: (id: string) => void; gizmoEnabled?: boolean; onTransformingChange?: (transforming: boolean) => void }) {
  return (
    <>
      {DEMO_PROP_DEFS.map((prop) => (
        <Activatable
          key={prop.id}
          id={prop.id}
          name={prop.name}
          selected={selectedId === prop.id}
          onSelect={() => onSelect?.(prop.id)}
          position={prop.position}
          {...(gizmoEnabled !== undefined && { gizmoEnabled })}
          {...(onTransformingChange && { onTransformingChange })}
        >
          <mesh>
            <boxGeometry args={[0.5, 0.5, 0.5]} />
            <meshStandardMaterial color={prop.color} emissive={prop.color} emissiveIntensity={0.25} />
          </mesh>
        </Activatable>
      ))}
    </>
  );
}

// Targets are cyan across the demo (look-target ball, point targets). Point
// targets are authored, deletable entities: a world position registered under an
// id that vcam aims can track. `visibleInRender` controls whether the sphere
// shows in the PiP (the stand-in for the real renderer) — off makes it an
// invisible aim point, still manipulable in the authoring view. `cartId` mounts
// the target on a dolly (it then rides the rail); null = static at `position`.
export function DemoSceneViewport({
  bezierPath,
  vertexPath,
  pathVersion,
  debugPreview,
  debugFrustum,
  playMode,
  pathStyle,
  selectedHandleIndex,
  selectedMidpointIndex,
  anchorScales,
  useWorldSpaceGizmo,
  isTransforming,
  onSelectHandle,
  onSelectMidpoint,
  onMovePoint,
  onSetAnchorScale,
  onRotateMidpointNormal,
  onTransformingChange,
  dollyTargetMarkerRef,
  dollyTargetLineRef,
  lookaheadMarkerRef,
  lookaheadLineRef,
  virtualCameraCaptureRequest,
  virtualCameraActivation,
  virtualCameras,
  vcamDefs,
  selectedVirtualCameraId,
  onVirtualCameraCaptured,
  onVirtualCameraResolved,
  onSelectVirtualCamera,
  onActiveVcamChange,
  onUpdateVirtualCameraSnapshot,
  onUpdateCartOffset,
  onUpdateOrbitParams,
  overrideAcc,
  targetRegistry,
  dollyFramesRef,
  dollies,
  vertexPaths,
  activeTimeline,
  timelinePlayerRef,
  storyScenes,
  activeEditingSceneId,
  playSceneRequest,
  onActiveSceneChange,
  interactions,
  simulateTriggerRequest,
  onTransportTrigger,
  activationTracks,
  audioTracks,
  animationTracks,
  transformTracks,
  audioPlayer,
  selection,
  onSelectEntity
}: {
  bezierPath: BezierPath | null;
  vertexPath: VertexPath | null;
  pathVersion: number;
  debugPreview: boolean;
  debugFrustum: boolean;
  playMode: boolean;
  pathStyle: "line" | "rail";
  selectedHandleIndex: number | null;
  selectedMidpointIndex: number | null;
  anchorScales: number[];
  useWorldSpaceGizmo: boolean;
  isTransforming: boolean;
  onSelectHandle: (index: number | null) => void;
  onSelectMidpoint: (index: number | null) => void;
  onMovePoint: (index: number, point: Vec3) => void;
  onSetAnchorScale: (anchorIndex: number, scale: number) => void;
  onRotateMidpointNormal: (segmentIndex: number, deltaDegrees: number) => void;
  onTransformingChange: (isTransforming: boolean) => void;
  dollyTargetMarkerRef: { current: HTMLDivElement | null };
  dollyTargetLineRef: { current: SVGLineElement | null };
  lookaheadMarkerRef: { current: HTMLDivElement | null };
  lookaheadLineRef: { current: SVGLineElement | null };
  virtualCameraCaptureRequest: number;
  virtualCameraActivation: VirtualCameraActivation | null;
  /** UI-facing view (glyphs, composer fields); authoritative defs are vcamDefs. */
  virtualCameras: DemoVirtualCamera[];
  /** Real definitions the drive-loop resolves/blends; parallel to virtualCameras by id. */
  vcamDefs: VirtualCameraDefinition[];
  selectedVirtualCameraId: string | null;
  onVirtualCameraCaptured: (snapshot: VirtualCameraSnapshot) => void;
  onVirtualCameraResolved: (resolved: VirtualCameraResolved) => void;
  onSelectVirtualCamera: (id: string | null) => void;
  /** The vcam actually driving the PiP this frame (timeline picks it per-frame). */
  onActiveVcamChange: (id: string | null) => void;
  onUpdateVirtualCameraSnapshot: (id: string, snapshot: VirtualCameraSnapshot) => void;
  onUpdateCartOffset: (id: string, offset: Vec3) => void;
  onUpdateOrbitParams: (
    id: string,
    params: { azimuthDeg: number; elevationDeg: number; radius: number }
  ) => void;
  /** Manual-override input the capture surface accumulates; drained per frame. */
  overrideAcc: OverrideInputAccumulator;
  targetRegistry: TargetRegistry;
  /** Shared live cart frames: Scene writes them; targets/glyphs read them. */
  dollyFramesRef: { current: Map<string, CartFrame> };
  dollies: RigCartDefinition[];
  vertexPaths: Map<string, VertexPath>;
  /** Non-null while the timeline owns the PiP. */
  activeTimeline: Timeline | null;
  timelinePlayerRef: { current: TimelinePlayer };
  /** Every story scene as a playable timeline, for the playScene branch. */
  storyScenes: Map<string, Timeline>;
  /** The scene open in the editor: playing IT mirrors the branch clock onto the
   *  timeline panel's playhead so the lanes follow the invocation. */
  activeEditingSceneId: string;
  /** Queued live scene invocation (activation-request style; key dedupes). */
  playSceneRequest: { key: number; sceneId: string } | null;
  /** Reports the scene the runtime is playing (null when control returned). */
  onActiveSceneChange: (sceneId: string | null) => void;
  /** Authored triggers/actions/bindings the reactive runtime steps per frame. */
  interactions: DemoInteractions;
  /** Fire a trigger's bound actions manually (authoring preview; key dedupes). */
  simulateTriggerRequest: { key: number; triggerId: string } | null;
  /** Transport verbs a fired trigger requests (host owns the pip driver). */
  onTransportTrigger: (op: "play" | "pause" | "seek", time?: number) => void;
  activationTracks: ActivationTrack[];
  audioTracks: AudioTrack[];
  animationTracks: AnimationTrack[];
  transformTracks: TransformTrack[];
  audioPlayer: AudioTrackPlayer;
  selection: Selection;
  onSelectEntity: (kind: EntityKind, id: string) => void;
}) {
  useEditorHelpersVisible();
  const activatablesRegistry = useActivatablesRegistry();
  // Owns the per-frame activation state machine (Unity director semantics).
  const activationDirector = useMemo(() => new ActivationTrackDirector(), []);
  // Drives bound GLB models' baked clips by time (scrub-safe), like the audio player.
  const mixerDirector = useMemo(() => new AnimationTrackDirector(), []);
  // Writes keyframed pos/rot/scale to bound objects; restores base transform on leave.
  const transformDirector = useMemo(() => new TransformTrackDirector(), []);
  // The gizmo is an authoring affordance: only while the timeline isn't driving the
  // object (Shots mode) and only in Edit mode — in Play mode it would swallow the
  // pointer taps that feed click triggers.
  const objectGizmoEnabled = !activeTimeline && !playMode;
  // One live free-running cart per dolly; the timeline branch overwrites the
  // frames with evaluated ones while it owns playback.
  const liveDollies = useMemo(
    () => new Map(dollies.map((dolly) => [dolly.id, createPathCart({ endOfPathInstruction: dolly.endOfPathInstruction })])),
    [dollies]
  );
  const demoResolveContext = (elapsedSeconds: number): VirtualCameraResolveContext => ({
    getCartFrame: (id) => dollyFramesRef.current.get(id) ?? null,
    getTargetPosition: (id) => targetRegistry.resolve(id),
    getTargetOrientation: (id) => targetRegistry.resolveOrientation(id),
    elapsedSeconds
  });
  const vcamDefById = useMemo(
    () => new Map(vcamDefs.map((def) => [def.id, def])),
    [vcamDefs]
  );
  const timelineContext = useMemo<TimelineRigContext>(
    () => ({
      rig: {
        paths: vertexPaths,
        carts: new Map(dollies.map((dolly) => [dolly.id, createPathCart({ speed: dolly.speed, endOfPathInstruction: dolly.endOfPathInstruction })])),
        cartPaths: new Map(dollies.map((dolly) => [dolly.id, dolly.pathId]))
      },
      vcams: vcamDefById,
      getTargetPosition: (id) => targetRegistry.resolve(id),
      getTargetOrientation: (id) => targetRegistry.resolveOrientation(id),
      // Enables deterministic scene embeds (scene tracks) wherever this context
      // evaluates — master playback and playScene branches alike.
      getScene: (id) => storyScenes.get(id) ?? null
    }),
    [targetRegistry, vertexPaths, vcamDefById, dollies, storyScenes]
  );
  const brainCamera = useMemo(() => {
    const camera = new PerspectiveCamera(45, DOLLY_PIP_ASPECT, 0.1, 100);
    camera.name = "virtual-camera-brain";
    camera.updateProjectionMatrix();
    return camera;
  }, []);
  const selectedVirtualCamera = selectedVirtualCameraId
    ? virtualCameras.find((camera) => camera.id === selectedVirtualCameraId) ?? null
    : null;
  // The PiP shows an authored camera: timeline output, an activated shot, or
  // the selected shot. Otherwise nothing drives it ("no output").
  const pipCamera = brainCamera;
  const hasPipSource = Boolean(
    activeTimeline || virtualCameraActivation || selectedVirtualCamera
  );
  const frustumHelper = useMemo(() => new CameraHelper(pipCamera), [pipCamera]);
  // Green while a shot/timeline is live, orange for the selected shot.
  const frustumColor = activeTimeline || virtualCameraActivation ? "#22c55e" : "#f97316";
  useEffect(() => {
    const color = new Color(frustumColor);
    frustumHelper.setColors(color, color, color, color, color);
  }, [frustumHelper, frustumColor]);

  const lastCaptureRequestRef = useRef(virtualCameraCaptureRequest);
  // Dedup for the resolved-shot callback (fire while blending, then once on done).
  const resolvedVirtualCameraKeyRef = useRef<number | null>(null);
  // Last reported driven-vcam id, so onActiveVcamChange fires only on change.
  const lastActiveVcamRef = useRef<string | null>(null);
  // The extracted drive-loop: one shared brain + composer stage, driven each
  // frame via a neutral intent. Replaces the hand-rolled brain/composer refs.
  const rigDrive = useRigDrive();
  // The active-scene runtime (playScene branch + camera take/blend/release),
  // layered over the base intent. Request key dedupes re-renders; the reported
  // live scene id fires only on change.
  const sceneRuntimeRef = useRef(createSceneRuntimeState());
  const lastPlaySceneKeyRef = useRef<number | null>(null);
  const lastActiveSceneRef = useRef<string | null>(null);
  // Reactive trigger runtime: per-trigger proximity/arm state (present-mode only),
  // stepped after the drive so marker windows reflect this frame's clock advance.
  const triggerRuntimeRef = useRef(createTriggerRuntimeState());
  const lastSimulateKeyRef = useRef<number | null>(null);
  const prevClocksRef = useRef({ master: 0, branchScene: null as string | null, branchTime: 0 });
  const triggerCamPos = useMemo(() => new Vector3(), []);
  const triggerObjPos = useMemo(() => new Vector3(), []);
  // Object taps collected for the trigger snapshot, drained once per frame.
  const pendingClicksRef = useRef<string[]>([]);
  // In Play (present) mode an object tap is trigger input, not an editor
  // selection; Edit mode keeps the normal selection behavior.
  const reportEntityInteraction = (kind: EntityKind, id: string): void => {
    if (playMode && kind === "object") pendingClicksRef.current.push(id);
    else onSelectEntity(kind, id);
  };
  // DEV-only oracle: lets headless verification read the driven camera's live pose
  // (take/release blends move it) without scraping pixels. Stripped in production.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as { __demo?: Record<string, unknown> };
    (w.__demo ??= {}).brainPose = () => ({
      x: brainCamera.position.x,
      y: brainCamera.position.y,
      z: brainCamera.position.z
    });
  }, [brainCamera]);
  const projectedTarget = useMemo(() => new Vector3(), []);
  const { gl } = useThree();

  useEffect(() => {
    const onContextMenu = (e: Event) => e.preventDefault();
    gl.domElement.addEventListener("contextmenu", onContextMenu);
    return () => gl.domElement.removeEventListener("contextmenu", onContextMenu);
  }, [gl.domElement]);

  useEffect(() => {
    return () => frustumHelper.dispose();
  }, [frustumHelper]);

  useFrame(({ camera }, delta) => {
    const mainCamera = camera as PerspectiveCamera;
    const elapsed = performance.now() / 1000;

    if (virtualCameraCaptureRequest !== lastCaptureRequestRef.current) {
      lastCaptureRequestRef.current = virtualCameraCaptureRequest;
      // Capture the main viewport (orbit) camera as a new static vcam.
      onVirtualCameraCaptured(captureVirtualCameraSnapshot(mainCamera));
    }

    // Shots mode parks every dolly at its rail start (a constant frame);
    // driveTimeline overwrites these with evaluated frames while it owns the PiP.
    if (!activeTimeline) {
      for (const dolly of dollies) {
        const dollyPath = vertexPaths.get(dolly.pathId);
        const cart = liveDollies.get(dolly.id);
        if (dollyPath && cart) dollyFramesRef.current.set(dolly.id, sampleCartFrame(dollyPath, cart, 0));
      }
    }

    // Map editor state to a neutral drive intent, then drive the PiP brain:
    // timeline plays the show; an activated or selected shot previews through the
    // activation driver (blend vs cut); otherwise idle ("no output").
    const isActivationPreview = Boolean(virtualCameraActivation && !isTransforming);
    // Live pilot input is consumed once per frame, only in Play mode. Every driver
    // (timeline + activation) forwards it; the package applies it to whichever shot
    // carries an override `control` (any body), and no-ops shots that don't.
    const overrideInput = playMode ? overrideAcc.drain() : null;
    let intent: RigDriveIntent;
    if (activeTimeline) {
      intent = {
        mode: "timeline",
        timeline: activeTimeline,
        player: timelinePlayerRef.current,
        context: timelineContext,
        cartFrames: dollyFramesRef.current,
        ...(overrideInput && { overrideInput })
      };
    } else if (isActivationPreview && virtualCameraActivation) {
      const liveVcam = virtualCameras.find((item) => item.id === virtualCameraActivation.toId);
      intent = {
        mode: "activation",
        activeVcamId: virtualCameraActivation.toId,
        vcams: vcamDefById,
        context: demoResolveContext(elapsed),
        blend: {
          durationSeconds: virtualCameraActivation.durationSeconds,
          curve: virtualCameraActivation.curve
        },
        activationKey: virtualCameraActivation.key,
        ...(liveVcam && { fallbackSnapshot: liveVcam.snapshot }),
        ...(overrideInput && { overrideInput })
      };
    } else if (selectedVirtualCamera) {
      // Cut (no blend): park on the selected shot, re-resolving as it moves.
      intent = {
        mode: "activation",
        activeVcamId: selectedVirtualCamera.id,
        vcams: vcamDefById,
        context: demoResolveContext(elapsed),
        fallbackSnapshot: selectedVirtualCamera.snapshot,
        ...(overrideInput && { overrideInput })
      };
    } else {
      intent = { mode: "idle" };
    }

    // Master clock state BEFORE the drive: trigger marker windows are the real
    // forward playback advance of this frame (scrubs/seeks report nothing).
    const prevMasterTime = timelinePlayerRef.current.time;
    const masterWasPlaying = timelinePlayerRef.current.playing;
    // Queue any new invocation, then drive through the scene runtime: with no
    // active scene this is exactly the base intent; with one, the scene's clock
    // advances and the camera take/blend/release handoff runs over the brain.
    if (playSceneRequest && playSceneRequest.key !== lastPlaySceneKeyRef.current) {
      lastPlaySceneKeyRef.current = playSceneRequest.key;
      playScene(sceneRuntimeRef.current, { sceneId: playSceneRequest.sceneId });
    }
    const result = driveRigWithScenes(sceneRuntimeRef.current, rigDrive.state.current, {
      camera: brainCamera,
      scenes: storyScenes,
      context: timelineContext,
      cartFrames: dollyFramesRef.current,
      base: intent,
      ...(overrideInput && { overrideInput })
    }, delta);
    const liveSceneId = result.activeScene?.sceneId ?? null;
    if (liveSceneId !== lastActiveSceneRef.current) {
      lastActiveSceneRef.current = liveSceneId;
      onActiveSceneChange(liveSceneId);
    }
    frustumHelper.update();

    // Surface the actually-driven vcam id (timeline picks it per-frame) so the host
    // can label the PiP and enable piloting for the active orbit shot.
    if (result.activeVcamId !== lastActiveVcamRef.current) {
      lastActiveVcamRef.current = result.activeVcamId;
      onActiveVcamChange(result.activeVcamId);
    }

    // Report the activated shot's resolved pose/progress to the panels — only for
    // a real activation, not the selected-shot preview.
    if (isActivationPreview && virtualCameraActivation && result.cameraSnapshot) {
      const done = result.blendDone;
      if (!done || resolvedVirtualCameraKeyRef.current !== virtualCameraActivation.key) {
        onVirtualCameraResolved({ snapshot: result.cameraSnapshot, progress: result.blendProgress, done });
        if (done) resolvedVirtualCameraKeyRef.current = virtualCameraActivation.key;
      }
    } else {
      resolvedVirtualCameraKeyRef.current = null;
    }

    // Activation + audio tracks drive off the timeline clock (they aren't part of
    // the core Timeline). The director applies Unity Post-Playback semantics; audio
    // sounds only during forward playback (silent on scrub/pause), matching
    // stepTimelinePlayer's forward-only event semantics.
    // While a scene is invoked, its embedded tracks + LOCAL clock drive instead of
    // the editor's working tracks + master player.
    const player = timelinePlayerRef.current;
    const scenePlayback = result.activeScene;
    // Playing the scene that's OPEN in the editor: mirror the branch's local
    // clock onto the editor player so the timeline panel's playhead follows
    // (seek, not play — event/audio edge semantics stay with the branch). This
    // also parks the master at the scene's end on completion, so the release
    // blend lands where the playhead shows.
    if (scenePlayback && scenePlayback.sceneId === activeEditingSceneId) {
      seekTimelinePlayer(player, scenePlayback.time);
    }
    // Director layers: the driving timeline's tracks at its clock, plus one layer
    // per active scene embed at ITS mapped local time (later layers override per
    // object). The master's extra tracks come from the editor's working state;
    // branch/embed layers carry theirs inside their built timelines.
    const getSceneById = (id: string): Timeline | null => storyScenes.get(id) ?? null;
    const actLayers: { tracks: readonly ActivationTrack[]; time: number }[] = [];
    const audLayers: { tracks: readonly AudioTrack[]; time: number }[] = [];
    const animLayers: { tracks: readonly AnimationTrack[]; time: number }[] = [];
    const xfLayers: { tracks: readonly TransformTrack[]; time: number }[] = [];
    const pushTimelineLayer = (tracks: Timeline["tracks"], time: number): void => {
      actLayers.push({ tracks: tracks.filter((t): t is ActivationTrack => t.type === "activation"), time });
      audLayers.push({ tracks: tracks.filter((t): t is AudioTrack => t.type === "audio"), time });
      animLayers.push({ tracks: tracks.filter((t): t is AnimationTrack => t.type === "animation"), time });
      xfLayers.push({ tracks: tracks.filter((t): t is TransformTrack => t.type === "transform"), time });
    };
    if (scenePlayback) {
      pushTimelineLayer(scenePlayback.timeline.tracks, scenePlayback.time);
      for (const layer of evaluateSceneLayers(scenePlayback.timeline.tracks, getSceneById, scenePlayback.time)) {
        pushTimelineLayer(layer.timeline.tracks, layer.time);
      }
    } else if (activeTimeline) {
      actLayers.push({ tracks: activationTracks, time: player.time });
      audLayers.push({ tracks: audioTracks, time: player.time });
      animLayers.push({ tracks: animationTracks, time: player.time });
      xfLayers.push({ tracks: transformTracks, time: player.time });
      for (const layer of evaluateSceneLayers(activeTimeline.tracks, getSceneById, player.time)) {
        pushTimelineLayer(layer.timeline.tracks, layer.time);
      }
    }
    const driveTime = scenePlayback ? scenePlayback.time : player.time;
    const drivePlaying = scenePlayback ? scenePlayback.playing : player.playing;
    const driveDuration = scenePlayback ? scenePlayback.timeline.duration : activeTimeline?.duration ?? 0;
    const timelineDriving = Boolean(activeTimeline) || Boolean(scenePlayback);
    activationDirector.sync(
      activatablesRegistry,
      actLayers,
      timelineDriving,
      driveDuration,
      driveTime,
      drivePlaying
    );
    const audioLive = timelineDriving && drivePlaying;
    const desiredAudio = new Map<string, DesiredAudio>();
    if (audioLive) {
      for (const layer of audLayers) {
        for (const [id, desired] of evaluateAudio(layer.tracks, layer.time)) desiredAudio.set(id, desired);
      }
    }
    audioPlayer.reconcile(audioLive ? desiredAudio : EMPTY_DESIRED, audioLive);
    // GLB clips are driven by time (scrub-safe), so they follow scrubbing too — not
    // gated on player.playing like audio, which must stay silent outside forward play.
    mixerDirector.sync(activatablesRegistry, animLayers, timelineDriving);
    // Keyframed transforms are pure in t too; they follow scrubbing and restore the
    // object's base pose when the timeline is left.
    transformDirector.sync(activatablesRegistry, xfLayers, timelineDriving);

    // --- Reactive triggers: snapshot the live world, step, dispatch commands.
    const triggerInput = {
      triggers: interactions.triggers,
      actions: interactions.actions,
      bindings: interactions.bindings
    };
    const dispatchTriggerCommands = (commands: TriggerCommand[]): void => {
      for (const command of commands) {
        const action = command.action;
        if (action.type === "playScene") {
          playScene(sceneRuntimeRef.current, {
            sceneId: action.sceneId,
            ...(action.skippable !== undefined && { skippable: action.skippable }),
            ...(action.blend && { blend: action.blend })
          });
        } else if (action.type === "transport") {
          onTransportTrigger(action.op, action.time);
        } else {
          const bound = activatablesRegistry.resolve(action.objectId);
          if (bound) bound.visible = action.active;
        }
      }
    };
    // Simulate affordance: fire a trigger's bound actions directly, in any mode.
    if (simulateTriggerRequest && simulateTriggerRequest.key !== lastSimulateKeyRef.current) {
      lastSimulateKeyRef.current = simulateTriggerRequest.key;
      dispatchTriggerCommands(resolveTriggerCommands(triggerInput, simulateTriggerRequest.triggerId));
    }
    // Marker windows: only clocks that really PLAYED forward this frame.
    const playbackWindows: { sceneId?: string; timeline: Timeline; from: number; to: number }[] = [];
    const prevClocks = prevClocksRef.current;
    if (scenePlayback) {
      if (prevClocks.branchScene === scenePlayback.sceneId && scenePlayback.time > prevClocks.branchTime) {
        playbackWindows.push({
          sceneId: scenePlayback.sceneId,
          timeline: scenePlayback.timeline,
          from: prevClocks.branchTime,
          to: scenePlayback.time
        });
      }
    } else if (activeTimeline && masterWasPlaying && player.time > prevMasterTime) {
      playbackWindows.push({ timeline: activeTimeline, from: prevMasterTime, to: player.time });
    }
    prevClocksRef.current = {
      master: player.time,
      branchScene: scenePlayback?.sceneId ?? null,
      branchTime: scenePlayback?.time ?? 0
    };
    camera.getWorldPosition(triggerCamPos);
    const triggerCommands = stepTriggers(
      triggerRuntimeRef.current,
      triggerInput,
      {
        // Present mode = Play view; edit-mode scrubbing can never fire anything.
        present: playMode,
        cameraPosition: { x: triggerCamPos.x, y: triggerCamPos.y, z: triggerCamPos.z },
        resolvePosition: (id) => {
          const declared = targetRegistry.resolve(id);
          if (declared) return declared;
          const bound = activatablesRegistry.resolve(id);
          if (!bound) return null;
          bound.getWorldPosition(triggerObjPos);
          return { x: triggerObjPos.x, y: triggerObjPos.y, z: triggerObjPos.z };
        },
        playback: playbackWindows,
        clicks: pendingClicksRef.current
      },
      delta
    );
    if (pendingClicksRef.current.length > 0) pendingClicksRef.current = [];
    if (triggerCommands.length > 0) dispatchTriggerCommands(triggerCommands);

    // Composer overlay: project the driven vcam's tracked target (and its
    // lookahead) onto the PiP camera so the zone markers track it live.
    const composerVcam = result.activeVcamId
      ? virtualCameras.find((item) => item.id === result.activeVcamId) ?? null
      : null;
    const composerTarget = result.composerTarget;
    if (composerVcam && composerTarget) {
      projectedTarget.set(composerTarget.x, composerTarget.y, composerTarget.z).project(pipCamera);
      const inFrame =
        projectedTarget.z >= -1 && projectedTarget.z <= 1 &&
        projectedTarget.x >= -1 && projectedTarget.x <= 1 &&
        projectedTarget.y >= -1 && projectedTarget.y <= 1;
      updateDollyTargetOverlay(
        dollyTargetMarkerRef.current,
        dollyTargetLineRef.current,
        (projectedTarget.x + 1) * 0.5,
        (1 - projectedTarget.y) * 0.5,
        inFrame
      );
      const lookahead = getComposerLookaheadTarget(
        composerTarget,
        composerVcam.composerSettings,
        rigDrive.state.current.composer.aim.smoothedVelocity
      );
      projectedTarget.set(lookahead.x, lookahead.y, lookahead.z).project(pipCamera);
      updateDollyTargetOverlay(
        lookaheadMarkerRef.current,
        lookaheadLineRef.current,
        (projectedTarget.x + 1) * 0.5,
        (1 - projectedTarget.y) * 0.5,
        composerVcam.composerSettings.lookaheadTime > 0 &&
          projectedTarget.z >= -1 && projectedTarget.z <= 1 &&
          projectedTarget.x >= -1 && projectedTarget.x <= 1 &&
          projectedTarget.y >= -1 && projectedTarget.y <= 1,
        "lookahead"
      );
    } else {
      updateDollyTargetOverlay(dollyTargetMarkerRef.current, dollyTargetLineRef.current, 0.5, 0.5, false);
      updateDollyTargetOverlay(lookaheadMarkerRef.current, lookaheadLineRef.current, 0.5, 0.5, false, "lookahead");
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 4]} intensity={1.2} />

      {bezierPath && vertexPath ? (
        <PathEditor
          bezierPath={bezierPath}
          vertexPath={vertexPath}
          pathVersion={pathVersion}
          pathStyle={pathStyle}
          otherPaths={[...vertexPaths.entries()]
            .filter(([, path]) => path !== vertexPath)
            .map(([id, path]) => ({ id, vertexPath: path }))}
          selectedHandleIndex={selectedHandleIndex}
          selectedMidpointIndex={selectedMidpointIndex}
          anchorScales={anchorScales}
          useWorldSpaceGizmo={useWorldSpaceGizmo}
          onSelectHandle={onSelectHandle}
          onSelectMidpoint={onSelectMidpoint}
          onMovePoint={onMovePoint}
          onSetAnchorScale={onSetAnchorScale}
          onRotateMidpointNormal={onRotateMidpointNormal}
          onTransformingChange={onTransformingChange}
          onClearSelection={() => {
            onSelectHandle(null);
            onSelectMidpoint(null);
            onSelectVirtualCamera(null);
          }}
        />
      ) : null}

      <Activatable
        id="turbine/Nacelle"
        name="Turbine (spinning)"
        selected={isSelected(selection, "object", "turbine/Nacelle")}
        onSelect={() => reportEntityInteraction("object", "turbine/Nacelle")}
        position={[-3.2, 1, -2.2]}
        gizmoEnabled={objectGizmoEnabled}
        onTransformingChange={onTransformingChange}
      >
        <SpinningTargetProbe
          targetRegistry={targetRegistry}
          id="turbine/Nacelle"
          name="Turbine (spinning)"
          position={[0, 0, 0]}
          degPerSec={18}
        />
      </Activatable>
      <DemoProps
        selectedId={selectedIdOf(selection, "object")}
        onSelect={(propId) => reportEntityInteraction("object", propId)}
        gizmoEnabled={objectGizmoEnabled}
        onTransformingChange={onTransformingChange}
      />
      {/* Animated GLB (CC0 Khronos Fox): baked clips Survey/Walk/Run driven by an
          Animation track. Suspense-gated so the loading model doesn't block the scene. */}
      <Suspense fallback={null}>
        <GltfActivatable
          id="fox"
          src="/Fox.glb"
          name="Fox (animated)"
          selected={isSelected(selection, "object", "fox")}
          onSelect={() => reportEntityInteraction("object", "fox")}
          position={[3, 0, -2]}
          scale={0.025}
          gizmoEnabled={objectGizmoEnabled}
          onTransformingChange={onTransformingChange}
        />
      </Suspense>

      <EditorHelpers>
      {dollies.map((dolly) => (
        <CartGizmo
          key={dolly.id}
          framesRef={dollyFramesRef}
          cartId={dolly.id}
          name={dolly.name ?? dolly.id}
          selected={isSelected(selection, "dolly", dolly.id)}
          onSelect={() => onSelectEntity("dolly", dolly.id)}
        />
      ))}
      {virtualCameras.map((virtualCamera) => {
        const isSelected = virtualCamera.id === selectedVirtualCameraId;
        const isActive = virtualCamera.id === virtualCameraActivation?.toId;
        const snapshot = virtualCamera.snapshot;

        if (virtualCamera.bodyType === "cart") {
          return (
            <CartVcamGlyphRig
              key={virtualCamera.id}
              framesRef={dollyFramesRef}
              cartId={virtualCamera.cartId}
              selected={isSelected}
              offset={virtualCamera.cartOffset}
              onOffsetChange={(cartOffset) => onUpdateCartOffset(virtualCamera.id, cartOffset)}
              onTransformingChange={onTransformingChange}
            >
              <VirtualCameraGlyph
                name={virtualCamera.name}
                selected={isSelected}
                active={isActive}
                onSelect={() => onSelectVirtualCamera(virtualCamera.id)}
              />
            </CartVcamGlyphRig>
          );
        }

        if (virtualCamera.bodyType === "orbit") {
          const orbitTargetId = virtualCamera.orbitTargetId;
          return (
            <OrbitVcamGlyphRig
              key={virtualCamera.id}
              resolveTarget={() => (orbitTargetId ? targetRegistry.resolve(orbitTargetId) : { x: 0, y: 0, z: 0 })}
              resolveOrientation={() =>
                orbitTargetId ? targetRegistry.resolveOrientation(orbitTargetId) : null
              }
              binding={virtualCamera.orbitBinding}
              azimuthDeg={virtualCamera.orbitAzimuthDeg}
              elevationDeg={virtualCamera.orbitElevationDeg}
              radius={virtualCamera.orbitRadius}
              selected={isSelected}
              onChange={(params) => onUpdateOrbitParams(virtualCamera.id, params)}
              onTransformingChange={onTransformingChange}
            >
              <VirtualCameraGlyph
                name={virtualCamera.name}
                selected={isSelected}
                active={isActive}
                onSelect={() => onSelectVirtualCamera(virtualCamera.id)}
              />
            </OrbitVcamGlyphRig>
          );
        }

        if (isSelected) {
          return (
            <PivotControls
              key={virtualCamera.id}
              {...VCAM_PIVOT_PROPS}
              matrix={getSnapshotMatrix(snapshot)}
              disableScaling
              onDragStart={() => onTransformingChange(true)}
              onDragEnd={() => onTransformingChange(false)}
              onDrag={(matrix) => {
                onUpdateVirtualCameraSnapshot(
                  virtualCamera.id,
                  updateSnapshotTransform(snapshot, matrix)
                );
              }}
            >
              <VirtualCameraGlyph
                name={virtualCamera.name}
                selected
                active={isActive}
                onSelect={() => onSelectVirtualCamera(virtualCamera.id)}
              />
            </PivotControls>
          );
        }

        return (
          <group
            key={virtualCamera.id}
            position={[
              snapshot.position.x,
              snapshot.position.y,
              snapshot.position.z
            ]}
            quaternion={[
              snapshot.quaternion.x,
              snapshot.quaternion.y,
              snapshot.quaternion.z,
              snapshot.quaternion.w
            ]}
          >
            <VirtualCameraGlyph
              name={virtualCamera.name}
              selected={false}
              active={isActive}
              onSelect={() => onSelectVirtualCamera(virtualCamera.id)}
            />
          </group>
        );
      })}
      {debugFrustum && hasPipSource ? <primitive object={frustumHelper} /> : null}
      </EditorHelpers>

      {debugPreview || playMode ? (
        <DollyCameraPip
          camera={pipCamera}
          frustumHelper={frustumHelper}
          hasSource={hasPipSource}
          playMode={playMode}
          showPip={debugPreview}
        />
      ) : null}
    </>
  );
}
