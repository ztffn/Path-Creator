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
  type CameraOverrideAxisMode,
  type CartFrame,
  type ComposerSettings,
  type RegisteredTarget,
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
  type OverrideInputAccumulator,
  type VirtualCameraBlendCurve,
  type VirtualCameraDefinition,
  type VirtualCameraResolveContext,
  type VirtualCameraSnapshot
} from "@huma/path-creator/three";
import {
  createTimelinePlayer,
  seekTimelinePlayer,
  type Timeline,
  type TimelinePlayer,
  type TimelineRigContext
} from "@huma/path-creator/timeline";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { TimelineLanes } from "@huma/path-creator/timeline-ui";
import {
  buildShowTimeline,
  deserializeScene,
  serializeScene,
  type DemoScene
} from "./scene-io";
import {
  Activatable,
  ActivatablesProvider,
  ActivatablesRegistry,
  ActivationDirector,
  useActivatables,
  useActivatablesRegistry
} from "./activatables";
import {
  EMPTY_DESIRED,
  EMPTY_EXTRA_TRACKS,
  evaluateAudio,
  maxClipEnd,
  type ActivationTrack,
  type AudioTrack,
  type ExtraTracks
} from "./extra-tracks";
import { AudioTrackPlayer } from "./audio-player";
import { ensurePeaks } from "./audio-peaks";
import { dollyMoveSpeedSeries } from "./dolly-speed";
import { ActivationTracksEditor, AudioTracksEditor } from "./extra-tracks-panel";
import { Section as SettingsSection, CollapsibleGroup, panelGlobalCss, BG, BORDER, MUTED, TEXT, FAINT, SANS } from "./panel-theme";
import { IconEye, IconEyeOff, IconVideo, IconDirector, IconTrack, IconVolume } from "./icons";
import { isSelected, selectedIdOf, type EntityKind, type Selection } from "./selection";
import {
  DEFAULT_COMPOSER_SETTINGS,
  expandNoisePreset,
  hasActiveOverrideAxis,
  makeDolly,
  ORBIT_DEFAULTS,
  ORBIT_INTERACTIVE_CONTROL,
  toVcamView,
  vcamDefFromView,
  type DemoNoisePreset,
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

const STORAGE_KEY = "path-creator:minimal-demo:path";
const SHOW_STORAGE_KEY = "path-creator:minimal-demo:show";
// The scene is persisted as a portable RigDocument; the two keys above are only
// read for one-time migration of shows saved before this format.
const SCENE_STORAGE_KEY = "path-creator:minimal-demo:scene";
// Activation/audio tracks persist in a demo sidecar (not the portable RigDocument,
// whose Timeline union is closed to camera/cart/event).
const EXTRA_STORAGE_KEY = "path-creator:minimal-demo:tracks";
// Bundled sample voices under public/audio (pretend-uploaded assets); new audio
// clips cycle through these so the waveform preview has real content to draw.
const SAMPLE_AUDIO = ["/audio/jarvis.mp3", "/audio/morganfreeman.mp3", "/audio/samjackson.mp3", "/audio/samaltman.mp3"];
// Dolly moves are authored with easeInOut (see scene-io.ts), so every move shares the
// same accel-decel speed profile; compute the normalized curve once.
const DOLLY_SPEED_SERIES = dollyMoveSpeedSeries("easeInOut");

function loadExtraTracks(): ExtraTracks {
  try {
    const raw = localStorage.getItem(EXTRA_STORAGE_KEY);
    if (!raw) return EMPTY_EXTRA_TRACKS;
    const parsed = JSON.parse(raw) as Partial<ExtraTracks>;
    return {
      activationTracks: parsed.activationTracks ?? [],
      audioTracks: parsed.audioTracks ?? []
    };
  } catch {
    return EMPTY_EXTRA_TRACKS;
  }
}
// Correlation keys tying cart-bodied vcams to the demo rail; a rename must
// touch nothing else.
// A production can run several dollies, all riding the demo's one rail;
// cameras mount a dolly via their cart body's cartId.
const FALLBACK_PATH_ID = "path-1";
const FALLBACK_DOLLY: RigCartDefinition = makeDolly({ id: "dolly-1", name: "Dolly 1", pathId: FALLBACK_PATH_ID });
const INITIAL_DOLLIES: RigCartDefinition[] = [FALLBACK_DOLLY];
const DOLLY_PIP_ASPECT = 16 / 9;
const DOLLY_PIP_MARGIN = 16;

type DemoShotPatch = Partial<
  Pick<
    DemoVirtualCamera,
    | "trackTargetId"
    | "noisePreset"
    | "dutchDeg"
    | "shotStart"
    | "shotEnd"
    | "cartOffset"
    | "cartId"
    | "orbitTargetId"
    | "orbitAzimuthDeg"
    | "orbitElevationDeg"
    | "orbitRadius"
    | "orbitBinding"
    | "orbitAutoDegPerSec"
    | "overrideControl"
  >
>;

// Fallbacks for a vcam whose sidecar entry is missing (shouldn't happen, but
// keeps the derived view total). Stable identities, so hoisted out of render.
const DEFAULT_EDITOR_VCAM: EditorVcam = { noisePreset: "off", composerSettings: DEFAULT_COMPOSER_SETTINGS };
const DEFAULT_SHOT_TIMING: ShotTiming = { start: 0, end: 5 };

type VirtualCameraActivation = {
  key: number;
  toId: string;
  durationSeconds: number;
  curve: VirtualCameraBlendCurve;
};

type VirtualCameraResolved = {
  snapshot: VirtualCameraSnapshot;
  progress: number;
  done: boolean;
};

function getComposerZones(settings: ComposerSettings) {
  return {
    deadZone: { width: settings.deadWidth, height: settings.deadHeight },
    softZone: { width: settings.softWidth, height: settings.softHeight }
  };
}

function getComposerLookaheadTarget(target: Vec3, settings: ComposerSettings, velocity?: Vec3): Vec3 {
  if (!velocity || settings.lookaheadTime <= 0) return target;
  return {
    x: target.x + velocity.x * settings.lookaheadTime,
    y: target.y + velocity.y * settings.lookaheadTime,
    z: target.z + velocity.z * settings.lookaheadTime
  };
}

// A new path starts as a simple two-anchor segment (start → stop); the user
// builds from there with Add Anchor / Insert Midpoint.
function createDefaultBezier(): BezierPath {
  return new BezierPath(
    [
      { x: -1.5, y: 0, z: 0 },
      { x: 1.5, y: 0, z: 0 }
    ],
    {
      space: PathSpace.XYZ,
      controlMode: ControlMode.Automatic
    }
  );
}

function getSnapshotLabel(snapshot: VirtualCameraSnapshot): string {
  const lens = snapshot.lens?.fov ? `${snapshot.lens.fov.toFixed(0)}deg` : "lens";
  return `${snapshot.position.x.toFixed(1)}, ${snapshot.position.y.toFixed(1)}, ${snapshot.position.z.toFixed(1)} - ${lens}`;
}

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

function DemoProps({ selectedId, onSelect }: { selectedId?: string | null; onSelect?: (id: string) => void }) {
  return (
    <>
      {DEMO_PROP_DEFS.map((prop) => (
        <Activatable
          key={prop.id}
          id={prop.id}
          name={prop.name}
          selected={selectedId === prop.id}
          onSelect={() => onSelect?.(prop.id)}
        >
          <mesh position={prop.position}>
            <boxGeometry args={[0.5, 0.5, 0.5]} />
            <meshStandardMaterial color={prop.color} emissive={prop.color} emissiveIntensity={0.25} />
          </mesh>
        </Activatable>
      ))}
    </>
  );
}

function shotRowLabelStyle(columns: string): CSSProperties {
  return {
    gridColumn: "1 / -1",
    display: "grid",
    gridTemplateColumns: columns,
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    color: "#94a3b8"
  };
}

// Targets are cyan across the demo (look-target ball, point targets). Point
// targets are authored, deletable entities: a world position registered under an
// id that vcam aims can track. `visibleInRender` controls whether the sphere
// shows in the PiP (the stand-in for the real renderer) — off makes it an
// invisible aim point, still manipulable in the authoring view. `cartId` mounts
// the target on a dolly (it then rides the rail); null = static at `position`.
const INITIAL_POINT_TARGETS: SceneTarget[] = [
  { id: "target-1", name: "Target 1", type: "point", position: { x: 3.3, y: 0.8, z: 0 }, visibleInRender: true },
  { id: "target-2", name: "Target 2", type: "point", position: { x: 1.95, y: 1.15, z: 0.78 }, visibleInRender: true },
  // Seeded cart-mounted, to demonstrate a moving aim point authored as data.
  { id: "target-3", name: "Target 3", type: "cart", cartId: FALLBACK_DOLLY.id, visibleInRender: true }
];

// A stored target from any era: the current tagged union, or the legacy flat
// shape (no `type`, a nullable cartId, an always-present position).
type StoredTarget = {
  id: string;
  name?: string;
  type?: "point" | "cart";
  position?: Vec3;
  cartId?: string | null;
  visibleInRender?: boolean;
};

/** Migrates a stored target to the package's point/cart union. */
function toSceneTarget(raw: StoredTarget): SceneTarget {
  const visibleInRender = raw.visibleInRender ?? true;
  const named = raw.name !== undefined ? { name: raw.name } : {};
  const mounted = raw.type === "cart" || (raw.type === undefined && raw.cartId);
  return mounted
    ? { id: raw.id, ...named, type: "cart", cartId: raw.cartId ?? "", visibleInRender }
    : { id: raw.id, ...named, type: "point", position: raw.position ?? { x: 0, y: 0, z: 0 }, visibleInRender };
}

// Next "Target N" that doesn't collide with an existing trailing number, so
// names stay stable after deletes.
function nextTargetName(current: SceneTarget[]): string {
  const highest = current.reduce((max, t) => {
    const match = /(\d+)$/.exec(t.name ?? "");
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `Target ${highest + 1}`;
}

function Scene({
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
  activationTracks,
  audioTracks,
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
  activationTracks: ActivationTrack[];
  audioTracks: AudioTrack[];
  audioPlayer: AudioTrackPlayer;
  selection: Selection;
  onSelectEntity: (kind: EntityKind, id: string) => void;
}) {
  useEditorHelpersVisible();
  const activatablesRegistry = useActivatablesRegistry();
  // Owns the per-frame activation state machine (Unity director semantics).
  const activationDirector = useMemo(() => new ActivationDirector(), []);
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
      getTargetOrientation: (id) => targetRegistry.resolveOrientation(id)
    }),
    [targetRegistry, vertexPaths, vcamDefById, dollies]
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

    const result = rigDrive.drive(brainCamera, intent, delta);
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
    const player = timelinePlayerRef.current;
    const timelineDriving = Boolean(activeTimeline);
    activationDirector.sync(
      activatablesRegistry,
      activationTracks,
      timelineDriving,
      activeTimeline?.duration ?? 0,
      player.time,
      player.playing
    );
    const audioLive = timelineDriving && player.playing;
    audioPlayer.reconcile(audioLive ? evaluateAudio(audioTracks, player.time) : EMPTY_DESIRED, audioLive);

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
        onSelect={() => onSelectEntity("object", "turbine/Nacelle")}
      >
        <SpinningTargetProbe
          targetRegistry={targetRegistry}
          id="turbine/Nacelle"
          name="Turbine (spinning)"
          position={[-3.2, 1, -2.2]}
          degPerSec={18}
        />
      </Activatable>
      <DemoProps
        selectedId={selectedIdOf(selection, "object")}
        onSelect={(propId) => onSelectEntity("object", propId)}
      />

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

const PIP_NO_SIGNAL_COLOR = new Color("#0a101c");
const _pipClearScratch = new Color();

function DollyCameraPip({
  camera: dollyCamera,
  frustumHelper,
  hasSource,
  playMode,
  showPip
}: {
  camera: PerspectiveCamera;
  frustumHelper: CameraHelper;
  hasSource: boolean;
  /** Play: the driven camera fills the main viewport, editor drops to the PiP. */
  playMode: boolean;
  /** Whether to draw the small inset at all ("Show camera PiP"). */
  showPip: boolean;
}) {
  const { gl, scene, size } = useThree();

  useFrame(({ camera: editorCamera }) => {
    // Play mode promotes the driven camera to the main viewport (only when one
    // actually drives it). The inset then shows the editor camera.
    const play = playMode && hasSource;
    const mainCamera = play ? dollyCamera : editorCamera;
    const pipCamera = play ? editorCamera : dollyCamera;

    // Full-viewport render. Hide the frustum helper while looking THROUGH the
    // dolly camera (you're inside its own frustum).
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    const hideFrustumMain = mainCamera === dollyCamera;
    if (hideFrustumMain) frustumHelper.visible = false;
    gl.render(scene, mainCamera);
    if (hideFrustumMain) frustumHelper.visible = true;

    if (!showPip) return; // Play mode with the inset hidden: main render only.

    // PiP scissor region (bottom-right).
    const width = Math.min(360, Math.max(220, size.width * 0.28));
    const height = width / DOLLY_PIP_ASPECT;
    const x = Math.max(DOLLY_PIP_MARGIN, size.width - width - DOLLY_PIP_MARGIN);
    const y = DOLLY_PIP_MARGIN;

    gl.clearDepth();
    gl.setScissorTest(true);
    gl.setScissor(x, y, width, height);
    gl.setViewport(x, y, width, height);
    const pipIsDolly = pipCamera === dollyCamera;
    if (pipIsDolly && !hasSource) {
      // No camera drives the PiP: paint a dark "no signal" panel instead of a
      // view from an undriven camera.
      const prevColor = gl.getClearColor(_pipClearScratch);
      const prevAlpha = gl.getClearAlpha();
      gl.setClearColor(PIP_NO_SIGNAL_COLOR, 1);
      gl.clear(true, true, false);
      gl.setClearColor(prevColor, prevAlpha);
    } else {
      if (pipIsDolly) frustumHelper.visible = false;
      gl.render(scene, pipCamera);
      if (pipIsDolly) frustumHelper.visible = true;
    }
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
  }, 1);

  return null;
}

// The PiP overlay chrome: the composer zone overview (dead/soft/hard) plus the
// tracked-target and lookahead markers, drawn over the camera view that
// DollyCameraPip renders into this region. With no source it's a slate "no
// output" panel; the zones/markers only show when a composer vcam drives the PiP.
function DollyPreviewChrome({
  label,
  hasSource,
  composerActive,
  composerSettings,
  targetMarkerRef,
  targetLineRef,
  lookaheadMarkerRef,
  lookaheadLineRef
}: {
  label: string;
  hasSource: boolean;
  composerActive: boolean;
  composerSettings: ComposerSettings;
  targetMarkerRef: { current: HTMLDivElement | null };
  targetLineRef: { current: SVGLineElement | null };
  lookaheadMarkerRef: { current: HTMLDivElement | null };
  lookaheadLineRef: { current: SVGLineElement | null };
}) {
  const zones = getComposerZones(composerSettings);
  const labelChip = (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: 8,
        padding: "3px 7px",
        borderRadius: 4,
        background: "rgba(15, 23, 42, 0.72)",
        color: hasSource ? "#f8fafc" : "#64748b",
        fontSize: 11,
        fontWeight: 700,
        fontFamily: "ui-sans-serif, system-ui, sans-serif"
      }}
    >
      {label}
    </div>
  );

  return (
    <div
      style={{
        position: "fixed",
        right: DOLLY_PIP_MARGIN,
        bottom: DOLLY_PIP_MARGIN,
        zIndex: 9,
        width: "min(360px, max(220px, 28vw))",
        aspectRatio: "16 / 9",
        pointerEvents: "none",
        border: `2px solid ${hasSource ? "rgba(248, 250, 252, 0.92)" : "rgba(148, 163, 184, 0.35)"}`,
        boxShadow: "0 18px 44px rgba(15, 23, 42, 0.28)",
        background: hasSource ? "transparent" : "rgba(10, 16, 28, 0.55)",
        boxSizing: "border-box"
      }}
    >
      {composerActive ? (
        <>
          <DollyPipZone
            width={zones.softZone.width}
            height={zones.softZone.height}
            centerX={composerSettings.screenX}
            centerY={composerSettings.screenY}
            color="rgba(6, 182, 212, 0.78)"
            fill="rgba(6, 182, 212, 0.035)"
          />
          <DollyPipZone
            width={zones.deadZone.width}
            height={zones.deadZone.height}
            centerX={composerSettings.screenX}
            centerY={composerSettings.screenY}
            color="rgba(249, 115, 22, 0.92)"
            fill="rgba(249, 115, 22, 0.04)"
          />
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible" }}
          >
            <line ref={targetLineRef} x1="50" y1="50" x2="50" y2="50" stroke="rgba(6, 182, 212, 0.72)" strokeWidth="0.55" vectorEffect="non-scaling-stroke" />
            <line ref={lookaheadLineRef} x1="50" y1="50" x2="50" y2="50" stroke="rgba(250, 204, 21, 0)" strokeWidth="0.55" strokeDasharray="3 2" vectorEffect="non-scaling-stroke" />
          </svg>
          <div
            ref={targetMarkerRef}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 14,
              height: 14,
              transform: "translate(-50%, -50%)",
              borderRadius: 999,
              background: "#06b6d4",
              border: "2px solid rgba(248, 250, 252, 0.95)",
              boxShadow: "0 0 0 4px rgba(6, 182, 212, 0.22), 0 0 18px rgba(6, 182, 212, 0.85)",
              boxSizing: "border-box"
            }}
          />
          <div
            ref={lookaheadMarkerRef}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: 10,
              height: 10,
              transform: "translate(-50%, -50%) rotate(45deg)",
              background: "rgba(250, 204, 21, 0)",
              border: "2px solid rgba(250, 204, 21, 0)",
              boxShadow: "0 0 0 3px rgba(250, 204, 21, 0)",
              boxSizing: "border-box"
            }}
          />
        </>
      ) : null}
      {labelChip}
    </div>
  );
}

function updateDollyTargetOverlay(
  marker: HTMLDivElement | null,
  line: SVGLineElement | null,
  x: number,
  y: number,
  visible: boolean,
  kind: "target" | "lookahead" = "target"
): void {
  const clampedX = Math.max(0.02, Math.min(0.98, x));
  const clampedY = Math.max(0.02, Math.min(0.98, y));
  const xPercent = clampedX * 100;
  const yPercent = clampedY * 100;

  if (marker) {
    marker.style.left = `${xPercent}%`;
    marker.style.top = `${yPercent}%`;
    if (kind === "lookahead") {
      marker.style.opacity = visible ? "1" : "0";
      marker.style.background = visible ? "rgba(250, 204, 21, 0.95)" : "rgba(250, 204, 21, 0)";
      marker.style.borderColor = visible ? "rgba(15, 23, 42, 0.8)" : "rgba(250, 204, 21, 0)";
      marker.style.boxShadow = visible
        ? "0 0 0 3px rgba(250, 204, 21, 0.24), 0 0 16px rgba(250, 204, 21, 0.75)"
        : "0 0 0 3px rgba(250, 204, 21, 0)";
    } else {
      marker.style.opacity = visible ? "1" : "0.42";
      marker.style.background = visible ? "#06b6d4" : "rgba(6, 182, 212, 0.42)";
      marker.style.boxShadow = visible
        ? "0 0 0 4px rgba(6, 182, 212, 0.22), 0 0 18px rgba(6, 182, 212, 0.85)"
        : "0 0 0 4px rgba(6, 182, 212, 0.12)";
    }
  }

  if (line) {
    line.setAttribute("x2", xPercent.toFixed(3));
    line.setAttribute("y2", yPercent.toFixed(3));
    line.setAttribute(
      "stroke",
      kind === "lookahead"
        ? visible ? "rgba(250, 204, 21, 0.72)" : "rgba(250, 204, 21, 0)"
        : visible ? "rgba(6, 182, 212, 0.72)" : "rgba(6, 182, 212, 0.3)"
    );
  }
}

function DollyPipZone({
  width,
  height,
  centerX,
  centerY,
  color,
  fill
}: {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  color: string;
  fill: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${50 + centerX * 100}%`,
        top: `${50 - centerY * 100}%`,
        width: `${width * 100}%`,
        height: `${height * 100}%`,
        transform: "translate(-50%, -50%)",
        border: `1.5px solid ${color}`,
        background: fill,
        boxSizing: "border-box"
      }}
    />
  );
}


function NumberSlider({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(72px, 96px) minmax(48px, 1fr) 52px",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        minWidth: 0
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {label}
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        style={{ width: "100%", minWidth: 0 }}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isInteger(value) ? value : Number(value.toFixed(2))}
        onChange={(event) => onChange(Number(event.target.value))}
        style={{ width: "100%", boxSizing: "border-box" }}
        aria-label={`${label}${unit ? ` ${unit}` : ""}`}
      />
    </label>
  );
}

// Per-vcam screen-composer framing editor: screen position, dead/soft/hard
// zones, damping, and lookahead. Edits VirtualCameraDefinition.settings.
function RigSettingsPanel({
  settings,
  noisePreset,
  dutchDeg,
  onChange,
  onNoisePresetChange,
  onDutchChange,
  onClose,
  onReset
}: {
  settings: ComposerSettings;
  noisePreset: DemoNoisePreset;
  dutchDeg: number;
  onChange: (next: ComposerSettings) => void;
  onNoisePresetChange: (preset: DemoNoisePreset) => void;
  onDutchChange: (deg: number) => void;
  onClose: () => void;
  onReset: () => void;
}) {
  function setValue<K extends keyof ComposerSettings>(key: K, value: ComposerSettings[K]): void {
    onChange({ ...settings, [key]: value });
  }

  return (
    <div
      style={{
        width: "100%",
        boxSizing: "border-box",
        padding: 10,
        borderRadius: 6,
        background: "rgba(10, 16, 28, 0.92)",
        border: "1px solid rgba(148, 163, 184, 0.22)"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 800 }}>Screen composer</div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onReset}>Reset</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>

      <SettingsSection title="Camera">
        <label style={{ display: "grid", gridTemplateColumns: "96px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span>Noise</span>
          <select value={noisePreset} onChange={(event) => onNoisePresetChange(event.target.value as DemoNoisePreset)}>
            <option value="off">Off</option>
            <option value="subtle">Subtle handheld</option>
            <option value="rough">Rough handheld</option>
          </select>
        </label>
        <NumberSlider label="Dutch" value={dutchDeg} min={-45} max={45} step={1} unit="°" onChange={onDutchChange} />
      </SettingsSection>

      <SettingsSection title="Screen">
        <button onClick={() => onChange({ ...settings, screenX: 0, screenY: 0 })}>Center screen</button>
        <NumberSlider label="Screen X" value={settings.screenX} min={-0.4} max={0.4} step={0.01} onChange={(v) => setValue("screenX", v)} />
        <NumberSlider label="Screen Y" value={settings.screenY} min={-0.4} max={0.4} step={0.01} onChange={(v) => setValue("screenY", v)} />
      </SettingsSection>

      <SettingsSection title="Zones">
        <NumberSlider label="Dead W" value={settings.deadWidth} min={0} max={1} step={0.01} onChange={(v) => setValue("deadWidth", v)} />
        <NumberSlider label="Dead H" value={settings.deadHeight} min={0} max={1} step={0.01} onChange={(v) => setValue("deadHeight", v)} />
        <NumberSlider label="Soft W" value={settings.softWidth} min={0} max={1} step={0.01} onChange={(v) => setValue("softWidth", v)} />
        <NumberSlider label="Soft H" value={settings.softHeight} min={0} max={1} step={0.01} onChange={(v) => setValue("softHeight", v)} />
      </SettingsSection>

      <SettingsSection title="Damping">
        <NumberSlider label="Horizontal" value={settings.dampingX} min={0} max={20} step={0.1} onChange={(v) => setValue("dampingX", v)} />
        <NumberSlider label="Vertical" value={settings.dampingY} min={0} max={20} step={0.1} onChange={(v) => setValue("dampingY", v)} />
      </SettingsSection>

      <SettingsSection title="Lookahead">
        <NumberSlider label="Time" value={settings.lookaheadTime} min={0} max={1.5} step={0.01} unit="s" onChange={(v) => setValue("lookaheadTime", v)} />
        <NumberSlider label="Smoothing" value={settings.lookaheadSmoothing} min={0} max={20} step={0.1} onChange={(v) => setValue("lookaheadSmoothing", v)} />
        <label style={{ display: "block", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={settings.lookaheadIgnoreY}
            onChange={(event) => setValue("lookaheadIgnoreY", event.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Ignore Y</span>
        </label>
        <label style={{ display: "block", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={settings.centerOnActivate}
            onChange={(event) => setValue("centerOnActivate", event.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Center on activate</span>
        </label>
      </SettingsSection>
    </div>
  );
}

function VirtualCameraPanel({
  cameras,
  activeId,
  selectedId,
  blendCurve,
  blendDuration,
  transitionProgress,
  onBlendCurveChange,
  onBlendDurationChange,
  onCapture,
  onAddCart,
  onAddOrbit,
  onSelect,
  onActivate,
  onDelete,
  onRelease,
  trackTargets,
  onUpdateShot,
  onUpdateComposer,
  dollies
}: {
  cameras: DemoVirtualCamera[];
  activeId: string | null;
  selectedId: string | null;
  blendCurve: VirtualCameraBlendCurve;
  blendDuration: number;
  transitionProgress: number;
  onBlendCurveChange: (curve: VirtualCameraBlendCurve) => void;
  onBlendDurationChange: (duration: number) => void;
  onCapture: () => void;
  onAddCart: () => void;
  onAddOrbit: () => void;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onRelease: () => void;
  trackTargets: RegisteredTarget[];
  onUpdateShot: (id: string, patch: DemoShotPatch) => void;
  onUpdateComposer: (id: string, settings: ComposerSettings) => void;
  dollies: RigCartDefinition[];
}) {
  const [composerOpenId, setComposerOpenId] = useState<string | null>(null);
  return (
    <div
      className="pc-panel"
      style={{
        width: "100%",
        boxSizing: "border-box",
        padding: 12,
        borderRadius: 0,
        background: BG,
        boxShadow: "0 24px 60px rgba(0, 0, 0, 0.45)",
        border: `1px solid ${BORDER}`
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.02em" }}>Virtual Cameras</div>
        {activeId ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "#22c55e" }}>
              Live: {cameras.find((camera) => camera.id === activeId)?.name ?? "Camera"}
            </span>
            <button onClick={onRelease}>Release</button>
          </div>
        ) : null}
      </div>

      <SettingsSection title="Cameras">
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onCapture}>Add VCam (from viewport)</button>
          <button onClick={onAddCart}>Add Cart VCam</button>
          <button onClick={onAddOrbit}>Add Orbit VCam</button>
        </div>
      </SettingsSection>

      <SettingsSection title="Blend">
        <label style={{ display: "grid", gridTemplateColumns: "96px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span>Curve</span>
          <select
            value={blendCurve}
            onChange={(event) => onBlendCurveChange(event.target.value as VirtualCameraBlendCurve)}
          >
            <option value="cut">Cut</option>
            <option value="easeInOut">Ease In Out</option>
            <option value="easeIn">Ease In</option>
            <option value="easeOut">Ease Out</option>
            <option value="hardIn">Hard In</option>
            <option value="hardOut">Hard Out</option>
            <option value="linear">Linear</option>
          </select>
        </label>
        <NumberSlider
          label="Duration"
          value={blendDuration}
          min={0}
          max={5}
          step={0.1}
          unit="s"
          onChange={onBlendDurationChange}
        />
        <div
          style={{
            height: 6,
            borderRadius: 999,
            background: "rgba(148, 163, 184, 0.2)",
            overflow: "hidden"
          }}
        >
          <div
            style={{
              width: `${Math.round(transitionProgress * 100)}%`,
              height: "100%",
              background: "#22c55e"
            }}
          />
        </div>
      </SettingsSection>

      <SettingsSection title="Shots">
        {cameras.length === 0 ? (
          <div style={{ fontSize: 12, color: "#94a3b8" }}>
            Capture a rig/viewport camera, or add a cart vcam.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {cameras.map((camera) => {
              const isActive = camera.id === activeId;
              const isSelected = camera.id === selectedId;
              return (
                <div
                  key={camera.id}
                  onClick={() => onSelect(camera.id)}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "1fr auto auto",
                    minWidth: 0,
                    gap: 6,
                    alignItems: "center",
                    padding: 8,
                    borderRadius: 6,
                    cursor: "pointer",
                    background: isActive
                      ? "rgba(34, 197, 94, 0.16)"
                      : isSelected
                        ? "rgba(249, 115, 22, 0.16)"
                        : "rgba(15, 23, 42, 0.6)",
                    border: `1px solid ${
                      isActive
                        ? "rgba(34, 197, 94, 0.54)"
                        : isSelected
                          ? "rgba(249, 115, 22, 0.58)"
                          : "rgba(148, 163, 184, 0.18)"
                    }`
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12, fontWeight: 800 }}>{camera.name}</div>
                    <div style={{ fontSize: 11, color: "#94a3b8", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {camera.bodyType === "cart"
                        ? "rides the rail cart"
                        : getSnapshotLabel(camera.snapshot)}
                    </div>
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onActivate(camera.id);
                    }}
                  >
                    {isActive ? "Reapply" : "Go"}
                  </button>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete(camera.id);
                    }}
                  >
                    Del
                  </button>
                  <label
                    onClick={(event) => event.stopPropagation()}
                    style={shotRowLabelStyle("48px 1fr")}
                  >
                    <span>Track</span>
                    <select
                      value={camera.trackTargetId ?? ""}
                      onChange={(event) =>
                        onUpdateShot(camera.id, { trackTargetId: event.target.value || null })
                      }
                    >
                      <option value="">Body aim (none)</option>
                      {trackTargets.map((target) => (
                        <option key={target.id} value={target.id}>
                          {target.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div
                    onClick={(event) => event.stopPropagation()}
                    style={{ gridColumn: "1 / -1", display: "grid", gap: 6, minWidth: 0 }}
                  >
                    <button
                      style={{ fontSize: 11, textAlign: "left" }}
                      onClick={() => setComposerOpenId(composerOpenId === camera.id ? null : camera.id)}
                    >
                      {composerOpenId === camera.id ? "▾ Composer settings" : "▸ Composer settings"}
                    </button>
                    {composerOpenId === camera.id ? (
                      <RigSettingsPanel
                        settings={camera.composerSettings}
                        noisePreset={camera.noisePreset}
                        dutchDeg={camera.dutchDeg}
                        onChange={(settings) => onUpdateComposer(camera.id, settings)}
                        onNoisePresetChange={(noisePreset) => onUpdateShot(camera.id, { noisePreset })}
                        onDutchChange={(dutchDeg) => onUpdateShot(camera.id, { dutchDeg })}
                        onClose={() => setComposerOpenId(null)}
                        onReset={() => onUpdateComposer(camera.id, DEFAULT_COMPOSER_SETTINGS)}
                      />
                    ) : null}
                  </div>
                  {camera.bodyType === "cart" ? (
                    <label
                      onClick={(event) => event.stopPropagation()}
                      title="Which dolly this camera rides; the dolly's motion is authored on its timeline lane"
                      style={shotRowLabelStyle("48px 1fr")}
                    >
                      <span>Dolly</span>
                      <select
                        value={camera.cartId}
                        onChange={(event) => onUpdateShot(camera.id, { cartId: event.target.value })}
                      >
                        {dollies.map((dolly) => (
                          <option key={dolly.id} value={dolly.id}>
                            {dolly.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  {camera.bodyType === "orbit" ? (
                    <div
                      onClick={(event) => event.stopPropagation()}
                      style={{ gridColumn: "1 / -1", display: "grid", gap: 6, minWidth: 0 }}
                    >
                      <label style={shotRowLabelStyle("64px 1fr")} title="The target this camera orbits">
                        <span>Orbit</span>
                        <select
                          value={camera.orbitTargetId}
                          onChange={(event) => onUpdateShot(camera.id, { orbitTargetId: event.target.value })}
                        >
                          <option value="">(fixed origin)</option>
                          {trackTargets.map((target) => (
                            <option key={target.id} value={target.id}>
                              {target.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label
                        style={shotRowLabelStyle("64px 1fr")}
                        title="World: compass-anchored (ignores target rotation). LockYaw: follows target heading, level horizon. Lock: welds to target (rolls with it)."
                      >
                        <span>Binding</span>
                        <select
                          value={camera.orbitBinding}
                          onChange={(event) =>
                            onUpdateShot(camera.id, {
                              orbitBinding: event.target.value as DemoVirtualCamera["orbitBinding"]
                            })
                          }
                        >
                          <option value="world">World (compass-anchored)</option>
                          <option value="lockYaw">Lock yaw (level horizon)</option>
                          <option value="lock">Lock (welded)</option>
                        </select>
                      </label>
                      <label style={shotRowLabelStyle("64px 1fr")}>
                        <span>Azimuth</span>
                        <input
                          type="range"
                          min={-180}
                          max={180}
                          step={1}
                          value={camera.orbitAzimuthDeg}
                          onChange={(event) =>
                            onUpdateShot(camera.id, { orbitAzimuthDeg: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label style={shotRowLabelStyle("64px 1fr")}>
                        <span>Elevation</span>
                        <input
                          type="range"
                          min={-80}
                          max={80}
                          step={1}
                          value={camera.orbitElevationDeg}
                          onChange={(event) =>
                            onUpdateShot(camera.id, { orbitElevationDeg: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label style={shotRowLabelStyle("64px 1fr")}>
                        <span>Radius</span>
                        <input
                          type="range"
                          min={0.5}
                          max={20}
                          step={0.1}
                          value={camera.orbitRadius}
                          onChange={(event) =>
                            onUpdateShot(camera.id, { orbitRadius: Number(event.target.value) })
                          }
                        />
                      </label>
                      <label
                        style={shotRowLabelStyle("64px 1fr")}
                        title="Auto-orbit rate in degrees/second (0 holds a static angle)"
                      >
                        <span>Spin °/s</span>
                        <input
                          type="range"
                          min={-90}
                          max={90}
                          step={1}
                          value={camera.orbitAutoDegPerSec}
                          onChange={(event) =>
                            onUpdateShot(camera.id, { orbitAutoDegPerSec: Number(event.target.value) })
                          }
                        />
                      </label>
                    </div>
                  ) : null}
                  <div
                    onClick={(event) => event.stopPropagation()}
                    style={{ gridColumn: "1 / -1", display: "grid", gap: 6, minWidth: 0 }}
                    title="How each axis responds to live piloting (drag/scroll the PiP while this shot is active)"
                  >
                    <CollapsibleGroup title="Manual control · LMB orbit / RMB pan / wheel dolly">
                    {(["azimuth", "elevation", "pan", "dolly"] as const).map((axis) => (
                      <label key={axis} style={shotRowLabelStyle("64px 1fr")}>
                        <span style={{ textTransform: "capitalize" }}>{axis}</span>
                        <select
                          value={camera.overrideControl[axis]?.mode ?? "locked"}
                          onChange={(event) =>
                            onUpdateShot(camera.id, {
                              overrideControl: {
                                ...camera.overrideControl,
                                [axis]:
                                  event.target.value === "recenter"
                                    ? { mode: "recenter", recenterWait: 1.5, recenterTime: 1 }
                                    : { mode: event.target.value as CameraOverrideAxisMode }
                              }
                            })
                          }
                        >
                          <option value="locked">Locked (coded only)</option>
                          <option value="free">Free (override, holds)</option>
                          <option value="recenter">Recenter (override, eases back)</option>
                        </select>
                      </label>
                    ))}
                    </CollapsibleGroup>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </div>
  );
}

export function App() {
  // The scene is a portable RigDocument. Load it if present; otherwise migrate a
  // pre-format show once (read here, rewritten in the new format on first save).
  const loadedScene = useMemo<DemoScene | null>(() => {
    try {
      const raw = localStorage.getItem(SCENE_STORAGE_KEY);
      return raw ? deserializeScene(raw) : null;
    } catch {
      return null;
    }
  }, []);

  const [bezierPath, setBezierPath] = useState<BezierPath | null>(() => {
    if (loadedScene) {
      const active =
        loadedScene.paths.find((path) => path.id === loadedScene.activePathId) ?? loadedScene.paths[0];
      return active ? BezierPath.fromJSON(active.bezier) : null;
    }
    try {
      const rawShow = localStorage.getItem(SHOW_STORAGE_KEY);
      if (rawShow) {
        const parsedShow = JSON.parse(rawShow) as {
          paths?: RigPathDefinition[];
          activePathId?: string;
        };
        // An explicit paths array (incl. empty) is authoritative: no editable
        // path is a valid state, so don't fall through to the legacy seed.
        if (Array.isArray(parsedShow.paths)) {
          const active =
            parsedShow.paths.find((path) => path.id === parsedShow.activePathId) ??
            parsedShow.paths[0];
          return active ? BezierPath.fromJSON(active.bezier) : null;
        }
      }
    } catch {
      // fall through to the legacy single-path key
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createDefaultBezier();

    try {
      const parsed = JSON.parse(raw) as SerializedBezierPath;
      return BezierPath.fromJSON(parsed);
    } catch {
      return createDefaultBezier();
    }
  });

  const [pathVersion, setPathVersion] = useState(0);
  const [debugPreview, setDebugPreview] = useState(true);
  const [debugFrustum, setDebugFrustum] = useState(true);
  // Edit vs Play mode. Edit: the editor camera owns the main viewport with
  // OrbitControls + helpers; the driven "viewer" camera previews in the PiP.
  // Play: the driven camera owns the main viewport (clean, no helpers) and all
  // interaction pilots it (editor OrbitControls are off); the editor drops to the
  // PiP. One switch flips the render camera, the controls, AND the input surface.
  const [viewMode, setViewMode] = useState<"edit" | "play">("edit");
  const playMode = viewMode === "play";
  // The vcam actually driving the PiP this frame — reported by the drive loop. In
  // timeline playback the active shot changes over time, so this is the truth for
  // the PiP label and for deciding whether the viewport can pilot an orbit shot.
  const [activeDrivenVcamId, setActiveDrivenVcamId] = useState<string | null>(null);

  // Quick toggle: press "P" to flip Edit <-> Play (ignored while typing in a field).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "p" && event.key !== "P") return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        return;
      }
      setViewMode((mode) => (mode === "edit" ? "play" : "edit"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const targetRegistry = useMemo(() => new TargetRegistry(), []);
  const activatablesRegistry = useMemo(() => new ActivatablesRegistry(), []);
  const audioPlayer = useMemo(() => new AudioTrackPlayer(), []);
  const activatables = useActivatables(activatablesRegistry);
  const [extraTracks, setExtraTracks] = useState<ExtraTracks>(loadExtraTracks);
  // Persist activation/audio tracks; unlock audio on the first user gesture.
  useEffect(() => {
    localStorage.setItem(EXTRA_STORAGE_KEY, JSON.stringify(extraTracks));
  }, [extraTracks]);
  useEffect(() => {
    const unlock = () => audioPlayer.resume();
    window.addEventListener("pointerdown", unlock);
    return () => window.removeEventListener("pointerdown", unlock);
  }, [audioPlayer]);
  useEffect(() => () => audioPlayer.dispose(), [audioPlayer]);
  // DEV-only oracle handle: lets the Playwright verification read a bound object's
  // visibility and drive the timeline clock without brittle UI scripting. Stripped
  // from production builds (import.meta.env.DEV is false there).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    (window as unknown as { __demo?: unknown }).__demo = {
      isVisible: (id: string) => activatablesRegistry.resolve(id)?.visible ?? null,
      player: timelinePlayerRef.current,
      setExtraTracks,
      enterTimeline: () => setPipDriver("timeline")
    };
  }, [activatablesRegistry]);
  // Live cart frames, shared by Scene (writer) and PointTargets/glyphs (readers).
  const dollyFramesRef = useRef<Map<string, CartFrame>>(new Map());
  // Manual-override input: the capture surface accumulates, the drive loop drains.
  const overrideAcc = useMemo(() => createOverrideInputAccumulator(), []);
  // Clear any gesture left in the accumulator when entering Play, so a delta from a
  // prior Play session can't jump the camera on this session's first drive frame.
  useEffect(() => {
    if (playMode) overrideAcc.drain();
  }, [playMode, overrideAcc]);
  // Composer overlay markers on the PiP, driven imperatively from Scene's frame loop.
  const dollyTargetMarkerRef = useRef<HTMLDivElement | null>(null);
  const dollyTargetLineRef = useRef<SVGLineElement | null>(null);
  const lookaheadMarkerRef = useRef<HTMLDivElement | null>(null);
  const lookaheadLineRef = useRef<SVGLineElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const registeredTargets = useRegisteredTargets(targetRegistry);
  const [pipDriver, setPipDriver] = useState<"shots" | "timeline">("shots");
  const timelinePlayerRef = useRef<TimelinePlayer>(createTimelinePlayer());
  // The show (dollies, shots, mounts, moves) survives reloads like the spline.
  const storedShow = useMemo(() => {
    try {
      const raw = localStorage.getItem(SHOW_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as
        | Partial<DemoVirtualCamera>[]
        | {
            dollies?: Partial<RigCartDefinition>[];
            vcams?: Partial<DemoVirtualCamera>[];
            paths?: RigPathDefinition[];
            activePathId?: string;
            pointTargets?: StoredTarget[];
          };
      return Array.isArray(parsed) ? { vcams: parsed } : parsed;
    } catch {
      return null;
    }
  }, []);
  const [pointTargets, setPointTargets] = useState<SceneTarget[]>(
    () => loadedScene?.targets ?? storedShow?.pointTargets?.map(toSceneTarget) ?? INITIAL_POINT_TARGETS
  );
  // Unified single-selection atom (engine-style). Old per-type ids are derived
  // from it so existing panels keep working during the phased refactor.
  const [selection, setSelection] = useState<Selection>(null);
  const selectedPointTargetId = selectedIdOf(selection, "target");

  // The one selection funnel: sets the atom, clears path sub-selection for
  // non-path kinds, and parks playback when a camera shot is selected.
  function select(kind: EntityKind, id: string | null): void {
    setSelection(id === null ? null : { kind, id });
    if (id === null) return;
    if (kind !== "path") {
      setSelectedHandleIndex(null);
      setSelectedMidpointIndex(null);
    }
    if (kind === "camera") {
      setPipDriver("shots");
      timelinePlayerRef.current.playing = false;
    }
  }

  function selectPointTarget(id: string | null): void {
    select("target", id);
  }

  function addPointTarget(): void {
    const id = `target-${Date.now()}`;
    setPointTargets((current) => [
      ...current,
      { id, name: nextTargetName(current), type: "point", position: { x: 2.4, y: 0.8, z: 0 }, visibleInRender: true }
    ]);
    selectPointTarget(id);
  }

  // Toggle static/cart: mounting drops the fixed position (the cart drives it);
  // unmounting parks the target at its current world position so it doesn't jump.
  function setPointTargetMount(id: string, cartId: string | null): void {
    setPointTargets((current) =>
      current.map((t) => {
        if (t.id !== id) return t;
        const named = t.name !== undefined ? { name: t.name } : {};
        const visibleInRender = t.visibleInRender ?? true;
        if (cartId) return { id: t.id, ...named, type: "cart", cartId, visibleInRender };
        const parked = targetRegistry.resolve(id) ?? (t.type === "point" ? t.position : { x: 0, y: 0, z: 0 });
        return { id: t.id, ...named, type: "point", position: parked, visibleInRender };
      })
    );
  }

  function deletePointTarget(id: string): void {
    setPointTargets((current) => current.filter((t) => t.id !== id));
    if (isSelected(selection, "target", id)) setSelection(null);
  }

  function movePointTarget(id: string, position: Vec3): void {
    setPointTargets((current) =>
      current.map((t) => (t.id === id && t.type === "point" ? { ...t, position } : t))
    );
  }

  function renamePointTarget(id: string, name: string): void {
    setPointTargets((current) => current.map((t) => (t.id === id ? { ...t, name } : t)));
  }

  function togglePointTargetVisible(id: string): void {
    setPointTargets((current) =>
      current.map((t) => (t.id === id ? { ...t, visibleInRender: !(t.visibleInRender ?? true) } : t))
    );
  }

  const [dollies, setDollies] = useState<RigCartDefinition[]>(() =>
    loadedScene?.dollies ??
    (storedShow?.dollies ?? INITIAL_DOLLIES).map((dolly) => {
      // Legacy saves used `endOfPath`; the package cart uses `endOfPathInstruction`.
      const legacy = dolly as Partial<RigCartDefinition> & { endOfPath?: EndOfPathInstruction };
      return makeDolly({
        id: legacy.id ?? FALLBACK_DOLLY.id,
        name: legacy.name ?? "Dolly",
        pathId: legacy.pathId ?? storedShow?.paths?.[0]?.id ?? FALLBACK_PATH_ID,
        endOfPathInstruction: legacy.endOfPathInstruction ?? legacy.endOfPath ?? EndOfPathInstruction.Loop
      });
    })
  );

  function updateDolly(id: string, patch: Partial<RigCartDefinition>): void {
    setDollies((current) =>
      current.map((dolly) => (dolly.id === id ? { ...dolly, ...patch } : dolly))
    );
  }

  const [paths, setPaths] = useState<RigPathDefinition[]>(
    () =>
      loadedScene?.paths ??
      storedShow?.paths ?? [{ id: FALLBACK_PATH_ID, name: "Path 1", bezier: createDefaultBezier().toJSON() }]
  );
  const [activePathId, setActivePathId] = useState<string | null>(
    () => loadedScene?.activePathId ?? storedShow?.activePathId ?? paths[0]?.id ?? null
  );
  // Keep the active path's serialization current so switching/saving is lossless.
  useEffect(() => {
    if (!bezierPath || !activePathId) return;
    setPaths((current) =>
      current.map((path) =>
        path.id === activePathId ? { ...path, bezier: bezierPath.toJSON() } : path
      )
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bezierPath, pathVersion]);

  function switchPath(id: string): void {
    const target = paths.find((path) => path.id === id);
    if (!target || id === activePathId) return;
    setActivePathId(id);
    setSelection({ kind: "path", id });
    setBezierPath(BezierPath.fromJSON(target.bezier));
    setSelectedHandleIndex(null);
    setSelectedMidpointIndex(null);
    setPathVersion((version) => version + 1);
  }

  function renamePath(id: string, name: string): void {
    setPaths((current) => current.map((path) => (path.id === id ? { ...path, name } : path)));
  }

  function addPath(): void {
    const id = `path-${Date.now()}`;
    const bezier = createDefaultBezier();
    setPaths((current) => [
      ...current,
      { id, name: `Path ${current.length + 1}`, bezier: bezier.toJSON() }
    ]);
    // First path in an empty world becomes the editable one immediately.
    if (activePathId === null) {
      setActivePathId(id);
      setBezierPath(bezier);
      setSelectedHandleIndex(0);
      setSelectedMidpointIndex(null);
      setPathVersion((version) => version + 1);
    }
  }

  function deletePath(id: string): void {
    const remaining = paths.filter((path) => path.id !== id);
    setPaths(remaining);
    if (id === activePathId) {
      // Deleting the editable path: activate whatever remains, or clear the
      // editor entirely (empty world is valid).
      const fallback = remaining[0] ?? null;
      setActivePathId(fallback?.id ?? null);
      setBezierPath(fallback ? BezierPath.fromJSON(fallback.bezier) : null);
      setSelectedHandleIndex(fallback ? 0 : null);
      setSelectedMidpointIndex(null);
      setPathVersion((version) => version + 1);
    }
    // Repoint dollies off the deleted rail when another remains; otherwise the
    // dangling reference is tolerated (the dolly simply produces no frame).
    const repoint = remaining[0]?.id;
    if (repoint) {
      setDollies((current) =>
        current.map((dolly) => (dolly.pathId === id ? { ...dolly, pathId: repoint } : dolly))
      );
    }
  }
  const defaultDollyId = dollies[0]?.id ?? FALLBACK_DOLLY.id;
  // Migrate the stored flat "view" shape into defaulted views, then split into
  // the authoritative model (real defs + editor/timing sidecars). Fields absent
  // in older saves fall back to defaults; composer settings merge over the
  // default so saves predating a field stay valid.
  const initialShots = useMemo<DemoVirtualCamera[]>(
    () =>
      (storedShow?.vcams ?? []).map((vcam, index) => {
        const base = {
          cartId: storedShow?.dollies?.[0]?.id ?? FALLBACK_DOLLY.id,
          cartOffset: { x: 0, y: 0, z: 0 },
          trackTargetId: null,
          noisePreset: "off" as const,
          dutchDeg: 0,
          shotStart: index * 5,
          shotEnd: index * 5 + 5,
          ...vcam
        } as DemoVirtualCamera;
        return { ...base, composerSettings: { ...DEFAULT_COMPOSER_SETTINGS, ...base.composerSettings } };
      }),
    // storedShow is read once; this is the initial-load migration only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const [vcamDefs, setVcamDefs] = useState<VirtualCameraDefinition[]>(() =>
    loadedScene?.vcamDefs ??
    initialShots.map((view) =>
      vcamDefFromView(view, { noisePreset: view.noisePreset, composerSettings: view.composerSettings })
    )
  );
  const [editorVcams, setEditorVcams] = useState<Record<string, EditorVcam>>(() =>
    loadedScene?.editorVcams ??
    Object.fromEntries(
      initialShots.map((view) => [view.id, { noisePreset: view.noisePreset, composerSettings: view.composerSettings }])
    )
  );
  const [shotTiming, setShotTiming] = useState<Record<string, ShotTiming>>(() =>
    loadedScene?.shotTiming ??
    Object.fromEntries(initialShots.map((view) => [view.id, { start: view.shotStart, end: view.shotEnd }]))
  );
  // Per-dolly run-blocks. From a loaded document (F1+ saves hydrate these from
  // the cart tracks); pre-format shows start empty and re-author dolly moves.
  const [dollyRuns, setDollyRuns] = useState<Record<string, DollyRun[]>>(() => loadedScene?.dollyRuns ?? {});
  // The UI-facing view is a pure projection of the authoritative model.
  const virtualCameras = useMemo<DemoVirtualCamera[]>(
    () =>
      vcamDefs.map((def) =>
        toVcamView(def, editorVcams[def.id] ?? DEFAULT_EDITOR_VCAM, shotTiming[def.id] ?? DEFAULT_SHOT_TIMING)
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [vcamDefs, editorVcams, shotTiming]
  );
  // Persist the scene as a portable RigDocument. Each dolly carries its own
  // free-run speed (per-cart), so a loaded document plays faithfully.
  const currentScene: DemoScene = {
    paths,
    activePathId,
    dollies,
    vcamDefs,
    editorVcams,
    shotTiming,
    dollyRuns,
    targets: pointTargets
  };
  useEffect(() => {
    localStorage.setItem(SCENE_STORAGE_KEY, serializeScene(currentScene));
    // currentScene is rebuilt each render from the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dollies, vcamDefs, editorVcams, shotTiming, dollyRuns, paths, activePathId, pointTargets]);

  // Replaces the whole editing state from a loaded/parsed scene.
  function applyScene(scene: DemoScene): void {
    const active = scene.paths.find((path) => path.id === scene.activePathId) ?? scene.paths[0] ?? null;
    setPaths(scene.paths);
    setActivePathId(active?.id ?? null);
    setBezierPath(active ? BezierPath.fromJSON(active.bezier) : null);
    setDollies(scene.dollies);
    setVcamDefs(scene.vcamDefs);
    setEditorVcams(scene.editorVcams);
    setShotTiming(scene.shotTiming);
    setDollyRuns(scene.dollyRuns);
    setPointTargets(scene.targets);
    setSelection(null);
    setSelectedMidpointIndex(null);
    setSelectedHandleIndex(active ? 0 : null);
    setPathVersion((version) => version + 1);
  }

  function exportScene(): void {
    const blob = new Blob([serializeScene(currentScene)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "scene.json";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function importSceneFile(file: File): void {
    file
      .text()
      .then((text) => applyScene(deserializeScene(text)))
      .catch((error: unknown) => console.error("Scene import failed", error));
  }

  function newScene(): void {
    const path: RigPathDefinition = {
      id: `path-${Date.now()}`,
      name: "Path 1",
      bezier: createDefaultBezier().toJSON()
    };
    applyScene({
      paths: [path],
      activePathId: path.id,
      dollies: [makeDolly({ id: "dolly-1", name: "Dolly 1", pathId: path.id })],
      vcamDefs: [],
      editorVcams: {},
      shotTiming: {},
      dollyRuns: {},
      targets: []
    });
  }

  // Dolly run-block authoring (per cartId). A new run parks-continues from the
  // previous run's end so it doesn't teleport; the default duration is 3s.
  function addDollyRun(cartId: string, start: number): void {
    setDollyRuns((current) => {
      const runs = current[cartId] ?? [];
      // Positions are normalized 0..1 along the path. Continue from where the last
      // run parked, and traverse to the far end so a fresh move covers the rail.
      const from = runs.reduce((last, run) => (run.end <= start ? run.toT : last), 0);
      const run: DollyRun = {
        id: `run-${cartId}-${Date.now()}`,
        start,
        end: start + 3,
        fromT: from,
        toT: from < 0.5 ? 1 : 0
      };
      return { ...current, [cartId]: [...runs, run].sort((a, b) => a.start - b.start) };
    });
  }

  function updateDollyRun(cartId: string, runId: string, patch: Partial<DollyRun>): void {
    setDollyRuns((current) => ({
      ...current,
      [cartId]: (current[cartId] ?? [])
        .map((run) => (run.id === runId ? { ...run, ...patch } : run))
        .sort((a, b) => a.start - b.start)
    }));
  }

  function deleteDollyRun(cartId: string, runId: string): void {
    setDollyRuns((current) => {
      const runs = (current[cartId] ?? []).filter((run) => run.id !== runId);
      const next = { ...current };
      if (runs.length > 0) next[cartId] = runs;
      else delete next[cartId];
      return next;
    });
  }

  function addDolly(): void {
    const id = `dolly-${Date.now()}`;
    setDollies((current) => [...current, makeDolly({ id, name: `Dolly ${current.length + 1}`, pathId: activePathId ?? paths[0]?.id ?? "" })]);
  }

  function deleteDolly(id: string): void {
    setDollies((current) => {
      const next = current.filter((dolly) => dolly.id !== id);
      // Remount cameras off the deleted dolly onto whatever remains; with no
      // dolly left the reference dangles (a cart vcam then produces no frame).
      const remount = next[0]?.id;
      if (remount) {
        setVcamDefs((defs) =>
          defs.map((def) =>
            def.body.type === "cart" && def.body.cartId === id
              ? { ...def, body: { ...def.body, cartId: remount } }
              : def
          )
        );
      }
      return next;
    });
  }
  const selectedVirtualCameraId = selectedIdOf(selection, "camera");
  const [virtualCameraCaptureRequest, setVirtualCameraCaptureRequest] = useState(0);
  const [virtualCameraActivation, setVirtualCameraActivation] =
    useState<VirtualCameraActivation | null>(null);
  const [virtualCameraBlendCurve, setVirtualCameraBlendCurve] =
    useState<VirtualCameraBlendCurve>("easeInOut");
  const [virtualCameraBlendDuration, setVirtualCameraBlendDuration] = useState(1.2);
  const [virtualCameraTransitionProgress, setVirtualCameraTransitionProgress] = useState(1);
  const [useWorldSpaceGizmo, setUseWorldSpaceGizmo] = useState(false);
  // Bumped when a lazily-decoded waveform finishes, so audio clips repaint with peaks.
  const [, setPeaksTick] = useState(0);
  const [pathStyle, setPathStyle] = useState<"line" | "rail">("rail");
  const [isTransforming, setIsTransforming] = useState(false);
  const [selectedHandleIndex, setSelectedHandleIndex] = useState<number | null>(0);
  const [selectedMidpointIndex, setSelectedMidpointIndex] = useState<number | null>(null);
  const [anchorScales, setAnchorScales] = useState<number[]>(
    () => (bezierPath ? new Array(bezierPath.numAnchorPoints).fill(1) : [])
  );

  const vertexPath = useMemo(
    () => (bezierPath ? new VertexPath(bezierPath, { spacing: 0.03 }) : null),
    [bezierPath, pathVersion]
  );
  const vertexPaths = useMemo(
    () =>
      new Map(
        paths.map((path) => [
          path.id,
          path.id === activePathId && vertexPath
            ? vertexPath
            : new VertexPath(BezierPath.fromJSON(path.bezier), { spacing: 0.05 })
        ])
      ),
    [paths, activePathId, vertexPath]
  );
  const selectedAnchorScaleForUi =
    selectedHandleIndex !== null && selectedHandleIndex % 3 === 0
      ? anchorScales[Math.floor(selectedHandleIndex / 3)] ?? 1
      : null;
  const selectedVirtualCamera = selectedVirtualCameraId
    ? virtualCameras.find((camera) => camera.id === selectedVirtualCameraId) ?? null
    : null;
  // Key the show only on timing/run fields so gizmo drags (offset/pose edits at
  // pointer rate) don't rebuild the timeline object every frame — the lane
  // editor treats a new editorData as a full re-init.
  const shotTimingKey = virtualCameras
    .map((vcam) => `${vcam.id}:${vcam.shotStart}:${vcam.shotEnd}:${vcam.cartId}`)
    .join("|");
  const dollyRunKey = Object.entries(dollyRuns)
    .map(([cartId, runs]) => `${cartId}:${runs.map((r) => `${r.start},${r.end},${r.fromT},${r.toT}`).join(";")}`)
    .join("|");
  // The show timeline is authored data (blocks + cart-track keys), built by the
  // shared scene-io helper — the same build used to assemble the saved document.
  // Keyed on timing/runs so gizmo drags (which change vcamDefs) don't rebuild it.
  // Latest clip end across activation/audio tracks: the show must run long enough
  // to cover object-only content (the core Timeline drives the player clock).
  const extraDuration = useMemo(() => maxClipEnd(extraTracks), [extraTracks]);
  // Built whenever there's ANY content — cameras, dolly moves, OR activation/audio
  // clips — so an object-only (or audio-only) show still plays; not vcam-coupled.
  const hasTimelineContent =
    vcamDefs.length > 0 || Object.values(dollyRuns).some((runs) => runs.length > 0) || extraDuration > 0;
  const demoTimeline = useMemo(() => {
    if (!hasTimelineContent) return null;
    const base = buildShowTimeline(vcamDefs, shotTiming, dollyRuns, (cartId) => {
      const dolly = dollies.find((d) => d.id === cartId);
      return (dolly && vertexPaths.get(dolly.pathId)?.length) || 1;
    });
    // Extend the clock to cover activation/audio clips that outlast the camera/cart
    // content. (The exported RigDocument timeline is intentionally NOT extended —
    // extra tracks persist in a separate sidecar, not the portable document.)
    return { ...base, duration: Math.max(base.duration, extraDuration) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotTimingKey, dollyRunKey, extraDuration]);
  const timelineActive = pipDriver === "timeline" && demoTimeline != null;
  // The rig preview only has a source while an editable path drives it; with
  // no timeline/shot/selection and no path, the PiP shows "no output".
  const hasPipSource = Boolean(timelineActive || virtualCameraActivation || selectedVirtualCamera);
  // The vcam actually driving the PiP this frame (reported by the drive loop);
  // during timeline playback this is the active block's shot, which changes over
  // time — so the label names the real camera instead of an opaque "Timeline".
  const activeDrivenVcam = activeDrivenVcamId
    ? virtualCameras.find((camera) => camera.id === activeDrivenVcamId) ?? null
    : null;
  const pipLabel = timelineActive
    ? activeDrivenVcam
      ? `▶ ${activeDrivenVcam.name}`
      : "Timeline (gap)"
    : virtualCameraActivation
      ? activeDrivenVcam?.name ?? "Brain Camera"
      : selectedVirtualCamera
        ? selectedVirtualCamera.name
        : "No output";
  // Composer zone overlay reflects the previewed vcam (selected or activated).
  const activatedVcam = virtualCameraActivation
    ? virtualCameras.find((camera) => camera.id === virtualCameraActivation.toId) ?? null
    : null;
  const composerChromeVcam = selectedVirtualCamera ?? activatedVcam;
  const composerChromeActive = Boolean(composerChromeVcam?.trackTargetId);
  const composerChromeSettings = composerChromeVcam?.composerSettings ?? DEFAULT_COMPOSER_SETTINGS;
  // Play mode drops a viewport input surface over the whole 3D view whenever a
  // camera drives it (edit-mode authoring uses gizmos/sliders, not viewport drag).
  const showPlayInput = playMode && hasPipSource;

  function getActiveAnchorPointIndex(path: BezierPath): number | null {
    if (selectedHandleIndex === null) return null;
    if (selectedHandleIndex < 0 || selectedHandleIndex >= path.numPoints) return null;
    const mod = selectedHandleIndex % 3;
    if (mod === 0) return selectedHandleIndex;
    if (mod === 1) return selectedHandleIndex - 1;
    return selectedHandleIndex + 1;
  }

  function mutatePath(mutator: (path: BezierPath) => void): void {
    if (!bezierPath) return;
    mutator(bezierPath);
    setAnchorScales((prev) => normalizeAnchorScales(bezierPath.numAnchorPoints, prev));
    setPathVersion((v) => v + 1);
  }

  function rotateMidpointNormal(segmentIndex: number, deltaDegrees: number): void {
    mutatePath((path) => {
      const a = segmentIndex;
      const b = path.isClosed ? (segmentIndex + 1) % path.numAnchorPoints : segmentIndex + 1;
      if (a < 0 || b < 0 || a >= path.numAnchorPoints || b >= path.numAnchorPoints) return;
      path.setAnchorNormalAngle(a, path.getAnchorNormalAngle(a) + deltaDegrees * 0.5);
      path.setAnchorNormalAngle(b, path.getAnchorNormalAngle(b) + deltaDegrees * 0.5);
    });
  }

  function addAnchor(): void {
    mutatePath((path) => {
      if (path.isClosed) {
        path.setClosed(false);
      }
      const suggestedAnchor = getSuggestedNextAnchor(path);
      path.addSegmentToEnd(suggestedAnchor);
      setSelectedHandleIndex(path.numPoints - 1);
      setSelectedMidpointIndex(null);
    });
  }

  function insertAnchorAtSelectedSegment(): void {
    mutatePath((path) => {
      const activeAnchorPointIndex = getActiveAnchorPointIndex(path);
      if (activeAnchorPointIndex === null) return;

      let segmentIndex = Math.floor(activeAnchorPointIndex / 3);
      if (!path.isClosed && segmentIndex >= path.numSegments) {
        segmentIndex = Math.max(0, path.numSegments - 1);
      } else if (path.isClosed) {
        segmentIndex %= path.numSegments;
      }

      const newAnchorIndex = path.splitSegment(segmentIndex, 0.5);
      setSelectedHandleIndex(newAnchorIndex);
      setSelectedMidpointIndex(null);
    });
  }

  function deleteSelectedAnchor(): void {
    mutatePath((path) => {
      const activeAnchorPointIndex = getActiveAnchorPointIndex(path);
      if (activeAnchorPointIndex === null) return;
      const deleted = path.deleteAnchor(activeAnchorPointIndex);
      if (!deleted) return;
      const fallback = Math.max(0, Math.min(activeAnchorPointIndex, path.numPoints - 1));
      setSelectedHandleIndex(fallback);
      setSelectedMidpointIndex(null);
    });
  }

  function savePath(): void {
    if (!bezierPath) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bezierPath.toJSON()));
  }

  function loadPath(): void {
    if (!activePathId) return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
      const parsed = JSON.parse(raw) as SerializedBezierPath;
      const loaded = BezierPath.fromJSON(parsed);
      setBezierPath(loaded);
      setAnchorScales(new Array(loaded.numAnchorPoints).fill(1));
      setSelectedHandleIndex(0);
      setSelectedMidpointIndex(null);
      setPathVersion((v) => v + 1);
    } catch {
      // keep current path if local storage is invalid
    }
  }

  function resetPath(): void {
    if (!activePathId) return;
    const reset = createDefaultBezier();
    setBezierPath(reset);
    setAnchorScales(new Array(reset.numAnchorPoints).fill(1));
    setSelectedHandleIndex(0);
    setSelectedMidpointIndex(null);
    setPathVersion((v) => v + 1);
  }

  const pendingShotTimeRef = useRef<number | null>(null);

  function captureVirtualCamera(): void {
    setVirtualCameraCaptureRequest((request) => request + 1);
  }

  function addDemoVcam(
    bodyType: DemoVirtualCamera["bodyType"],
    namePrefix: string,
    snapshot: Omit<VirtualCameraSnapshot, "name" | "settings">,
    startTime?: number | null
  ): void {
    const id = `vcam-${Date.now()}-${virtualCameras.length + 1}`;
    const name = `${namePrefix} ${virtualCameras.length + 1}`;
    const shotStart =
      startTime ?? virtualCameras.reduce((end, vcam) => Math.max(end, vcam.shotEnd), 0);
    const editor: EditorVcam = { noisePreset: "off", composerSettings: DEFAULT_COMPOSER_SETTINGS };
    const def =
      bodyType === "cart"
        ? ({
            id,
            name,
            body: { type: "cart", cartId: defaultDollyId, positionOffset: { x: 0, y: 0, z: 0 } },
            ...(snapshot.lens && { lens: snapshot.lens })
          } as VirtualCameraDefinition)
        : bodyType === "orbit"
          ? ({
              id,
              name,
              body: {
                type: "orbit",
                target: registeredTargets[0]?.id
                  ? { targetId: registeredTargets[0].id }
                  : { x: 0, y: 0, z: 0 },
                azimuthDeg: ORBIT_DEFAULTS.orbitAzimuthDeg,
                elevationDeg: ORBIT_DEFAULTS.orbitElevationDeg,
                radius: ORBIT_DEFAULTS.orbitRadius,
                binding: ORBIT_DEFAULTS.orbitBinding
              },
              control: ORBIT_INTERACTIVE_CONTROL,
              ...(snapshot.lens && { lens: snapshot.lens })
            } as VirtualCameraDefinition)
          : ({
              id,
              name,
              body: { type: "static", position: snapshot.position, quaternion: snapshot.quaternion },
              ...(snapshot.lens && { lens: snapshot.lens })
            } as VirtualCameraDefinition);
    select("camera", id);
    setVcamDefs((current) => [...current, def]);
    setEditorVcams((current) => ({ ...current, [id]: editor }));
    setShotTiming((current) => ({
      ...current,
      [id]: { start: shotStart, end: shotStart + 5 }
    }));
  }

  function addCapturedVirtualCamera(snapshot: VirtualCameraSnapshot): void {
    addDemoVcam("static", "VCam", snapshot, pendingShotTimeRef.current);
    pendingShotTimeRef.current = null;
  }

  function addCartVirtualCamera(startTime?: number | null): void {
    // Guard: this is wired to button onClick in places, which passes the event.
    const start = typeof startTime === "number" ? startTime : null;
    addDemoVcam(
      "cart",
      "Cart VCam",
      {
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        lens: { fov: 45 }
      },
      start
    );
  }

  function addOrbitVirtualCamera(startTime?: number | null): void {
    const start = typeof startTime === "number" ? startTime : null;
    addDemoVcam(
      "orbit",
      "Orbit VCam",
      {
        position: { x: 0, y: 0, z: 0 },
        quaternion: { x: 0, y: 0, z: 0, w: 1 },
        lens: { fov: 45 }
      },
      start
    );
  }

  function activateVirtualCamera(id: string): void {
    const camera = virtualCameras.find((item) => item.id === id);
    if (!camera) return;

    const durationSeconds = virtualCameraBlendCurve === "cut" ? 0 : virtualCameraBlendDuration;
    selectVirtualCamera(id);
    setVirtualCameraTransitionProgress(durationSeconds <= 0 ? 1 : 0);
    setVirtualCameraActivation({
      key: Date.now(),
      toId: id,
      durationSeconds,
      curve: virtualCameraBlendCurve
    });
  }

  // Routes a shot-panel patch onto the authoritative model: timing to the
  // shotTiming sidecar, noise preset to the editor sidecar (+ expanded onto the
  // definition), and aim/dutch/cart fields onto the definition itself.
  function updateVirtualCameraShot(id: string, patch: DemoShotPatch): void {
    if (patch.shotStart !== undefined || patch.shotEnd !== undefined) {
      setShotTiming((current) => {
        const prev = current[id] ?? DEFAULT_SHOT_TIMING;
        return {
          ...current,
          [id]: { start: patch.shotStart ?? prev.start, end: patch.shotEnd ?? prev.end }
        };
      });
    }
    if (patch.noisePreset !== undefined) {
      const preset = patch.noisePreset;
      setEditorVcams((current) => ({
        ...current,
        [id]: { ...(current[id] ?? DEFAULT_EDITOR_VCAM), noisePreset: preset }
      }));
    }
    // Every definition-shaped field (noise expansion, aim, dutch, cart) in one
    // pass over vcamDefs; the editor-sidecar write above stays separate.
    const orbitPatched =
      patch.orbitTargetId !== undefined ||
      patch.orbitAzimuthDeg !== undefined ||
      patch.orbitElevationDeg !== undefined ||
      patch.orbitRadius !== undefined ||
      patch.orbitBinding !== undefined ||
      patch.orbitAutoDegPerSec !== undefined;
    if (
      patch.noisePreset !== undefined ||
      patch.trackTargetId !== undefined ||
      patch.dutchDeg !== undefined ||
      patch.cartId !== undefined ||
      patch.cartOffset !== undefined ||
      patch.overrideControl !== undefined ||
      orbitPatched
    ) {
      setVcamDefs((current) =>
        current.map((def) => {
          if (def.id !== id) return def;
          const next: VirtualCameraDefinition = { ...def };
          if (patch.noisePreset !== undefined) {
            const noise = expandNoisePreset(patch.noisePreset);
            if (noise) next.noise = noise;
            else delete next.noise;
          }
          if (patch.trackTargetId !== undefined) {
            if (patch.trackTargetId) {
              next.aim = {
                type: "track",
                target: { targetId: patch.trackTargetId },
                settings: editorVcams[id]?.composerSettings ?? DEFAULT_COMPOSER_SETTINGS
              };
            } else {
              delete next.aim;
            }
          }
          if (patch.dutchDeg !== undefined) {
            const lens = { ...next.lens };
            if (patch.dutchDeg === 0) delete lens.dutchDeg;
            else lens.dutchDeg = patch.dutchDeg;
            if (Object.keys(lens).length > 0) next.lens = lens;
            else delete next.lens;
          }
          if (patch.cartId !== undefined && next.body.type === "cart") {
            next.body = { ...next.body, cartId: patch.cartId };
          }
          if (patch.cartOffset !== undefined && next.body.type === "cart") {
            next.body = { ...next.body, positionOffset: patch.cartOffset };
          }
          if (orbitPatched && next.body.type === "orbit") {
            const body = { ...next.body };
            if (patch.orbitTargetId !== undefined) {
              body.target = patch.orbitTargetId
                ? { targetId: patch.orbitTargetId }
                : { x: 0, y: 0, z: 0 };
            }
            if (patch.orbitAzimuthDeg !== undefined) body.azimuthDeg = patch.orbitAzimuthDeg;
            if (patch.orbitElevationDeg !== undefined) body.elevationDeg = patch.orbitElevationDeg;
            if (patch.orbitRadius !== undefined) body.radius = patch.orbitRadius;
            if (patch.orbitBinding !== undefined) body.binding = patch.orbitBinding;
            if (patch.orbitAutoDegPerSec !== undefined) {
              if (patch.orbitAutoDegPerSec === 0) delete body.autoOrbitDegPerSec;
              else body.autoOrbitDegPerSec = patch.orbitAutoDegPerSec;
            }
            next.body = body;
          }
          // Manual override lives at the definition level (any body). Attach it only
          // when an axis is pilotable, so all-locked shots keep the package fast-path.
          if (patch.overrideControl !== undefined) {
            if (hasActiveOverrideAxis(patch.overrideControl)) next.control = patch.overrideControl;
            else delete next.control;
          }
          return next;
        })
      );
    }
  }

  function updateVirtualCameraComposer(id: string, settings: ComposerSettings): void {
    setEditorVcams((current) => ({
      ...current,
      [id]: { ...(current[id] ?? DEFAULT_EDITOR_VCAM), composerSettings: settings }
    }));
    setVcamDefs((current) =>
      current.map((def) =>
        def.id === id && def.aim?.type === "track"
          ? { ...def, aim: { ...def.aim, settings } }
          : def
      )
    );
  }

  function deleteVirtualCamera(id: string): void {
    setVcamDefs((current) => current.filter((def) => def.id !== id));
    setEditorVcams((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setShotTiming((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    if (isSelected(selection, "camera", id)) {
      setSelection(null);
    }
    if (virtualCameraActivation?.toId === id) {
      releaseVirtualCamera();
    }
  }

  function releaseVirtualCamera(): void {
    setVirtualCameraActivation(null);
    setVirtualCameraTransitionProgress(1);
  }

  function selectVirtualCamera(id: string | null): void {
    select("camera", id);
  }

  function updateVirtualCameraSnapshot(id: string, snapshot: VirtualCameraSnapshot): void {
    setVcamDefs((current) =>
      current.map((def) => {
        if (def.id !== id || def.body.type !== "static") return def;
        const next: VirtualCameraDefinition = {
          ...def,
          body: { type: "static", position: snapshot.position, quaternion: snapshot.quaternion }
        };
        if (snapshot.lens && Object.keys(snapshot.lens).length > 0) next.lens = { ...snapshot.lens };
        else delete next.lens;
        return next;
      })
    );
    if (virtualCameraActivation?.toId === id) {
      releaseVirtualCamera();
    }
  }

  // Activation + audio tracks as timeline lanes (alongside shot/dolly lanes). Lane
  // id encodes the kind (act:/aud:) + track id; clip create/move routes back into
  // extraTracks. Delete stays in the side-panel editors, like dolly moves.
  const newClipId = (): string => `clip-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  const extraLanes = [
    ...extraTracks.activationTracks.map((track) => ({
      id: `act:${track.id}`,
      name: activatables.find((a) => a.id === track.objectId)?.name ?? track.objectId ?? "Activation",
      color: "rgba(56, 189, 248, 0.6)",
      icon: <IconEye size={14} />,
      clips: track.clips.map((c) => ({ id: c.id, start: c.start, end: c.end }))
    })),
    ...extraTracks.audioTracks.map((track) => ({
      id: `aud:${track.id}`,
      name: track.name ?? "Audio",
      color: "rgba(167, 139, 250, 0.6)",
      icon: <IconVolume size={14} />,
      clips: track.clips.map((c) => {
        const peaks = c.peaks ?? ensurePeaks(c.src, () => setPeaksTick((t) => t + 1));
        return {
          id: c.id,
          start: c.start,
          end: c.start + c.duration,
          label: c.src,
          ...(peaks && { series: { kind: "envelope", points: peaks } as const })
        };
      })
    }))
  ];
  const setExtraClip = (laneId: string, clipId: string, start: number, end: number): void => {
    if (laneId.startsWith("act:")) {
      const trackId = laneId.slice(4);
      setExtraTracks((prev) => ({
        ...prev,
        activationTracks: prev.activationTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, start, end } : c)) } : t
        )
      }));
    } else if (laneId.startsWith("aud:")) {
      const trackId = laneId.slice(4);
      setExtraTracks((prev) => ({
        ...prev,
        audioTracks: prev.audioTracks.map((t) =>
          t.id === trackId ? { ...t, clips: t.clips.map((c) => (c.id === clipId ? { ...c, start, duration: Math.max(0.25, end - start) } : c)) } : t
        )
      }));
    }
  };
  const addExtraClip = (laneId: string, time: number): void => {
    const start = Math.max(0, Math.round(time * 4) / 4);
    if (laneId.startsWith("act:")) {
      const trackId = laneId.slice(4);
      setExtraTracks((prev) => ({
        ...prev,
        activationTracks: prev.activationTracks.map((t) =>
          t.id === trackId ? { ...t, clips: [...t.clips, { id: newClipId(), start, end: start + 2 }] } : t
        )
      }));
    } else if (laneId.startsWith("aud:")) {
      const trackId = laneId.slice(4);
      setExtraTracks((prev) => ({
        ...prev,
        audioTracks: prev.audioTracks.map((t) =>
          t.id === trackId
            ? { ...t, clips: [...t.clips, { id: newClipId(), src: SAMPLE_AUDIO[t.clips.length % SAMPLE_AUDIO.length]!, start, duration: 4, gain: 1 }] }
            : t
        )
      }));
    }
  };

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <style>{panelGlobalCss}</style>
      <div
        className="pc-panel"
        style={{
          position: "fixed",
          top: 12,
          left: 12,
          zIndex: 10,
          width: 380,
          maxHeight: "calc(100vh - 24px)",
          display: "flex",
          flexDirection: "column",
          borderRadius: 0,
          boxShadow: "0 24px 60px rgba(0, 0, 0, 0.45)",
          border: `1px solid ${BORDER}`,
          boxSizing: "border-box",
          overflow: "hidden"
        }}
      >
        <header style={{ padding: "12px 14px", borderBottom: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.02em" }}>Path Creator Demo</div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
            Edit spline, drive rigs, validate cameras
          </div>
        </header>

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 14px 12px" }}>
        <SettingsSection title="Path Editing">
          {!bezierPath ? (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              No editable path. Add a path below (or right-click the timeline) to start editing.
            </div>
          ) : (
          <>
          {selectedAnchorScaleForUi !== null ? (
            <div style={{ fontSize: 12, color: "#e2e8f0" }}>
              Selected anchor scale: {selectedAnchorScaleForUi.toFixed(2)}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: "#94a3b8" }}>
              Select an anchor to move, rotate, or scale it.
            </div>
          )}

          <label style={{ display: "block", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={useWorldSpaceGizmo}
              onChange={(e) => setUseWorldSpaceGizmo(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>World-space gizmo</span>
          </label>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={addAnchor}>Add Anchor</button>
            <button onClick={insertAnchorAtSelectedSegment}>Insert Midpoint</button>
            <button onClick={deleteSelectedAnchor}>Delete Anchor</button>
            <button
              onClick={() =>
                mutatePath((p) => {
                  p.autoSmooth();
                })
              }
            >
              Auto Smooth
            </button>
            <button onClick={() => mutatePath((p) => p.setClosed(!p.isClosed))}>
              {bezierPath.isClosed ? "Open Path" : "Close Path"}
            </button>
            <button onClick={resetPath}>Reset Path</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <button onClick={savePath}>Save Path</button>
            <button onClick={loadPath}>Load Path</button>
          </div>

          <label style={{ display: "grid", gridTemplateColumns: "112px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span>Control Mode</span>
            <select
              value={bezierPath.controlMode}
              onChange={(e) => {
                mutatePath((p) => p.setControlMode(e.target.value as ControlMode));
              }}
            >
              <option value={ControlMode.Automatic}>Automatic</option>
              <option value={ControlMode.Free}>Free</option>
              <option value={ControlMode.Aligned}>Aligned</option>
              <option value={ControlMode.Mirrored}>Mirrored</option>
            </select>
          </label>
          </>
          )}
        </SettingsSection>

        <SettingsSection title="Dollies">
          <div style={{ display: "grid", gap: 4 }}>
            {dollies.map((dolly) => (
              <div key={dolly.id} style={{ display: "grid", gap: 3 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <input
                    type="text"
                    value={dolly.name ?? ""}
                    aria-label="Dolly name"
                    onChange={(event) => updateDolly(dolly.id, { name: event.target.value })}
                    style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
                  />
                  <select
                    title="Which path this dolly rides"
                    value={dolly.pathId}
                    onChange={(event) => updateDolly(dolly.id, { pathId: event.target.value })}
                  >
                    {paths.map((path) => (
                      <option key={path.id} value={path.id}>
                        {path.name}
                      </option>
                    ))}
                  </select>
                  <select
                    title="End-of-rail behavior for this dolly"
                    value={dolly.endOfPathInstruction}
                    onChange={(event) =>
                      updateDolly(dolly.id, {
                        endOfPathInstruction: event.target.value as EndOfPathInstruction
                      })
                    }
                  >
                    <option value={EndOfPathInstruction.Loop}>Loop</option>
                    <option value={EndOfPathInstruction.Reverse}>Ping-pong</option>
                    <option value={EndOfPathInstruction.Stop}>Stop</option>
                  </select>
                  <button onClick={() => deleteDolly(dolly.id)}>Del</button>
                </div>
                {/* Per-dolly free-run speed (used where a dolly has no move keyframes). */}
                <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, paddingLeft: 10, color: MUTED }}>
                  <span style={{ width: 30 }}>speed</span>
                  <input
                    type="range"
                    min={0.2}
                    max={3}
                    step={0.1}
                    value={dolly.speed}
                    title="Free-run speed for this dolly"
                    style={{ flex: 1 }}
                    onChange={(event) => updateDolly(dolly.id, { speed: Number(event.target.value) })}
                  />
                  <span style={{ width: 26, textAlign: "right" }}>{dolly.speed.toFixed(1)}</span>
                </div>
                {/* Dolly moves: over [start,end] the dolly eases from→to (distance). */}
                {(dollyRuns[dolly.id] ?? []).map((run) => (
                  <div
                    key={run.id}
                    style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 11, paddingLeft: 10, color: "#94a3b8" }}
                  >
                    <span style={{ width: 30 }}>move</span>
                    <input type="number" title="start (s)" value={run.start} step={0.25} style={{ width: 46 }}
                      onChange={(event) => updateDollyRun(dolly.id, run.id, { start: Number(event.target.value) })} />
                    <input type="number" title="end (s)" value={run.end} step={0.25} style={{ width: 46 }}
                      onChange={(event) => updateDollyRun(dolly.id, run.id, { end: Number(event.target.value) })} />
                    <input type="number" title="from (0–1 along path)" value={run.fromT} min={0} max={1} step={0.05} style={{ width: 46 }}
                      onChange={(event) => updateDollyRun(dolly.id, run.id, { fromT: Number(event.target.value) })} />
                    <span>→</span>
                    <input type="number" title="to (0–1 along path)" value={run.toT} min={0} max={1} step={0.05} style={{ width: 46 }}
                      onChange={(event) => updateDollyRun(dolly.id, run.id, { toT: Number(event.target.value) })} />
                    <button title="Delete move" onClick={() => deleteDollyRun(dolly.id, run.id)}>×</button>
                  </div>
                ))}
                <button style={{ fontSize: 11, justifySelf: "start", marginLeft: 10 }} onClick={() => addDollyRun(dolly.id, 0)}>
                  + move
                </button>
              </div>
            ))}
            <button onClick={addDolly}>Add Dolly</button>
          </div>
        </SettingsSection>

        <SettingsSection title="Activation">
          <ActivationTracksEditor
            activationTracks={extraTracks.activationTracks}
            audioTracks={extraTracks.audioTracks}
            activatables={activatables}
            onChange={setExtraTracks}
          />
        </SettingsSection>

        <SettingsSection title="Audio">
          <AudioTracksEditor
            activationTracks={extraTracks.activationTracks}
            audioTracks={extraTracks.audioTracks}
            onChange={setExtraTracks}
          />
        </SettingsSection>

        <SettingsSection title="Paths">
          <div style={{ display: "grid", gap: 4 }}>
            {paths.map((path) => (
              <div
                key={path.id}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
              >
                <input
                  type="radio"
                  name="active-path"
                  title="Edit this path in the viewport"
                  checked={path.id === activePathId}
                  onChange={() => switchPath(path.id)}
                />
                <input
                  type="text"
                  value={path.name ?? ""}
                  aria-label="Path name"
                  onChange={(event) => renamePath(path.id, event.target.value)}
                  style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
                />
                <button onClick={() => deletePath(path.id)}>Del</button>
              </div>
            ))}
            <button onClick={addPath}>Add Path</button>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>
              The selected path is editable in the viewport; others render dashed.
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Targets">
          <div style={{ display: "grid", gap: 4 }}>
            {pointTargets.map((target) => (
              <div
                key={target.id}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
              >
                <input
                  type="radio"
                  name="selected-target"
                  title="Select this target"
                  checked={target.id === selectedPointTargetId}
                  onChange={() => selectPointTarget(target.id)}
                />
                <input
                  type="text"
                  value={target.name ?? ""}
                  aria-label="Target name"
                  onChange={(event) => renamePointTarget(target.id, event.target.value)}
                  onFocus={() => selectPointTarget(target.id)}
                  style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
                />
                <select
                  title="Mount: static, or ride a dolly"
                  value={target.type === "cart" ? target.cartId : ""}
                  onChange={(event) => setPointTargetMount(target.id, event.target.value || null)}
                >
                  <option value="">Static</option>
                  {dollies.map((dolly) => (
                    <option key={dolly.id} value={dolly.id}>
                      {dolly.name}
                    </option>
                  ))}
                </select>
                <button
                  title={
                    target.visibleInRender
                      ? "Visible in render — click to hide (invisible aim point)"
                      : "Hidden in render — click to show"
                  }
                  aria-label={target.visibleInRender ? "Hide target in render" : "Show target in render"}
                  onClick={() => togglePointTargetVisible(target.id)}
                  style={{
                    width: 28,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    padding: 0,
                    color: target.visibleInRender ? TEXT : MUTED
                  }}
                >
                  {target.visibleInRender ? <IconEye size={15} /> : <IconEyeOff size={15} />}
                </button>
                <button onClick={() => deletePointTarget(target.id)}>Del</button>
              </div>
            ))}
            <button onClick={addPointTarget}>Add Target</button>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>
              A vcam aim can track any target. Static targets drag to place; mount one on a
              dolly to ride the rail. The eye hides it from the render (still an aim point).
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Viewport Debug">
          <div
            role="group"
            aria-label="View mode"
            title="Edit: editor camera + controls in the main view, driven camera in the PiP. Play: driven camera fills the main view and all interaction pilots it. Shortcut: P"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 8 }}
          >
            {(["edit", "play"] as const).map((mode) => {
              const active = viewMode === mode;
              return (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: 6,
                    padding: "6px 8px",
                    fontSize: 12,
                    fontWeight: 700,
                    textTransform: "capitalize",
                    borderRadius: 0,
                    cursor: "pointer",
                    color: active ? "#0f172a" : "#cbd5e1",
                    background: active
                      ? mode === "play"
                        ? "rgba(34, 197, 94, 0.9)"
                        : "rgba(148, 163, 184, 0.9)"
                      : "rgba(15, 23, 42, 0.6)",
                    border: `1px solid ${active ? "transparent" : "rgba(148, 163, 184, 0.25)"}`
                  }}
                >
                  {mode === "play" ? <IconVideo size={13} /> : <IconDirector size={13} />}
                  {mode === "play" ? "Play" : "Edit"}
                </button>
              );
            })}
          </div>
          <label style={{ display: "block", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={debugPreview}
              onChange={(e) => setDebugPreview(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>Show camera PiP</span>
          </label>

          <label style={{ display: "block", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={debugFrustum}
              onChange={(e) => setDebugFrustum(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>Show camera frustum</span>
          </label>

          <label style={{ display: "block", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={pathStyle === "rail"}
              onChange={(e) => setPathStyle(e.target.checked ? "rail" : "line")}
            />
            <span style={{ marginLeft: 6 }}>Path as dolly rail</span>
          </label>

          <div style={{ fontSize: 11, color: MUTED, lineHeight: 1.45 }}>
            Orbit: right-drag. Pan: middle-drag. Zoom: wheel.
          </div>
        </SettingsSection>
        </div>

        <footer style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", borderTop: `1px solid ${BORDER}` }}>
          <button className="pc-danger" onClick={newScene}>New</button>
          <button onClick={() => importInputRef.current?.click()}>Import</button>
          <button onClick={exportScene}>Export</button>
          <input
            ref={importInputRef}
            type="file"
            accept=".json,application/json"
            style={{ display: "none" }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) importSceneFile(file);
              event.currentTarget.value = "";
            }}
          />
        </footer>
      </div>

      <div
        style={{
          position: "fixed",
          top: 12,
          right: 12,
          zIndex: 11,
          width: 360,
          maxHeight: debugPreview ? "calc(100vh - 260px)" : "calc(100vh - 24px)",
          overflowY: "auto",
          display: "grid",
          gap: 10,
          fontFamily: "ui-sans-serif, system-ui, sans-serif"
        }}
      >
        <VirtualCameraPanel
          cameras={virtualCameras}
          activeId={virtualCameraActivation?.toId ?? null}
          selectedId={selectedVirtualCameraId}
          blendCurve={virtualCameraBlendCurve}
          blendDuration={virtualCameraBlendDuration}
          transitionProgress={virtualCameraTransitionProgress}
          onBlendCurveChange={setVirtualCameraBlendCurve}
          onBlendDurationChange={setVirtualCameraBlendDuration}
          onCapture={captureVirtualCamera}
          onAddCart={addCartVirtualCamera}
          onAddOrbit={addOrbitVirtualCamera}
          trackTargets={registeredTargets}
          onUpdateShot={updateVirtualCameraShot}
          onUpdateComposer={updateVirtualCameraComposer}
          dollies={dollies}
          onSelect={selectVirtualCamera}
          onActivate={activateVirtualCamera}
          onDelete={deleteVirtualCamera}
          onRelease={releaseVirtualCamera}
        />
      </div>
      <div
        className="pc-controls"
        style={{
          position: "fixed",
          bottom: 12,
          left: 404,
          right: 404,
          zIndex: 9
        }}
      >
        <TimelineLanes
          theme={{ panelBackground: BG, panelBorder: BORDER, text: TEXT, mutedText: MUTED, subtleText: FAINT, fontFamily: SANS }}
          shotIcon={<IconVideo size={15} />}
          dollyIcon={<IconTrack size={15} />}
          extraLanes={extraLanes}
          onExtraClipTiming={setExtraClip}
          onCreateExtraClip={addExtraClip}
          shots={virtualCameras.map((vcam) => ({
            id: vcam.id,
            name: vcam.name,
            start: vcam.shotStart,
            end: vcam.shotEnd
          }))}
          dollies={dollies.map((dolly) => ({ id: dolly.id, name: dolly.name ?? dolly.id }))}
          dollyMoves={Object.entries(dollyRuns).flatMap(([cartId, runs]) =>
            runs.map((run) => ({
              shotId: run.id,
              dollyId: cartId,
              dollyName: dollies.find((dolly) => dolly.id === cartId)?.name ?? cartId,
              start: run.start,
              end: run.end,
              label: `${run.fromT.toFixed(1)} → ${run.toT.toFixed(1)}`,
              // Speed profile only when the move actually travels.
              ...(run.fromT !== run.toT && { series: DOLLY_SPEED_SERIES })
            }))
          )}
          selectedShotId={selectedVirtualCameraId}
          playerRef={timelinePlayerRef}
          duration={demoTimeline?.duration ?? 0}
          driving={timelineActive}
          onShotTiming={(vcamId, shotStart, shotEnd) =>
            updateVirtualCameraShot(vcamId, { shotStart, shotEnd })
          }
          onDollyRunTiming={(cartId, runId, start, end) =>
            updateDollyRun(cartId, runId, { start, end })
          }
          onCreateDollyRun={(cartId, time) => addDollyRun(cartId, Math.max(0, Math.round(time * 4) / 4))}
          onSelectShot={selectVirtualCamera}
          onSeek={(time) => {
            seekTimelinePlayer(timelinePlayerRef.current, time);
            setPipDriver("timeline");
          }}
          onTransport={() => setPipDriver("timeline")}
          onCreateShot={(kind, time) => {
            const snapped = Math.max(0, Math.round(time * 4) / 4);
            if (kind === "cart") {
              addCartVirtualCamera(snapped);
            } else {
              pendingShotTimeRef.current = snapped;
              captureVirtualCamera();
            }
          }}
          onCreateDolly={addDolly}
          onCreatePath={addPath}
        />
      </div>
      {debugPreview ? (
        <DollyPreviewChrome
          label={pipLabel}
          hasSource={hasPipSource}
          composerActive={composerChromeActive}
          composerSettings={composerChromeSettings}
          targetMarkerRef={dollyTargetMarkerRef}
          targetLineRef={dollyTargetLineRef}
          lookaheadMarkerRef={lookaheadMarkerRef}
          lookaheadLineRef={lookaheadLineRef}
        />
      ) : null}
      {showPlayInput ? <CameraOverrideSurface accumulator={overrideAcc} /> : null}

      <Canvas style={{ width: "100%", height: "100%" }} camera={{ position: [0, 0, 6], fov: 45 }}>
        <color attach="background" args={["#f8fafc"]} />
        <OrbitControls
          makeDefault
          enabled={!isTransforming && (!playMode || !hasPipSource)}
          enableDamping
          dampingFactor={0.08}
          mouseButtons={{ MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }}
        />
        <ActivatablesProvider registry={activatablesRegistry}>
        <Scene
          bezierPath={bezierPath}
          vertexPath={vertexPath}
          targetRegistry={targetRegistry}
          overrideAcc={overrideAcc}
          dollyFramesRef={dollyFramesRef}
          dollies={dollies}
          vertexPaths={vertexPaths}
          activeTimeline={timelineActive ? demoTimeline : null}
          timelinePlayerRef={timelinePlayerRef}
          activationTracks={extraTracks.activationTracks}
          audioTracks={extraTracks.audioTracks}
          audioPlayer={audioPlayer}
          selection={selection}
          onSelectEntity={select}
          pathVersion={pathVersion}
          debugPreview={debugPreview}
          playMode={playMode}
          debugFrustum={debugFrustum}
          pathStyle={pathStyle}
          selectedHandleIndex={selectedHandleIndex}
          selectedMidpointIndex={selectedMidpointIndex}
          anchorScales={anchorScales}
          useWorldSpaceGizmo={useWorldSpaceGizmo}
          isTransforming={isTransforming}
          onSelectHandle={(idx) => {
            setSelectedHandleIndex(idx);
            if (idx !== null) {
              setSelectedMidpointIndex(null);
              if (activePathId) setSelection({ kind: "path", id: activePathId });
            }
          }}
          onSelectMidpoint={(idx) => {
            setSelectedMidpointIndex(idx);
            if (idx !== null) {
              setSelectedHandleIndex(null);
              if (activePathId) setSelection({ kind: "path", id: activePathId });
            }
          }}
          onTransformingChange={setIsTransforming}
          onRotateMidpointNormal={rotateMidpointNormal}
          dollyTargetMarkerRef={dollyTargetMarkerRef}
          dollyTargetLineRef={dollyTargetLineRef}
          lookaheadMarkerRef={lookaheadMarkerRef}
          lookaheadLineRef={lookaheadLineRef}
          virtualCameraCaptureRequest={virtualCameraCaptureRequest}
          virtualCameraActivation={virtualCameraActivation}
          virtualCameras={virtualCameras}
          vcamDefs={vcamDefs}
          selectedVirtualCameraId={selectedVirtualCameraId}
          onVirtualCameraCaptured={addCapturedVirtualCamera}
          onActiveVcamChange={setActiveDrivenVcamId}
          onVirtualCameraResolved={({ progress }) => {
            setVirtualCameraTransitionProgress(progress);
          }}
          onSelectVirtualCamera={selectVirtualCamera}
          onUpdateVirtualCameraSnapshot={updateVirtualCameraSnapshot}
          onUpdateCartOffset={(id, cartOffset) => updateVirtualCameraShot(id, { cartOffset })}
          onUpdateOrbitParams={(id, params) =>
            updateVirtualCameraShot(id, {
              orbitAzimuthDeg: params.azimuthDeg,
              orbitElevationDeg: params.elevationDeg,
              orbitRadius: params.radius
            })
          }
          onSetAnchorScale={(anchorIndex, scale) => {
            if (!bezierPath) return;
            setAnchorScales((prev) => {
              const next = normalizeAnchorScales(bezierPath.numAnchorPoints, prev);
              if (anchorIndex >= 0 && anchorIndex < next.length) next[anchorIndex] = scale;
              return next;
            });
          }}
          onMovePoint={(index, point) => {
            mutatePath((path) => path.movePoint(index, point));
          }}
        />
        <PointTargets
          targets={pointTargets}
          registry={targetRegistry}
          framesRef={dollyFramesRef}
          selectedId={selectedPointTargetId}
          onSelect={selectPointTarget}
          onMove={movePointTarget}
          onTransformingChange={setIsTransforming}
        />
        </ActivatablesProvider>
      </Canvas>
    </div>
  );
}
