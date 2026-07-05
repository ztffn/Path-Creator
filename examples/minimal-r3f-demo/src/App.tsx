import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, Line, OrbitControls, PivotControls, Text } from "@react-three/drei";
import {
  BezierPath,
  ControlMode,
  EndOfPathInstruction,
  PathSpace,
  TargetRegistry,
  VertexPath,
  advanceCartDistance,
  createPathCart,
  sampleCartFrame,
  type CartFrame,
  type RegisteredTarget,
  type SerializedBezierPath,
  type Vec3
} from "@huma/path-creator/core";
import {
  applySampleToObject,
  applyScreenComposerAim,
  createScreenComposerState,
  samplePathAtDistance,
  EditorHelpers,
  usePathCart,
  usePathFollower,
  useEditorHelpersVisible,
  useObjectTargets,
  useRegisteredTargets,
  useTrackingTarget
} from "@huma/path-creator/r3f";
import {
  activateVirtualCameraBrain,
  applyCartFrameToObject,
  applyVirtualCameraBrain,
  applyVirtualCameraSnapshot,
  captureVirtualCameraSnapshot,
  createVirtualCameraBrainState,
  driveVirtualCameraBrain,
  getVirtualCameraBrainProgress,
  resolveVirtualCameraDefinition,
  type VirtualCameraBlendCurve,
  type VirtualCameraDefinition,
  type VirtualCameraNoiseSettings,
  type VirtualCameraResolveContext,
  type VirtualCameraSnapshot
} from "@huma/path-creator/three";
import {
  createTimeline,
  createTimelinePlayer,
  evaluateTimeline,
  seekTimelinePlayer,
  stepTimelinePlayer,
  type Timeline,
  type TimelinePlayer,
  type TimelineRigContext
} from "@huma/path-creator/timeline";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { TimelineLanes } from "./TimelineLanes";
import {
  CameraHelper,
  Color,
  Euler,
  MOUSE,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Group,
  type Mesh
} from "three";

const STORAGE_KEY = "path-creator:minimal-demo:path";
const SHOW_STORAGE_KEY = "path-creator:minimal-demo:show";
// Correlation keys tying cart-bodied vcams to the demo rail; a rename must
// touch nothing else.
// A production can run several dollies, all riding the demo's one rail;
// cameras mount a dolly via their cart body's cartId.
type DemoPath = { id: string; name: string; bezier: SerializedBezierPath };
type DemoDolly = { id: string; name: string; endOfPath: EndOfPathInstruction; pathId: string };
const FALLBACK_PATH_ID = "path-1";
const FALLBACK_DOLLY: DemoDolly = { id: "dolly-1", name: "Dolly 1", endOfPath: EndOfPathInstruction.Loop, pathId: FALLBACK_PATH_ID };
const INITIAL_DOLLIES: DemoDolly[] = [FALLBACK_DOLLY];
const DOLLY_PIP_ASPECT = 16 / 9;
const DOLLY_PIP_MARGIN = 16;
const STATIC_CAMERA_POSITION = { x: 0, y: 1.1, z: 6 };
type CameraPoseSource = "dolly" | "static";
type CameraAimMode = "path-lookahead" | "look-at-target" | "screen-composer";
type VirtualCameraCaptureSource = "rig" | "viewport";

type ComposerSettings = {
  pathLookaheadDistance: number;
  targetWeight: number;
  targetOffsetX: number;
  targetOffsetY: number;
  targetOffsetZ: number;
  screenX: number;
  screenY: number;
  deadWidth: number;
  deadHeight: number;
  softWidth: number;
  softHeight: number;
  hardWidth: number;
  hardHeight: number;
  dampingX: number;
  dampingY: number;
  lookaheadTime: number;
  lookaheadSmoothing: number;
  lookaheadIgnoreY: boolean;
  centerOnActivate: boolean;
};

type DemoNoisePreset = "off" | "subtle" | "rough";

const NOISE_PRESETS: Record<DemoNoisePreset, VirtualCameraNoiseSettings | undefined> = {
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

type DemoVirtualCamera = {
  id: string;
  name: string;
  bodyType: "static" | "cart";
  /** Which dolly a cart body mounts. */
  cartId: string;
  /** Rail-local camera offset for cart bodies (x=right, y=up, z=forward). */
  cartOffset: Vec3;
  trackTargetId: string | null;
  noisePreset: DemoNoisePreset;
  dutchDeg: number;
  /** Block placement on the show timeline; overlap with the previous shot crossfades. */
  shotStart: number;
  shotEnd: number;
  /**
   * Dolly move for cart shots: rail distance at shot start/end, compiled to
   * cart-track keys. Null = the cart free-runs at the rig speed.
   */
  railFrom: number | null;
  railTo: number | null;
  snapshot: VirtualCameraSnapshot;
  poseSource: CameraPoseSource;
  aimMode: CameraAimMode;
  composerSettings: ComposerSettings;
};

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
    | "railFrom"
    | "railTo"
  >
>;

function toDemoVcamDefinition(vcam: DemoVirtualCamera): VirtualCameraDefinition {
  const noise = NOISE_PRESETS[vcam.noisePreset];
  const lens = {
    ...vcam.snapshot.lens,
    ...(vcam.dutchDeg !== 0 && { dutchDeg: vcam.dutchDeg })
  };
  return {
    id: vcam.id,
    name: vcam.name,
    body:
      vcam.bodyType === "cart"
        ? { type: "cart", cartId: vcam.cartId, positionOffset: vcam.cartOffset }
        : {
            type: "static",
            position: vcam.snapshot.position,
            quaternion: vcam.snapshot.quaternion
          },
    ...(vcam.trackTargetId && {
      aim: { type: "look-at" as const, target: { targetId: vcam.trackTargetId } }
    }),
    ...(noise && { noise }),
    ...(Object.keys(lens).length > 0 && { lens }),
    ...(vcam.snapshot.settings && { settings: vcam.snapshot.settings })
  };
}

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

const DEFAULT_COMPOSER_SETTINGS: ComposerSettings = {
  pathLookaheadDistance: 0.85,
  targetWeight: 1,
  targetOffsetX: 0,
  targetOffsetY: 0,
  targetOffsetZ: 0,
  screenX: 0,
  screenY: 0,
  deadWidth: 0.18,
  deadHeight: 0.14,
  softWidth: 0.55,
  softHeight: 0.45,
  hardWidth: 0.9,
  hardHeight: 0.85,
  dampingX: 6,
  dampingY: 8,
  lookaheadTime: 0.2,
  lookaheadSmoothing: 8,
  lookaheadIgnoreY: false,
  centerOnActivate: false
};

const VIRTUAL_CAMERA_SETTING_KEYS = [
  "pathLookaheadDistance",
  "targetWeight",
  "targetOffsetX",
  "targetOffsetY",
  "targetOffsetZ",
  "screenX",
  "screenY",
  "deadWidth",
  "deadHeight",
  "softWidth",
  "softHeight",
  "hardWidth",
  "hardHeight",
  "dampingX",
  "dampingY",
  "lookaheadTime",
  "lookaheadSmoothing"
] as const;

function createMobiusLikeAnchors(count = 10): Vec3[] {
  const anchors: Vec3[] = [];
  const radius = 2.2;
  const halfWidth = 0.7;
  const tMin = -Math.PI * 0.9;
  const tMax = Math.PI * 0.9;

  for (let i = 0; i < count; i += 1) {
    const u = count === 1 ? 0 : i / (count - 1);
    const t = tMin + (tMax - tMin) * u;
    const w = Math.sin(t * 1.3) * halfWidth;

    const x = (radius + w * Math.cos(t * 0.5)) * Math.cos(t);
    const y = (radius + w * Math.cos(t * 0.5)) * Math.sin(t) * 0.45;
    const z = w * Math.sin(t * 0.5) * 2.4;

    anchors.push({ x, y, z });
  }

  return anchors;
}

function createDefaultBezier(): BezierPath {
  return new BezierPath(
    createMobiusLikeAnchors(10),
    {
      space: PathSpace.XYZ,
      controlMode: ControlMode.Free
    }
  );
}

function getSuggestedNextAnchor(path: BezierPath): Vec3 {
  const lastAnchorIndex = path.numAnchorPoints - 1;
  const lastAnchor = path.getAnchor(lastAnchorIndex);
  const prevAnchor = path.getAnchor(Math.max(0, lastAnchorIndex - 1));
  const lastControl = path.getPoint(path.numPoints - 2);

  let tangentX = lastAnchor.x - lastControl.x;
  let tangentY = lastAnchor.y - lastControl.y;
  let tangentZ = lastAnchor.z - lastControl.z;
  let tangentLen = Math.hypot(tangentX, tangentY, tangentZ);

  let pathX = lastAnchor.x - prevAnchor.x;
  let pathY = lastAnchor.y - prevAnchor.y;
  let pathZ = lastAnchor.z - prevAnchor.z;
  let pathLen = Math.hypot(pathX, pathY, pathZ);

  if (tangentLen < 1e-5 && pathLen >= 1e-5) {
    tangentX = pathX;
    tangentY = pathY;
    tangentZ = pathZ;
    tangentLen = pathLen;
  }

  if (pathLen < 1e-5 && tangentLen >= 1e-5) {
    pathX = tangentX;
    pathY = tangentY;
    pathZ = tangentZ;
    pathLen = tangentLen;
  }

  if (tangentLen < 1e-5 && pathLen < 1e-5) {
    tangentX = 1;
    tangentY = 0;
    tangentZ = 0;
    tangentLen = 1;
    pathX = 1;
    pathY = 0;
    pathZ = 0;
    pathLen = 1;
  }

  tangentX /= tangentLen;
  tangentY /= tangentLen;
  tangentZ /= tangentLen;
  pathX /= pathLen;
  pathY /= pathLen;
  pathZ /= pathLen;

  let dirX = tangentX * 0.65 + pathX * 0.35;
  let dirY = tangentY * 0.65 + pathY * 0.35;
  let dirZ = tangentZ * 0.65 + pathZ * 0.35;
  let dirLen = Math.hypot(dirX, dirY, dirZ);
  if (dirLen < 1e-5) {
    dirX = tangentX;
    dirY = tangentY;
    dirZ = tangentZ;
    dirLen = 1;
  }
  dirX /= dirLen;
  dirY /= dirLen;
  dirZ /= dirLen;

  const segmentLength = Math.hypot(
    lastAnchor.x - prevAnchor.x,
    lastAnchor.y - prevAnchor.y,
    lastAnchor.z - prevAnchor.z
  );
  const travel = Math.max(0.25, segmentLength);

  return {
    x: lastAnchor.x + dirX * travel,
    y: lastAnchor.y + dirY * travel,
    z: lastAnchor.z + dirZ * travel
  };
}

function buildPathLinePoints(path: VertexPath): [number, number, number][] {
  const values: [number, number, number][] = [];
  for (let i = 0; i < path.numPoints; i += 1) {
    const p = path.getPoint(i);
    values.push([p.x, p.y, p.z]);
  }
  return values;
}

function buildControlLinePositions(path: BezierPath): Float32Array {
  const values: number[] = [];
  for (let i = 0; i < path.numSegments; i += 1) {
    const [a, c1, c2, b] = path.getPointsInSegment(i);
    values.push(a.x, a.y, a.z, c1.x, c1.y, c1.z);
    values.push(b.x, b.y, b.z, c2.x, c2.y, c2.z);
  }
  return new Float32Array(values);
}

function getSurfaceAlignedQuaternion(path: VertexPath, point: Vec3): [number, number, number, number] {
  const t = path.getClosestTimeOnPath(point);
  const n = path.getNormalAtTime(t, EndOfPathInstruction.Stop);
  const normal = new Vector3(n.x, n.y, n.z).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal);
  return [q.x, q.y, q.z, q.w];
}

function quatFromNormal(normal: Vector3): [number, number, number, number] {
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), normal.clone().normalize());
  return [q.x, q.y, q.z, q.w];
}

function getMidpointFrame(path: VertexPath, point: Vec3): {
  normal: Vector3;
  tangent: Vector3;
  rotation: [number, number, number];
} {
  const t = path.getClosestTimeOnPath(point);
  const n = path.getNormalAtTime(t, EndOfPathInstruction.Stop);
  const d = path.getDirection(t, EndOfPathInstruction.Stop);
  const normal = new Vector3(n.x, n.y, n.z).normalize();
  const tangent = new Vector3(d.x, d.y, d.z).normalize();
  const binormal = new Vector3().crossVectors(tangent, normal).normalize();
  const matrix = new Matrix4().makeBasis(binormal, normal, tangent);
  const quat = new Quaternion().setFromRotationMatrix(matrix);
  const euler = new Euler().setFromQuaternion(quat, "XYZ");
  return { normal, tangent, rotation: [euler.x, euler.y, euler.z] };
}

function normalizeAnchorScales(count: number, previous: number[]): number[] {
  const next = previous.slice(0, count);
  while (next.length < count) next.push(1);
  return next;
}

function getAnchorPointIndexForHandle(path: BezierPath, pointIndex: number): number {
  const mod = pointIndex % 3;
  if (mod === 0) return pointIndex;
  if (mod === 1) return Math.max(0, pointIndex - 1);
  return Math.min(path.numPoints - 1, pointIndex + 1);
}

function getPathLookTarget(samplePosition: Vec3, pathLookTarget: Vec3, trackingTarget: Vec3): Vec3 {
  const dx = pathLookTarget.x - samplePosition.x;
  const dy = pathLookTarget.y - samplePosition.y;
  const dz = pathLookTarget.z - samplePosition.z;
  return dx * dx + dy * dy + dz * dz < 1e-5 ? trackingTarget : pathLookTarget;
}

function getWeightedTarget(pathTarget: Vec3, trackingTarget: Vec3, settings: ComposerSettings): Vec3 {
  const weight = Math.max(0, Math.min(1, settings.targetWeight));
  return {
    x: pathTarget.x + (trackingTarget.x + settings.targetOffsetX - pathTarget.x) * weight,
    y: pathTarget.y + (trackingTarget.y + settings.targetOffsetY - pathTarget.y) * weight,
    z: pathTarget.z + (trackingTarget.z + settings.targetOffsetZ - pathTarget.z) * weight
  };
}

function getComposerZones(settings: ComposerSettings) {
  return {
    deadZone: { width: settings.deadWidth, height: settings.deadHeight },
    softZone: { width: settings.softWidth, height: settings.softHeight },
    hardLimits: { width: settings.hardWidth, height: settings.hardHeight }
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

function composerSettingsToVirtualCameraSettings(
  settings: ComposerSettings
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const key of VIRTUAL_CAMERA_SETTING_KEYS) {
    values[key] = settings[key];
  }
  return values;
}

function mergeVirtualCameraSettings(
  base: ComposerSettings,
  values: Record<string, number> | undefined
): ComposerSettings {
  if (!values) return base;
  const next = { ...base };
  for (const key of VIRTUAL_CAMERA_SETTING_KEYS) {
    const value = values[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      next[key] = value;
    }
  }
  return next;
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

function applyCameraPose(
  camera: PerspectiveCamera,
  poseSource: CameraPoseSource,
  samplePosition: Vec3,
  target: Vector3,
  deltaSeconds: number
): void {
  const alpha = 1 - Math.exp(-8 * deltaSeconds);
  if (poseSource === "dolly") {
    target.set(samplePosition.x, samplePosition.y, samplePosition.z);
  } else {
    target.set(STATIC_CAMERA_POSITION.x, STATIC_CAMERA_POSITION.y, STATIC_CAMERA_POSITION.z);
  }
  camera.position.lerp(target, alpha);
}

function applyCameraAim(
  camera: PerspectiveCamera,
  aimMode: CameraAimMode,
  target: Vec3,
  railUp: Vec3,
  settings: ComposerSettings,
  composerState: ReturnType<typeof createScreenComposerState>,
  deltaSeconds: number
): void {
  if (aimMode === "screen-composer") {
    applyScreenComposerAim(
      camera,
      target,
      railUp,
      composerState,
      {
        screenPosition: { x: settings.screenX, y: settings.screenY },
        ...getComposerZones(settings),
        damping: { x: settings.dampingX, y: settings.dampingY },
        lookaheadTime: settings.lookaheadTime,
        lookaheadSmoothing: settings.lookaheadSmoothing,
        lookaheadIgnoreY: settings.lookaheadIgnoreY,
        centerOnActivate: settings.centerOnActivate
      },
      deltaSeconds
    );
    return;
  }

  composerState.initialized = false;
  camera.up.set(railUp.x, railUp.y, railUp.z).normalize();
  camera.lookAt(target.x, target.y, target.z);
}

const CART_RIDER_SPEED = 0.8;

const VCAM_PIVOT_PROPS = {
  autoTransform: false,
  fixed: true,
  scale: 75,
  lineWidth: 2,
  depthTest: false
} as const;

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

function CartRiderProp({
  path,
  isClosed,
  targetRegistry
}: {
  path: VertexPath;
  isClosed: boolean;
  targetRegistry: TargetRegistry;
}) {
  const groupRef = useRef<Group>(null);
  useTrackingTarget("cart-rider", groupRef, { name: "Cart Rider", registry: targetRegistry });
  const { step } = usePathCart({
    path,
    speed: CART_RIDER_SPEED,
    mode: isClosed ? EndOfPathInstruction.Loop : EndOfPathInstruction.Stop,
    orientationMode: "path-frame"
  });

  useFrame((_, delta) => {
    if (!groupRef.current) return;
    applyCartFrameToObject(groupRef.current, step(delta));
  });

  return (
    <group ref={groupRef}>
      <mesh>
        <boxGeometry args={[0.16, 0.08, 0.24]} />
        <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={0.15} />
      </mesh>
      <mesh position={[0, 0, 0.16]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.05, 0.1, 12]} />
        <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={0.35} />
      </mesh>
    </group>
  );
}

// Targets are cyan across the demo (look-target ball, buoys).
const TARGET_RIG_BUOYS = [
  { name: "Buoy-A", position: [0.9, 0, 0] as const },
  { name: "Buoy-B", position: [-0.45, 0.35, 0.78] as const },
  { name: "Buoy-C", position: [-0.45, -0.2, -0.78] as const }
];

function TargetRigProp({ targetRegistry }: { targetRegistry: TargetRegistry }) {
  const groupRef = useRef<Group>(null);
  useObjectTargets(groupRef, { pattern: /^Buoy/, idPrefix: "rig" }, targetRegistry);

  useFrame(({ clock }) => {
    groupRef.current?.rotation.set(0, clock.elapsedTime * 0.4, 0);
  });

  return (
    <group ref={groupRef} name="TargetRig" position={[2.4, 0.8, 0]}>
      {TARGET_RIG_BUOYS.map((buoy) => (
        <group key={buoy.name} name={buoy.name} position={buoy.position}>
          <mesh>
            <sphereGeometry args={[0.09, 12, 12]} />
            <meshStandardMaterial color="#06b6d4" emissive="#06b6d4" emissiveIntensity={0.3} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function Scene({
  bezierPath,
  vertexPath,
  pathVersion,
  speed,
  driveMainCamera,
  poseSource,
  aimMode,
  composerSettings,
  debugPreview,
  debugFrustum,
  showCartRider,
  showTargetRig,
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
  virtualCameraCaptureSource,
  virtualCameraActivation,
  virtualCameras,
  selectedVirtualCameraId,
  onVirtualCameraCaptured,
  onVirtualCameraResolved,
  onSelectVirtualCamera,
  onUpdateVirtualCameraSnapshot,
  onUpdateCartOffset,
  targetRegistry,
  dollies,
  vertexPaths,
  activeTimeline,
  timelinePlayerRef
}: {
  bezierPath: BezierPath | null;
  vertexPath: VertexPath | null;
  pathVersion: number;
  speed: number;
  driveMainCamera: boolean;
  poseSource: CameraPoseSource;
  aimMode: CameraAimMode;
  composerSettings: ComposerSettings;
  debugPreview: boolean;
  debugFrustum: boolean;
  showCartRider: boolean;
  showTargetRig: boolean;
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
  virtualCameraCaptureSource: VirtualCameraCaptureSource;
  virtualCameraActivation: VirtualCameraActivation | null;
  virtualCameras: DemoVirtualCamera[];
  selectedVirtualCameraId: string | null;
  onVirtualCameraCaptured: (snapshot: VirtualCameraSnapshot) => void;
  onVirtualCameraResolved: (resolved: VirtualCameraResolved) => void;
  onSelectVirtualCamera: (id: string | null) => void;
  onUpdateVirtualCameraSnapshot: (id: string, snapshot: VirtualCameraSnapshot) => void;
  onUpdateCartOffset: (id: string, offset: Vec3) => void;
  targetRegistry: TargetRegistry;
  dollies: DemoDolly[];
  vertexPaths: Map<string, VertexPath>;
  /** Non-null while the timeline owns the PiP. */
  activeTimeline: Timeline | null;
  timelinePlayerRef: { current: TimelinePlayer };
}) {
  const followMode = bezierPath?.isClosed ? EndOfPathInstruction.Loop : EndOfPathInstruction.Stop;
  const follower = usePathFollower({
    path: vertexPath,
    speed,
    mode: followMode
  });
  useEditorHelpersVisible();
  // One live free-running cart per dolly; the timeline branch overwrites the
  // frames with evaluated ones while it owns playback.
  const liveDollies = useMemo(
    () => new Map(dollies.map((dolly) => [dolly.id, createPathCart({ endOfPathInstruction: dolly.endOfPath })])),
    [dollies]
  );
  const dollyFramesRef = useRef<Map<string, CartFrame>>(new Map());
  const followerRef = useRef<Mesh>(null);
  const lookTargetRef = useRef<Mesh>(null);
  useTrackingTarget("follower", followerRef, { name: "Follower Sphere", registry: targetRegistry });
  useTrackingTarget("look-ball", lookTargetRef, {
    name: "Look Target Ball",
    registry: targetRegistry
  });
  const demoResolveContext = (elapsedSeconds: number): VirtualCameraResolveContext => ({
    getCartFrame: (id) => dollyFramesRef.current.get(id) ?? null,
    getTargetPosition: (id) => targetRegistry.resolve(id),
    elapsedSeconds
  });
  const resolveDemoVirtualCamera = (
    vcam: DemoVirtualCamera,
    elapsedSeconds: number
  ): VirtualCameraSnapshot =>
    resolveVirtualCameraDefinition(toDemoVcamDefinition(vcam), demoResolveContext(elapsedSeconds)) ??
    vcam.snapshot;
  const timelineContext = useMemo<TimelineRigContext>(
    () => ({
      rig: {
        paths: vertexPaths,
        carts: new Map(dollies.map((dolly) => [dolly.id, createPathCart({ speed, endOfPathInstruction: dolly.endOfPath })])),
        cartPaths: new Map(dollies.map((dolly) => [dolly.id, dolly.pathId]))
      },
      vcams: new Map(virtualCameras.map((vcam) => [vcam.id, toDemoVcamDefinition(vcam)])),
      getTargetPosition: (id) => targetRegistry.resolve(id)
    }),
    [speed, targetRegistry, vertexPaths, virtualCameras, dollies]
  );
  const composerState = useRef(createScreenComposerState());
  const previewComposerState = useRef(createScreenComposerState());
  const cameraPositionTarget = useMemo(() => new Vector3(), []);
  const previewCameraPositionTarget = useMemo(() => new Vector3(), []);
  const projectedTarget = useMemo(() => new Vector3(), []);
  const previewCamera = useMemo(() => {
    const camera = new PerspectiveCamera(45, DOLLY_PIP_ASPECT, 0.1, 100);
    camera.name = "dolly-preview-camera";
    camera.updateProjectionMatrix();
    return camera;
  }, []);
  const brainCamera = useMemo(() => {
    const camera = new PerspectiveCamera(45, DOLLY_PIP_ASPECT, 0.1, 100);
    camera.name = "virtual-camera-brain";
    camera.updateProjectionMatrix();
    return camera;
  }, []);
  const selectedVirtualCamera = selectedVirtualCameraId
    ? virtualCameras.find((camera) => camera.id === selectedVirtualCameraId) ?? null
    : null;
  const pipCamera =
    activeTimeline || virtualCameraActivation || selectedVirtualCamera
      ? brainCamera
      : previewCamera;
  // The rig preview (previewCamera) only has a source while an editable path
  // drives the follower. With no timeline/shot/selection and no path, nothing
  // feeds the PiP — the frustum hides and the PiP reads "no output".
  const hasPipSource = Boolean(
    activeTimeline || virtualCameraActivation || selectedVirtualCamera || vertexPath
  );
  // The frustum visualizes whichever camera feeds the PiP (rig, shot brain,
  // or timeline), not just the rig preview — tinted to match the vcam glyph
  // state colors (green live, orange selected, slate rig).
  const frustumHelper = useMemo(() => new CameraHelper(pipCamera), [pipCamera]);
  const frustumColor =
    activeTimeline || virtualCameraActivation
      ? "#22c55e"
      : selectedVirtualCamera
        ? "#f97316"
        : "#64748b";
  useEffect(() => {
    const color = new Color(frustumColor);
    frustumHelper.setColors(color, color, color, color, color);
  }, [frustumHelper, frustumColor]);

  const pathLinePoints = useMemo(
    () => (vertexPath ? buildPathLinePoints(vertexPath) : []),
    [vertexPath, pathVersion]
  );
  const controlLinePositions = useMemo(
    () => (bezierPath ? buildControlLinePositions(bezierPath) : new Float32Array()),
    [bezierPath, pathVersion]
  );
  const midpointData = useMemo(() => {
    if (!bezierPath || !vertexPath) return [];
    return Array.from({ length: bezierPath.numSegments }).map((_, segmentIndex) => {
      const midpoint = bezierPath.evaluate(segmentIndex, 0.5);
      const frame = getMidpointFrame(vertexPath, midpoint);
      return {
        segmentIndex,
        midpoint,
        normal: frame.normal,
        tangent: frame.tangent,
        rotation: frame.rotation,
        normalQuat: quatFromNormal(frame.normal)
      };
    });
  }, [bezierPath, vertexPath, pathVersion]);
  const midpointNormalPositions = useMemo(() => {
    const values: number[] = [];
    for (const m of midpointData) {
      const center = new Vector3(m.midpoint.x, m.midpoint.y, m.midpoint.z);
      const a = center.clone().add(m.normal.clone().multiplyScalar(0.24));
      const b = center.clone().add(m.normal.clone().multiplyScalar(-0.24));
      values.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    return new Float32Array(values);
  }, [midpointData]);
  const selectedMidpoint =
    selectedMidpointIndex !== null ? midpointData[selectedMidpointIndex] ?? null : null;
  const selectedHandlePoint =
    selectedHandleIndex !== null && bezierPath ? bezierPath.getPoint(selectedHandleIndex) : null;
  const selectedHandleIsAnchor = selectedHandleIndex !== null && selectedHandleIndex % 3 === 0;
  const selectedAnchorScale =
    selectedHandleIsAnchor && selectedHandleIndex !== null
      ? anchorScales[Math.floor(selectedHandleIndex / 3)] ?? 1
      : 1;
  const handlePivotMatrix = useMemo(() => new Matrix4(), []);
  const [handleGizmoRotation, setHandleGizmoRotation] = useState<[number, number, number]>([0, 0, 0]);
  const anchorDragStartRef = useRef<{
    anchorIndex: number;
    anchorStart: Vec3;
    controlStarts: Array<{ index: number; point: Vec3 }>;
  } | null>(null);
  const lastCaptureRequestRef = useRef(virtualCameraCaptureRequest);
  const activeVirtualCameraKeyRef = useRef<number | null>(null);
  const resolvedVirtualCameraKeyRef = useRef<number | null>(null);
  const virtualCameraBrainRef = useRef(createVirtualCameraBrainState());
  const { gl } = useThree();

  useEffect(() => {
    const onContextMenu = (e: Event) => e.preventDefault();
    gl.domElement.addEventListener("contextmenu", onContextMenu);
    return () => gl.domElement.removeEventListener("contextmenu", onContextMenu);
  }, [gl.domElement]);

  useEffect(() => {
    return () => frustumHelper.dispose();
  }, [frustumHelper]);

  useEffect(() => {
    composerState.current = createScreenComposerState();
    previewComposerState.current = createScreenComposerState();
  }, [
    aimMode,
    poseSource,
    composerSettings.centerOnActivate,
    composerSettings.screenX,
    composerSettings.screenY
  ]);

  useEffect(() => {
    if (!selectedHandlePoint || isTransforming) return;
    handlePivotMatrix.compose(
      new Vector3(selectedHandlePoint.x, selectedHandlePoint.y, selectedHandlePoint.z),
      new Quaternion(),
      new Vector3(selectedAnchorScale, selectedAnchorScale, selectedAnchorScale)
    );
  }, [handlePivotMatrix, isTransforming, selectedAnchorScale, selectedHandlePoint]);
  useEffect(() => {
    if (isTransforming) return;
    if (useWorldSpaceGizmo || selectedHandleIndex === null || !bezierPath || !vertexPath) {
      setHandleGizmoRotation([0, 0, 0]);
      return;
    }
    const anchorPointIndex = getAnchorPointIndexForHandle(bezierPath, selectedHandleIndex);
    const anchorPoint = bezierPath.getPoint(anchorPointIndex);
    const [qx, qy, qz, qw] = getSurfaceAlignedQuaternion(vertexPath, anchorPoint);
    const euler = new Euler().setFromQuaternion(new Quaternion(qx, qy, qz, qw), "XYZ");
    setHandleGizmoRotation([euler.x, euler.y, euler.z]);
  }, [bezierPath, isTransforming, selectedHandleIndex, useWorldSpaceGizmo, vertexPath]);

  useFrame(({ camera, scene }, delta) => {
    for (const dolly of dollies) {
      const cart = liveDollies.get(dolly.id);
      const dollyPath = vertexPaths.get(dolly.pathId);
      if (!cart || !dollyPath) continue;
      cart.speed = speed;
      cart.distance = advanceCartDistance(dollyPath, cart, delta);
      dollyFramesRef.current.set(dolly.id, sampleCartFrame(dollyPath, cart));
    }
    const mainCamera = camera as PerspectiveCamera;
    const elapsed = performance.now() / 1000;

    // The follower, look target, and rig-preview camera all sample the editable
    // path; the composer demo only runs while one is open. sample/aimTarget stay
    // null otherwise so the "drive main camera from rig" branch below no-ops.
    let sample: ReturnType<typeof follower.step> | null = null;
    let aimTarget: Vec3 | null = null;
    if (vertexPath) {
      const followerObject = scene.getObjectByName("follower") as Mesh | null;
      const lookTargetObject = scene.getObjectByName("look-target") as Mesh | null;
      sample = follower.step(delta);
      const lookSample = samplePathAtDistance(
        vertexPath,
        follower.state.current.distance + composerSettings.pathLookaheadDistance,
        followMode
      );
      const tangent = new Vector3(
        lookSample.direction.x,
        lookSample.direction.y,
        lookSample.direction.z
      ).normalize();
      const normal = new Vector3(lookSample.normal.x, lookSample.normal.y, lookSample.normal.z).normalize();
      const side = new Vector3().crossVectors(tangent, normal).normalize();
      const lookTarget = {
        x: lookSample.position.x + side.x * Math.sin(elapsed * 0.85) * 0.75 + normal.x * Math.sin(elapsed * 1.7) * 0.35,
        y: lookSample.position.y + side.y * Math.sin(elapsed * 0.85) * 0.75 + normal.y * Math.sin(elapsed * 1.7) * 0.35,
        z: lookSample.position.z + side.z * Math.sin(elapsed * 0.85) * 0.75 + normal.z * Math.sin(elapsed * 1.7) * 0.35
      };
      const pathLookTarget = getPathLookTarget(sample.position, lookSample.position, lookTarget);
      const weightedTarget = getWeightedTarget(pathLookTarget, lookTarget, composerSettings);
      aimTarget = aimMode === "look-at-target" || aimMode === "screen-composer"
        ? weightedTarget
        : pathLookTarget;

      if (followerObject) {
        applySampleToObject(followerObject, sample);
      }

      if (lookTargetObject) {
        lookTargetObject.position.set(lookTarget.x, lookTarget.y, lookTarget.z);
      }

      applyCameraPose(previewCamera, poseSource, sample.position, previewCameraPositionTarget, delta);
      applyCameraAim(
        previewCamera,
        aimMode,
        aimTarget,
        sample.normal,
        composerSettings,
        previewComposerState.current,
        delta
      );
      previewCamera.updateMatrixWorld();

      projectedTarget.set(aimTarget.x, aimTarget.y, aimTarget.z).project(pipCamera);
      updateDollyTargetOverlay(
        dollyTargetMarkerRef.current,
        dollyTargetLineRef.current,
        (projectedTarget.x + 1) * 0.5,
        (1 - projectedTarget.y) * 0.5,
        projectedTarget.z >= -1 &&
          projectedTarget.z <= 1 &&
          projectedTarget.x >= -1 &&
          projectedTarget.x <= 1 &&
          projectedTarget.y >= -1 &&
          projectedTarget.y <= 1
      );
      const lookaheadTarget = getComposerLookaheadTarget(
        aimTarget,
        composerSettings,
        previewComposerState.current.smoothedVelocity
      );
      projectedTarget.set(lookaheadTarget.x, lookaheadTarget.y, lookaheadTarget.z).project(pipCamera);
      updateDollyTargetOverlay(
        lookaheadMarkerRef.current,
        lookaheadLineRef.current,
        (projectedTarget.x + 1) * 0.5,
        (1 - projectedTarget.y) * 0.5,
        aimMode === "screen-composer" &&
          composerSettings.lookaheadTime > 0 &&
          projectedTarget.z >= -1 &&
          projectedTarget.z <= 1 &&
          projectedTarget.x >= -1 &&
          projectedTarget.x <= 1 &&
          projectedTarget.y >= -1 &&
          projectedTarget.y <= 1,
        "lookahead"
      );
    } else {
      // No editable path: park the composer overlay markers out of sight.
      updateDollyTargetOverlay(dollyTargetMarkerRef.current, dollyTargetLineRef.current, 0.5, 0.5, false);
      updateDollyTargetOverlay(lookaheadMarkerRef.current, lookaheadLineRef.current, 0.5, 0.5, false, "lookahead");
    }

    frustumHelper.update();

    if (virtualCameraCaptureRequest !== lastCaptureRequestRef.current) {
      lastCaptureRequestRef.current = virtualCameraCaptureRequest;
      const sourceCamera =
        virtualCameraCaptureSource === "viewport" ? mainCamera : previewCamera;
      onVirtualCameraCaptured(
        captureVirtualCameraSnapshot(sourceCamera, {
          settings: composerSettingsToVirtualCameraSettings(composerSettings)
        })
      );
    }

    if (activeTimeline) {
      stepTimelinePlayer(timelinePlayerRef.current, activeTimeline, delta);
      const sample = evaluateTimeline(
        activeTimeline,
        timelineContext,
        timelinePlayerRef.current.time
      );
      if (sample.camera) {
        applyVirtualCameraSnapshot(brainCamera, sample.camera);
      } else {
        // Released gap (Cinemachine semantics): the live rig camera takes over.
        brainCamera.position.copy(previewCamera.position);
        brainCamera.quaternion.copy(previewCamera.quaternion);
      }
      // Glyphs and shot previews follow the timeline-evaluated carts, not
      // the free-running ones, while the timeline owns playback.
      for (const [dollyId, frame] of sample.cartFrames) {
        dollyFramesRef.current.set(dollyId, frame);
      }
      activeVirtualCameraKeyRef.current = null;
      resolvedVirtualCameraKeyRef.current = null;
    } else if (virtualCameraActivation && !isTransforming) {
      const liveVcam = virtualCameras.find((item) => item.id === virtualCameraActivation.toId);
      if (liveVcam) {
        if (activeVirtualCameraKeyRef.current !== virtualCameraActivation.key) {
          activeVirtualCameraKeyRef.current = virtualCameraActivation.key;
          resolvedVirtualCameraKeyRef.current = null;
          composerState.current = createScreenComposerState();
          activateVirtualCameraBrain(
            virtualCameraBrainRef.current,
            resolveDemoVirtualCamera(liveVcam, elapsed),
            {
              durationSeconds: virtualCameraActivation.durationSeconds,
              curve: virtualCameraActivation.curve
            }
          );
        }

        const resolvedSnapshot = driveVirtualCameraBrain(
          brainCamera,
          virtualCameraBrainRef.current,
          toDemoVcamDefinition(liveVcam),
          demoResolveContext(elapsed),
          delta
        );
        if (resolvedSnapshot) {
          const done = !virtualCameraBrainRef.current.isBlending;
          const progress = getVirtualCameraBrainProgress(virtualCameraBrainRef.current);
          if (!done || resolvedVirtualCameraKeyRef.current !== virtualCameraActivation.key) {
            onVirtualCameraResolved({
              snapshot: resolvedSnapshot,
              progress,
              done
            });
            if (done) {
              resolvedVirtualCameraKeyRef.current = virtualCameraActivation.key;
            }
          }
        }
      }
    } else if (selectedVirtualCamera) {
      activeVirtualCameraKeyRef.current = null;
      resolvedVirtualCameraKeyRef.current = null;
      virtualCameraBrainRef.current = createVirtualCameraBrainState(
        resolveDemoVirtualCamera(selectedVirtualCamera, elapsed)
      );
      applyVirtualCameraBrain(brainCamera, virtualCameraBrainRef.current, 0);
    } else if (driveMainCamera && !isTransforming && sample && aimTarget) {
      activeVirtualCameraKeyRef.current = null;
      resolvedVirtualCameraKeyRef.current = null;
      virtualCameraBrainRef.current = createVirtualCameraBrainState();
      applyCameraPose(mainCamera, poseSource, sample.position, cameraPositionTarget, delta);
      applyCameraAim(
        mainCamera,
        aimMode,
        aimTarget,
        sample.normal,
        composerSettings,
        composerState.current,
        delta
      );
    } else {
      activeVirtualCameraKeyRef.current = null;
      resolvedVirtualCameraKeyRef.current = null;
      virtualCameraBrainRef.current = createVirtualCameraBrainState();
      composerState.current = createScreenComposerState();
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 4]} intensity={1.2} />

      <EditorHelpers>
      {vertexPath ? <Line points={pathLinePoints} color="#101828" lineWidth={4} /> : null}
      {[...vertexPaths.entries()]
        .filter(([, path]) => path !== vertexPath)
        .map(([pathId, path]) => (
          <Line
            key={pathId}
            points={buildPathLinePoints(path)}
            color="#475569"
            lineWidth={2}
            dashed
            dashSize={0.08}
            gapSize={0.05}
          />
        ))}

      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[controlLinePositions, 3]}
            count={controlLinePositions.length / 3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#8b8f97" />
      </lineSegments>

      <lineSegments>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[midpointNormalPositions, 3]}
            count={midpointNormalPositions.length / 3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#06b6d4" />
      </lineSegments>

      {midpointData.map((m) => {
        return (
          <group
            key={`midpoint-${m.segmentIndex}`}
            position={[m.midpoint.x, m.midpoint.y, m.midpoint.z]}
            quaternion={m.normalQuat}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelectMidpoint(m.segmentIndex);
            }}
          >
            <mesh>
              <sphereGeometry args={[0.035, 8, 8]} />
              <meshBasicMaterial transparent opacity={0} depthWrite={false} />
            </mesh>
          </group>
        );
      })}

      {selectedMidpoint ? (
        <PivotControls
          fixed
          scale={65}
          lineWidth={2}
          depthTest={false}
          disableAxes
          disableSliders
          disableScaling
          anchor={[0, 0, 0]}
          offset={[
            selectedMidpoint.midpoint.x,
            selectedMidpoint.midpoint.y,
            selectedMidpoint.midpoint.z
          ]}
          rotation={selectedMidpoint.rotation}
          onDragStart={() => onTransformingChange(true)}
          onDragEnd={() => onTransformingChange(false)}
          onDrag={(_, deltaL) => {
            const deltaQuat = new Quaternion().setFromRotationMatrix(deltaL);
            const clampedW = Math.max(-1, Math.min(1, deltaQuat.w));
            const angle = 2 * Math.acos(clampedW);
            if (!Number.isFinite(angle) || angle < 1e-4) return;

            const axisDenom = Math.sqrt(1 - clampedW * clampedW);
            if (axisDenom < 1e-4) return;
            const axis = new Vector3(
              deltaQuat.x / axisDenom,
              deltaQuat.y / axisDenom,
              deltaQuat.z / axisDenom
            ).normalize();

            const tangent = selectedMidpoint.tangent.clone().normalize();
            const sign = Math.sign(axis.dot(tangent)) || 1;
            const deltaDegrees = (angle * 180) / Math.PI * sign;
            onRotateMidpointNormal(selectedMidpoint.segmentIndex, deltaDegrees);
          }}
        >
          <mesh>
            <sphereGeometry args={[0.001, 4, 4]} />
            <meshBasicMaterial transparent opacity={0} />
          </mesh>
        </PivotControls>
      ) : null}

      {bezierPath &&
        Array.from({ length: bezierPath.numPoints }).map((_, i) => {
        if (!bezierPath || !vertexPath) return null;
        const p = bezierPath.getPoint(i);
        const isAnchor = i % 3 === 0;
        const draggable = isAnchor || bezierPath.controlMode !== ControlMode.Automatic;
        const isSelected = selectedHandleIndex === i;
        const color = isAnchor ? "#f97316" : "#2563eb";
        const surfaceQuat = getSurfaceAlignedQuaternion(vertexPath, p);
        const anchorIndex = Math.floor(i / 3);
        const anchorScale = isAnchor ? anchorScales[anchorIndex] ?? 1 : 1;
        const anchorScaleVisual = Math.max(0.65, Math.sqrt(anchorScale));

        if (!isAnchor) {
          return (
            <Billboard
              key={`handle-${i}`}
              position={[p.x, p.y, p.z]}
              onPointerDown={(e) => {
                if (!draggable) return;
                e.stopPropagation();
                onSelectHandle(i);
              }}
            >
              <mesh>
                <circleGeometry args={[isSelected ? 0.07 : 0.058, 24]} />
                <meshBasicMaterial
                  color={color}
                  transparent={!draggable}
                  opacity={draggable ? 1 : 0.4}
                  depthTest={false}
                />
              </mesh>
              {isSelected ? (
                <mesh position={[0, 0, -0.001]}>
                  <ringGeometry args={[0.074, 0.088, 24]} />
                  <meshBasicMaterial color="#ffffff" opacity={0.9} transparent depthTest={false} />
                </mesh>
              ) : null}
            </Billboard>
          );
        }

        if (!draggable) {
          return (
            <group key={`handle-${i}`} position={[p.x, p.y, p.z]} quaternion={surfaceQuat}>
              <mesh>
                <ringGeometry args={[isAnchor ? 0.085 : 0.065, isAnchor ? 0.11 : 0.085, 28]} />
                <meshBasicMaterial color={color} opacity={0.35} transparent side={2} />
              </mesh>
              {isAnchor ? (
                <mesh position={[0, 0, -0.001]}>
                  <ringGeometry
                    args={[
                      0.13 * anchorScaleVisual,
                      0.145 * anchorScaleVisual,
                      36
                    ]}
                  />
                  <meshBasicMaterial color="#f97316" transparent opacity={0.55} side={2} />
                </mesh>
              ) : null}
              {isAnchor ? (
                <Text
                  position={[0, 0, 0.002]}
                  fontSize={0.09}
                  color="#f97316"
                  anchorX="center"
                  anchorY="middle"
                  renderOrder={999}
                  material-depthTest={false}
                  material-depthWrite={false}
                >
                  {String(Math.floor(i / 3) + 1)}
                </Text>
              ) : null}
            </group>
          );
        }

        return (
          <group
            key={`handle-${i}`}
            position={[p.x, p.y, p.z]}
            quaternion={surfaceQuat}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelectHandle(i);
            }}
          >
            <mesh>
              <ringGeometry
                args={[
                  isSelected ? (isAnchor ? 0.095 : 0.075) : isAnchor ? 0.085 : 0.065,
                  isSelected ? (isAnchor ? 0.125 : 0.1) : isAnchor ? 0.11 : 0.085,
                  28
                ]}
              />
              <meshBasicMaterial color={color} side={2} />
            </mesh>
            {isAnchor ? (
              <mesh position={[0, 0, -0.001]}>
                <ringGeometry
                  args={[
                    0.13 * anchorScaleVisual,
                    0.145 * anchorScaleVisual,
                    36
                  ]}
                />
                <meshBasicMaterial color="#f97316" transparent opacity={0.65} side={2} />
              </mesh>
            ) : null}
            <mesh
              onPointerDown={(e) => {
                e.stopPropagation();
                onSelectHandle(i);
              }}
            >
              <circleGeometry args={[isAnchor ? 0.09 : 0.07, 24]} />
              <meshBasicMaterial
                color="#ffffff"
                transparent
                opacity={0.001}
                side={2}
                depthWrite={false}
                depthTest={false}
              />
            </mesh>
            {isAnchor ? (
              <Text
                position={[0, 0, 0.002]}
                fontSize={0.09}
                color="#f97316"
                anchorX="center"
                anchorY="middle"
                renderOrder={999}
                material-depthTest={false}
                material-depthWrite={false}
              >
                {String(Math.floor(i / 3) + 1)}
              </Text>
            ) : null}
            {isSelected ? (
              <mesh position={[0, 0, -0.001]}>
                <ringGeometry
                  args={[
                    isAnchor ? 0.13 : 0.105,
                    isAnchor ? 0.155 : 0.13,
                    28
                  ]}
                />
                <meshBasicMaterial color="#ffffff" opacity={0.9} transparent side={2} />
              </mesh>
            ) : null}
          </group>
        );
      })}

      {selectedHandleIndex !== null && selectedHandlePoint ? (
        <PivotControls
          matrix={handlePivotMatrix}
          autoTransform={false}
          fixed
          scale={65}
          lineWidth={2}
          depthTest={false}
          disableRotations={!selectedHandleIsAnchor}
          disableScaling={!selectedHandleIsAnchor}
          anchor={[0, 0, 0]}
          rotation={handleGizmoRotation}
          onDragStart={() => {
            if (bezierPath && selectedHandleIsAnchor && bezierPath.controlMode !== ControlMode.Automatic) {
              const controlStarts: Array<{ index: number; point: Vec3 }> = [];
              const prevControlIndex = bezierPath.isClosed
                ? (selectedHandleIndex - 1 + bezierPath.numPoints) % bezierPath.numPoints
                : selectedHandleIndex - 1;
              const nextControlIndex = bezierPath.isClosed
                ? (selectedHandleIndex + 1) % bezierPath.numPoints
                : selectedHandleIndex + 1;

              if (prevControlIndex >= 0 && prevControlIndex < bezierPath.numPoints && prevControlIndex % 3 !== 0) {
                const p = bezierPath.getPoint(prevControlIndex);
                controlStarts.push({ index: prevControlIndex, point: { x: p.x, y: p.y, z: p.z } });
              }
              if (nextControlIndex >= 0 && nextControlIndex < bezierPath.numPoints && nextControlIndex % 3 !== 0) {
                const p = bezierPath.getPoint(nextControlIndex);
                controlStarts.push({ index: nextControlIndex, point: { x: p.x, y: p.y, z: p.z } });
              }

              const a = bezierPath.getPoint(selectedHandleIndex);
              anchorDragStartRef.current = {
                anchorIndex: selectedHandleIndex,
                anchorStart: { x: a.x, y: a.y, z: a.z },
                controlStarts
              };
            } else {
              anchorDragStartRef.current = null;
            }

            onTransformingChange(true);
          }}
          onDragEnd={() => {
            anchorDragStartRef.current = null;
            onTransformingChange(false);
          }}
          onDrag={(l, deltaL) => {
            handlePivotMatrix.copy(l);
            const position = new Vector3();
            const dq = new Quaternion();
            const ds = new Vector3();
            l.decompose(position, dq, ds);

            onMovePoint(selectedHandleIndex, {
              x: position.x,
              y: position.y,
              z: position.z
            });

            if (selectedHandleIsAnchor) {
              const uniformScale = Math.max(0.05, (ds.x + ds.y + ds.z) / 3);
              onSetAnchorScale(Math.floor(selectedHandleIndex / 3), uniformScale);
            }

            const dragState = anchorDragStartRef.current;
            if (
              !dragState ||
              !selectedHandleIsAnchor ||
              dragState.anchorIndex !== selectedHandleIndex
            ) {
              return;
            }

            const deltaQuat = new Quaternion().setFromRotationMatrix(deltaL);
            const translation = new Vector3(
              position.x - dragState.anchorStart.x,
              position.y - dragState.anchorStart.y,
              position.z - dragState.anchorStart.z
            );

            for (const c of dragState.controlStarts) {
              const offset = new Vector3(
                c.point.x - dragState.anchorStart.x,
                c.point.y - dragState.anchorStart.y,
                c.point.z - dragState.anchorStart.z
              ).applyQuaternion(deltaQuat);

              onMovePoint(c.index, {
                x: dragState.anchorStart.x + offset.x + translation.x,
                y: dragState.anchorStart.y + offset.y + translation.y,
                z: dragState.anchorStart.z + offset.z + translation.z
              });
            }
          }}
        >
          <mesh>
            <sphereGeometry args={[0.001, 4, 4]} />
            <meshBasicMaterial transparent opacity={0} />
          </mesh>
        </PivotControls>
      ) : null}

      <mesh
        position={[0, 0, 0]}
        onPointerDown={() => {
          onSelectHandle(null);
          onSelectMidpoint(null);
          onSelectVirtualCamera(null);
        }}
      >
        <sphereGeometry args={[0.0001, 4, 4]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      </EditorHelpers>

      {vertexPath ? (
        <>
          <mesh name="follower" ref={followerRef}>
            <sphereGeometry args={[0.13, 16, 16]} />
            <meshStandardMaterial color="#3b82f6" emissive="#3b82f6" emissiveIntensity={0.15} />
          </mesh>

          <mesh name="look-target" ref={lookTargetRef}>
            <sphereGeometry args={[0.1, 16, 16]} />
            <meshStandardMaterial color="#06b6d4" emissive="#083344" emissiveIntensity={0.45} />
          </mesh>
        </>
      ) : null}

      <EditorHelpers>
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

      {showCartRider && vertexPath && bezierPath ? (
        <CartRiderProp
          path={vertexPath}
          isClosed={bezierPath.isClosed}
          targetRegistry={targetRegistry}
        />
      ) : null}

      {showTargetRig ? <TargetRigProp targetRegistry={targetRegistry} /> : null}

      {debugPreview ? (
        <DollyCameraPip camera={pipCamera} frustumHelper={frustumHelper} hasSource={hasPipSource} />
      ) : null}
    </>
  );
}

const PIP_NO_SIGNAL_COLOR = new Color("#0a101c");
const _pipClearScratch = new Color();

function DollyCameraPip({
  camera: dollyCamera,
  frustumHelper,
  hasSource
}: {
  camera: PerspectiveCamera;
  frustumHelper: CameraHelper;
  hasSource: boolean;
}) {
  const { gl, scene, size } = useThree();

  useFrame(({ camera }) => {
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
    gl.render(scene, camera);

    const width = Math.min(360, Math.max(220, size.width * 0.28));
    const height = width / DOLLY_PIP_ASPECT;
    const x = Math.max(DOLLY_PIP_MARGIN, size.width - width - DOLLY_PIP_MARGIN);
    const y = DOLLY_PIP_MARGIN;

    gl.clearDepth();
    gl.setScissorTest(true);
    gl.setScissor(x, y, width, height);
    gl.setViewport(x, y, width, height);
    if (hasSource) {
      frustumHelper.visible = false;
      gl.render(scene, dollyCamera);
      frustumHelper.visible = true;
    } else {
      // No camera drives the PiP: paint a dark "no signal" panel instead of a
      // view from an undriven camera.
      const prevColor = gl.getClearColor(_pipClearScratch);
      const prevAlpha = gl.getClearAlpha();
      gl.setClearColor(PIP_NO_SIGNAL_COLOR, 1);
      gl.clear(true, true, false);
      gl.setClearColor(prevColor, prevAlpha);
    }
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
  }, 1);

  return null;
}

function CartVcamGlyphRig({
  framesRef,
  cartId,
  selected,
  offset,
  onOffsetChange,
  onTransformingChange,
  children
}: {
  framesRef: { current: Map<string, CartFrame> };
  cartId: string;
  selected: boolean;
  offset: Vec3;
  onOffsetChange: (offset: Vec3) => void;
  onTransformingChange: (isTransforming: boolean) => void;
  children: ReactNode;
}) {
  const groupRef = useRef<Group>(null);
  const offsetMatrix = useMemo(
    () => new Matrix4().makeTranslation(offset.x, offset.y, offset.z),
    [offset.x, offset.y, offset.z]
  );

  // The rig group sits ON the rail with the cart's frame basis as its local
  // axes (x=right, y=up, z=forward), so the pivot's local translation IS the
  // rail-local offset the cart body applies.
  useFrame(() => {
    const frame = framesRef.current.get(cartId) ?? null;
    const group = groupRef.current;
    if (!frame || !group) return;
    applyCartFrameToObject(group, frame);
    group.position.set(frame.railPosition.x, frame.railPosition.y, frame.railPosition.z);
  });

  // Camera glyphs face -Z; the frame's forward is local +Z here.
  const glyph = <group rotation={[0, Math.PI, 0]}>{children}</group>;

  return (
    <group ref={groupRef}>
      {selected ? (
        <PivotControls
          {...VCAM_PIVOT_PROPS}
          matrix={offsetMatrix}
          disableRotations
          disableScaling
          onDragStart={() => onTransformingChange(true)}
          onDragEnd={() => onTransformingChange(false)}
          onDrag={(matrix) => {
            onOffsetChange({
              x: matrix.elements[12],
              y: matrix.elements[13],
              z: matrix.elements[14]
            });
          }}
        >
          {glyph}
        </PivotControls>
      ) : (
        <group position={[offset.x, offset.y, offset.z]}>{glyph}</group>
      )}
    </group>
  );
}

function VirtualCameraGlyph({
  name,
  selected,
  active,
  onSelect
}: {
  name: string;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  // One hue per state: green = live, orange = selected, slate = idle.
  const color = active ? "#22c55e" : selected ? "#f97316" : "#64748b";
  const emissiveIntensity = active ? 0.4 : selected ? 0.3 : 0.12;

  return (
    <group
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <mesh>
        <boxGeometry args={[0.18, 0.12, 0.1]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissiveIntensity} />
      </mesh>
      <mesh position={[0, 0, -0.16]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.08, 0.18, 4]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissiveIntensity} />
      </mesh>
      <Line
        points={[
          [-0.16, -0.1, -0.34],
          [0.16, -0.1, -0.34],
          [0.16, 0.1, -0.34],
          [-0.16, 0.1, -0.34],
          [-0.16, -0.1, -0.34]
        ]}
        color={color}
        lineWidth={1.5}
      />
      <Text
        position={[0, 0.18, 0]}
        fontSize={0.08}
        color={color}
        anchorX="center"
        anchorY="middle"
        renderOrder={999}
        material-depthTest={false}
        material-depthWrite={false}
      >
        {name}
      </Text>
    </group>
  );
}

function DollyPreviewChrome({
  composerActive,
  composerSettings,
  label,
  hasSource,
  targetMarkerRef,
  targetLineRef,
  lookaheadMarkerRef,
  lookaheadLineRef
}: {
  composerActive: boolean;
  composerSettings: ComposerSettings;
  label: string;
  hasSource: boolean;
  targetMarkerRef: { current: HTMLDivElement | null };
  targetLineRef: { current: SVGLineElement | null };
  lookaheadMarkerRef: { current: HTMLDivElement | null };
  lookaheadLineRef: { current: SVGLineElement | null };
}) {
  const zones = getComposerZones(composerSettings);

  // No driving camera: just the framed panel + label; the composer zone/target
  // overlays would be meaningless without a source.
  if (!hasSource) {
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
          border: "2px solid rgba(148, 163, 184, 0.35)",
          boxShadow: "0 18px 44px rgba(15, 23, 42, 0.28)",
          background: "rgba(10, 16, 28, 0.55)",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        }}
      >
        <div style={{ color: "#64748b", fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>
          {label}
        </div>
      </div>
    );
  }

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
        border: "2px solid rgba(248, 250, 252, 0.92)",
        boxShadow: "0 18px 44px rgba(15, 23, 42, 0.28)",
        background: "rgba(15, 23, 42, 0.2)",
        boxSizing: "border-box"
      }}
    >
      <DollyPipZone
        width={zones.hardLimits.width}
        height={zones.hardLimits.height}
        centerX={composerSettings.screenX}
        centerY={composerSettings.screenY}
        color="rgba(248, 250, 252, 0.54)"
        fill="rgba(248, 250, 252, 0.02)"
      />
      <DollyPipZone
        width={zones.softZone.width}
        height={zones.softZone.height}
        centerX={composerSettings.screenX}
        centerY={composerSettings.screenY}
        color={composerActive ? "rgba(6, 182, 212, 0.78)" : "rgba(6, 182, 212, 0.38)"}
        fill="rgba(6, 182, 212, 0.035)"
      />
      <DollyPipZone
        width={zones.deadZone.width}
        height={zones.deadZone.height}
        centerX={composerSettings.screenX}
        centerY={composerSettings.screenY}
        color={composerActive ? "rgba(249, 115, 22, 0.92)" : "rgba(249, 115, 22, 0.44)"}
        fill="rgba(249, 115, 22, 0.04)"
      />
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          overflow: "visible"
        }}
      >
        <line
          ref={targetLineRef}
          x1="50"
          y1="50"
          x2="50"
          y2="50"
          stroke="rgba(6, 182, 212, 0.72)"
          strokeWidth="0.55"
          vectorEffect="non-scaling-stroke"
        />
        <line
          ref={lookaheadLineRef}
          x1="50"
          y1="50"
          x2="50"
          y2="50"
          stroke="rgba(250, 204, 21, 0)"
          strokeWidth="0.55"
          strokeDasharray="3 2"
          vectorEffect="non-scaling-stroke"
        />
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
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 8,
          padding: "3px 7px",
          borderRadius: 4,
          background: "rgba(15, 23, 42, 0.72)",
          color: "#f8fafc",
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: 0,
          fontFamily: "ui-sans-serif, system-ui, sans-serif"
        }}
      >
        {label}
      </div>
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

function ComposerGuides({ settings }: { settings: ComposerSettings }) {
  const zones = getComposerZones(settings);
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 8,
        pointerEvents: "none"
      }}
    >
      <ComposerGuideBox
        width={zones.hardLimits.width}
        height={zones.hardLimits.height}
        centerX={settings.screenX}
        centerY={settings.screenY}
        color="rgba(15, 23, 42, 0.45)"
      />
      <ComposerGuideBox
        width={zones.softZone.width}
        height={zones.softZone.height}
        centerX={settings.screenX}
        centerY={settings.screenY}
        color="rgba(6, 182, 212, 0.55)"
      />
      <ComposerGuideBox
        width={zones.deadZone.width}
        height={zones.deadZone.height}
        centerX={settings.screenX}
        centerY={settings.screenY}
        color="rgba(249, 115, 22, 0.8)"
      />
    </div>
  );
}

function ComposerGuideBox({
  width,
  height,
  centerX,
  centerY,
  color
}: {
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  color: string;
}) {
  return (
    <div
      style={{
        position: "absolute",
        left: `${50 + centerX * 100}vw`,
        top: `${50 - centerY * 100}vh`,
        width: `${width * 100}vw`,
        height: `${height * 100}vh`,
        transform: "translate(-50%, -50%)",
        border: `2px solid ${color}`,
        boxSizing: "border-box"
      }}
    />
  );
}

function RigSettingsPanel({
  settings,
  onChange,
  onClose,
  onReset
}: {
  settings: ComposerSettings;
  onChange: (next: ComposerSettings) => void;
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
        padding: 12,
        borderRadius: 8,
        background: "rgba(10, 16, 28, 0.92)",
        color: "#f8fafc",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        boxShadow: "0 24px 60px rgba(15, 23, 42, 0.35)",
        border: "1px solid rgba(148, 163, 184, 0.22)"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800 }}>Composer Settings</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>Rotation Composer</div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onReset}>Reset</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>

      <SettingsSection title="Targets">
        <NumberSlider
          label="Path Lookahead"
          value={settings.pathLookaheadDistance}
          min={0}
          max={3}
          step={0.05}
          unit="m"
          onChange={(value) => setValue("pathLookaheadDistance", value)}
        />
        <NumberSlider
          label="Target Weight"
          value={settings.targetWeight}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setValue("targetWeight", value)}
        />
        <NumberSlider
          label="Tracked Offset X"
          value={settings.targetOffsetX}
          min={-2}
          max={2}
          step={0.05}
          onChange={(value) => setValue("targetOffsetX", value)}
        />
        <NumberSlider
          label="Tracked Offset Y"
          value={settings.targetOffsetY}
          min={-2}
          max={2}
          step={0.05}
          onChange={(value) => setValue("targetOffsetY", value)}
        />
        <NumberSlider
          label="Tracked Offset Z"
          value={settings.targetOffsetZ}
          min={-2}
          max={2}
          step={0.05}
          onChange={(value) => setValue("targetOffsetZ", value)}
        />
      </SettingsSection>

      <SettingsSection title="Screen">
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={() => onChange({ ...settings, screenX: 0, screenY: 0 })}
            style={{ flex: 1 }}
          >
            Center Screen
          </button>
          <button
            onClick={() => setValue("centerOnActivate", !settings.centerOnActivate)}
            style={{ flex: 1 }}
          >
            {settings.centerOnActivate ? "Center On Activate: On" : "Center On Activate: Off"}
          </button>
        </div>
        <NumberSlider
          label="Screen X"
          value={settings.screenX}
          min={-0.4}
          max={0.4}
          step={0.01}
          onChange={(value) => setValue("screenX", value)}
        />
        <NumberSlider
          label="Screen Y"
          value={settings.screenY}
          min={-0.4}
          max={0.4}
          step={0.01}
          onChange={(value) => setValue("screenY", value)}
        />
      </SettingsSection>

      <SettingsSection title="Zones">
        <NumberSlider
          label="Dead Width"
          value={settings.deadWidth}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setValue("deadWidth", value)}
        />
        <NumberSlider
          label="Dead Height"
          value={settings.deadHeight}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setValue("deadHeight", value)}
        />
        <NumberSlider
          label="Soft Width"
          value={settings.softWidth}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setValue("softWidth", value)}
        />
        <NumberSlider
          label="Soft Height"
          value={settings.softHeight}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setValue("softHeight", value)}
        />
        <NumberSlider
          label="Hard Width"
          value={settings.hardWidth}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setValue("hardWidth", value)}
        />
        <NumberSlider
          label="Hard Height"
          value={settings.hardHeight}
          min={0}
          max={1}
          step={0.01}
          onChange={(value) => setValue("hardHeight", value)}
        />
      </SettingsSection>

      <SettingsSection title="Damping">
        <NumberSlider
          label="Horizontal"
          value={settings.dampingX}
          min={0}
          max={20}
          step={0.1}
          onChange={(value) => setValue("dampingX", value)}
        />
        <NumberSlider
          label="Vertical"
          value={settings.dampingY}
          min={0}
          max={20}
          step={0.1}
          onChange={(value) => setValue("dampingY", value)}
        />
      </SettingsSection>

      <SettingsSection title="Lookahead">
        <NumberSlider
          label="Time"
          value={settings.lookaheadTime}
          min={0}
          max={1.5}
          step={0.01}
          unit="s"
          onChange={(value) => setValue("lookaheadTime", value)}
        />
        <NumberSlider
          label="Smoothing"
          value={settings.lookaheadSmoothing}
          min={0}
          max={20}
          step={0.1}
          onChange={(value) => setValue("lookaheadSmoothing", value)}
        />
        <label style={{ display: "block", fontSize: 12 }}>
          <input
            type="checkbox"
            checked={settings.lookaheadIgnoreY}
            onChange={(event) => setValue("lookaheadIgnoreY", event.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Ignore Y</span>
        </label>
      </SettingsSection>
    </div>
  );
}

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ borderTop: "1px solid rgba(148, 163, 184, 0.18)", paddingTop: 10, marginTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: "#cbd5e1", marginBottom: 8 }}>{title}</div>
      <div style={{ display: "grid", gap: 8 }}>{children}</div>
    </div>
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

function VirtualCameraPanel({
  cameras,
  activeId,
  selectedId,
  captureSource,
  blendCurve,
  blendDuration,
  transitionProgress,
  onCaptureSourceChange,
  onBlendCurveChange,
  onBlendDurationChange,
  onCapture,
  onAddCart,
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
  captureSource: VirtualCameraCaptureSource;
  blendCurve: VirtualCameraBlendCurve;
  blendDuration: number;
  transitionProgress: number;
  onCaptureSourceChange: (source: VirtualCameraCaptureSource) => void;
  onBlendCurveChange: (curve: VirtualCameraBlendCurve) => void;
  onBlendDurationChange: (duration: number) => void;
  onCapture: () => void;
  onAddCart: () => void;
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onRelease: () => void;
  trackTargets: RegisteredTarget[];
  onUpdateShot: (id: string, patch: DemoShotPatch) => void;
  onUpdateComposer: (id: string, settings: ComposerSettings) => void;
  dollies: DemoDolly[];
}) {
  const [composerOpenId, setComposerOpenId] = useState<string | null>(null);
  return (
    <div
      style={{
        width: "100%",
        boxSizing: "border-box",
        padding: 12,
        borderRadius: 8,
        background: "rgba(10, 16, 28, 0.92)",
        color: "#f8fafc",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        boxShadow: "0 24px 60px rgba(15, 23, 42, 0.32)",
        border: "1px solid rgba(148, 163, 184, 0.22)"
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 800 }}>Virtual Cameras</div>
        {activeId ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, color: "#22c55e" }}>
              Live: {cameras.find((camera) => camera.id === activeId)?.name ?? "Camera"}
            </span>
            <button onClick={onRelease}>Release</button>
          </div>
        ) : null}
      </div>

      <SettingsSection title="Capture">
        <label style={{ display: "grid", gridTemplateColumns: "96px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
          <span>Source</span>
          <select
            value={captureSource}
            onChange={(event) => onCaptureSourceChange(event.target.value as VirtualCameraCaptureSource)}
          >
            <option value="rig">Rig camera (dolly pose)</option>
            <option value="viewport">Main viewport (orbit camera)</option>
          </select>
        </label>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onCapture}>Add VCam</button>
          <button onClick={onAddCart}>Add Cart VCam</button>
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
                  <label
                    onClick={(event) => event.stopPropagation()}
                    style={shotRowLabelStyle("48px 1fr 44px 52px")}
                  >
                    <span>Noise</span>
                    <select
                      value={camera.noisePreset}
                      onChange={(event) =>
                        onUpdateShot(camera.id, {
                          noisePreset: event.target.value as DemoNoisePreset
                        })
                      }
                    >
                      <option value="off">Off</option>
                      <option value="subtle">Subtle handheld</option>
                      <option value="rough">Rough handheld</option>
                    </select>
                    <span style={{ textAlign: "right" }}>Dutch</span>
                    <input
                      type="number"
                      value={camera.dutchDeg}
                      min={-45}
                      max={45}
                      step={5}
                      style={{ width: "100%" }}
                      onChange={(event) =>
                        onUpdateShot(camera.id, { dutchDeg: Number(event.target.value) || 0 })
                      }
                    />
                  </label>
                  {camera.bodyType === "cart" ? (
                    <label
                      onClick={(event) => event.stopPropagation()}
                      title="Rail distance at shot start/end; empty = free-run at rig speed"
                      style={shotRowLabelStyle("48px 72px 1fr 14px 1fr")}
                    >
                      <span>Dolly</span>
                      <select
                        value={camera.cartId}
                        onChange={(event) =>
                          onUpdateShot(camera.id, { cartId: event.target.value })
                        }
                      >
                        {dollies.map((dolly) => (
                          <option key={dolly.id} value={dolly.id}>
                            {dolly.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="number"
                        placeholder="free"
                        value={camera.railFrom ?? ""}
                        step={0.5}
                        style={{ width: "100%" }}
                        onChange={(event) =>
                          onUpdateShot(camera.id, {
                            railFrom: event.target.value === "" ? null : Number(event.target.value)
                          })
                        }
                      />
                      <span style={{ textAlign: "center" }}>→</span>
                      <input
                        type="number"
                        placeholder="free"
                        value={camera.railTo ?? ""}
                        step={0.5}
                        style={{ width: "100%" }}
                        onChange={(event) =>
                          onUpdateShot(camera.id, {
                            railTo: event.target.value === "" ? null : Number(event.target.value)
                          })
                        }
                      />
                    </label>
                  ) : null}
                  <div
                    onClick={(event) => event.stopPropagation()}
                    style={{ gridColumn: "1 / -1", display: "grid", gap: 6, minWidth: 0 }}
                  >
                    <button
                      style={{ fontSize: 11, textAlign: "left" }}
                      onClick={() =>
                        setComposerOpenId(composerOpenId === camera.id ? null : camera.id)
                      }
                    >
                      {composerOpenId === camera.id ? "▾ Composer settings" : "▸ Composer settings"}
                    </button>
                    {composerOpenId === camera.id ? (
                      <RigSettingsPanel
                        settings={camera.composerSettings}
                        onChange={(settings) => onUpdateComposer(camera.id, settings)}
                        onClose={() => setComposerOpenId(null)}
                        onReset={() => onUpdateComposer(camera.id, DEFAULT_COMPOSER_SETTINGS)}
                      />
                    ) : null}
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
  const [bezierPath, setBezierPath] = useState<BezierPath | null>(() => {
    try {
      const rawShow = localStorage.getItem(SHOW_STORAGE_KEY);
      if (rawShow) {
        const parsedShow = JSON.parse(rawShow) as {
          paths?: DemoPath[];
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
  const [speed, setSpeed] = useState(1);
  const [driveMainCamera, setDriveMainCamera] = useState(false);
  const [poseSource, setPoseSource] = useState<CameraPoseSource>("dolly");
  const [aimMode, setAimMode] = useState<CameraAimMode>("screen-composer");
  const [debugPreview, setDebugPreview] = useState(true);
  const [debugFrustum, setDebugFrustum] = useState(true);
  const [showCartRider, setShowCartRider] = useState(false);
  const [showTargetRig, setShowTargetRig] = useState(false);
  const targetRegistry = useMemo(() => new TargetRegistry(), []);
  const registeredTargets = useRegisteredTargets(targetRegistry);
  const [pipDriver, setPipDriver] = useState<"shots" | "timeline">("shots");
  const timelinePlayerRef = useRef<TimelinePlayer>(createTimelinePlayer());
  const [composerSettings, setComposerSettings] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  // The show (dollies, shots, mounts, moves) survives reloads like the spline.
  const storedShow = useMemo(() => {
    try {
      const raw = localStorage.getItem(SHOW_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as
        | Partial<DemoVirtualCamera>[]
        | {
            dollies?: Partial<DemoDolly>[];
            vcams?: Partial<DemoVirtualCamera>[];
            paths?: DemoPath[];
            activePathId?: string;
          };
      return Array.isArray(parsed) ? { vcams: parsed } : parsed;
    } catch {
      return null;
    }
  }, []);
  const [dollies, setDollies] = useState<DemoDolly[]>(() =>
    (storedShow?.dollies ?? INITIAL_DOLLIES).map((dolly) => ({
      ...FALLBACK_DOLLY,
      ...dolly,
      endOfPath: dolly.endOfPath ?? EndOfPathInstruction.Loop,
      pathId: dolly.pathId ?? storedShow?.paths?.[0]?.id ?? FALLBACK_PATH_ID
    }))
  );

  function updateDolly(id: string, patch: Partial<DemoDolly>): void {
    setDollies((current) =>
      current.map((dolly) => (dolly.id === id ? { ...dolly, ...patch } : dolly))
    );
  }

  const [paths, setPaths] = useState<DemoPath[]>(
    () =>
      storedShow?.paths ?? [{ id: FALLBACK_PATH_ID, name: "Path 1", bezier: createDefaultBezier().toJSON() }]
  );
  const [activePathId, setActivePathId] = useState<string | null>(
    () => storedShow?.activePathId ?? paths[0]?.id ?? null
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
    setBezierPath(BezierPath.fromJSON(target.bezier));
    setSelectedHandleIndex(null);
    setSelectedMidpointIndex(null);
    setPathVersion((version) => version + 1);
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
  const [virtualCameras, setVirtualCameras] = useState<DemoVirtualCamera[]>(() =>
    (storedShow?.vcams ?? []).map((vcam, index) => ({
      cartId: storedShow?.dollies?.[0]?.id ?? FALLBACK_DOLLY.id,
      cartOffset: { x: 0, y: 0, z: 0 },
      trackTargetId: null,
      noisePreset: "off" as const,
      dutchDeg: 0,
      shotStart: index * 5,
      shotEnd: index * 5 + 5,
      railFrom: null,
      railTo: null,
      ...vcam
    })) as DemoVirtualCamera[]
  );
  useEffect(() => {
        localStorage.setItem(
      SHOW_STORAGE_KEY,
      JSON.stringify({ dollies, vcams: virtualCameras, paths, activePathId })
    );
  }, [dollies, virtualCameras, paths, activePathId]);

  function addDolly(): void {
    const id = `dolly-${Date.now()}`;
    setDollies((current) => [...current, { id, name: `Dolly ${current.length + 1}`, endOfPath: EndOfPathInstruction.Loop, pathId: activePathId ?? paths[0]?.id ?? "" }]);
  }

  function deleteDolly(id: string): void {
    setDollies((current) => {
      const next = current.filter((dolly) => dolly.id !== id);
      // Remount cameras off the deleted dolly onto whatever remains; with no
      // dolly left the reference dangles (a cart vcam then produces no frame).
      const remount = next[0]?.id;
      if (remount) {
        setVirtualCameras((vcams) =>
          vcams.map((vcam) => (vcam.cartId === id ? { ...vcam, cartId: remount } : vcam))
        );
      }
      return next;
    });
  }
  const [selectedVirtualCameraId, setSelectedVirtualCameraId] = useState<string | null>(null);
  const [virtualCameraCaptureRequest, setVirtualCameraCaptureRequest] = useState(0);
  const [virtualCameraCaptureSource, setVirtualCameraCaptureSource] =
    useState<VirtualCameraCaptureSource>("rig");
  const [virtualCameraActivation, setVirtualCameraActivation] =
    useState<VirtualCameraActivation | null>(null);
  const [virtualCameraBlendCurve, setVirtualCameraBlendCurve] =
    useState<VirtualCameraBlendCurve>("easeInOut");
  const [virtualCameraBlendDuration, setVirtualCameraBlendDuration] = useState(1.2);
  const [virtualCameraTransitionProgress, setVirtualCameraTransitionProgress] = useState(1);
  const [useWorldSpaceGizmo, setUseWorldSpaceGizmo] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [selectedHandleIndex, setSelectedHandleIndex] = useState<number | null>(0);
  const [selectedMidpointIndex, setSelectedMidpointIndex] = useState<number | null>(null);
  const dollyTargetMarkerRef = useRef<HTMLDivElement | null>(null);
  const dollyTargetLineRef = useRef<SVGLineElement | null>(null);
  const lookaheadMarkerRef = useRef<HTMLDivElement | null>(null);
  const lookaheadLineRef = useRef<SVGLineElement | null>(null);
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
  // Key the show only on timing fields so gizmo drags (offset/pose edits at
  // pointer rate) don't rebuild the timeline object every frame — the lane
  // editor treats a new editorData as a full re-init.
  const shotTimingKey = virtualCameras
    .map(
      (vcam) =>
        `${vcam.id}:${vcam.shotStart}:${vcam.shotEnd}:${vcam.cartId}:${vcam.railFrom ?? ""}:${vcam.railTo ?? ""}`
    )
    .join("|");
  const dollyKey = dollies.map((dolly) => dolly.id).join(",");
  const demoTimeline = useMemo(() => {
    if (virtualCameras.length === 0) return null;
    const ordered = [...virtualCameras].sort((a, b) => a.shotStart - b.shotStart);
    const blocks = ordered.map((vcam, index) => {
      // Overlap with the preceding shot is the crossfade window; no overlap
      // cuts, gaps hold the previous shot (evaluator semantics).
      const previous = index > 0 ? ordered[index - 1] : undefined;
      const overlap = previous ? previous.shotEnd - vcam.shotStart : 0;
      return {
        id: `block-${vcam.id}`,
        vcamId: vcam.id,
        start: vcam.shotStart,
        end: vcam.shotEnd,
        ...(overlap > 0.01 && {
          blendIn: { durationSeconds: overlap, curve: "easeInOut" as const }
        })
      };
    });
    // Shots that define a dolly move compile to cart-track keys on THEIR
    // dolly: the camera travels railFrom -> railTo across its block, eased;
    // between moves the evaluator interpolates toward the next move's start.
    const cartTracks = dollies.map((dolly) => ({
      type: "cart" as const,
      id: `dolly-track-${dolly.id}`,
      cartId: dolly.id,
      keys: ordered
        .filter(
          (vcam) =>
            vcam.bodyType === "cart" &&
            vcam.cartId === dolly.id &&
            vcam.railFrom !== null &&
            vcam.railTo !== null
        )
        .flatMap((vcam) => [
          { time: vcam.shotStart, distance: vcam.railFrom ?? 0, easing: "easeInOut" as const },
          { time: vcam.shotEnd, distance: vcam.railTo ?? 0 }
        ])
    })).filter((track) => track.keys.length > 0);
    return createTimeline({
      duration: Math.max(...ordered.map((vcam) => vcam.shotEnd)),
      tracks: [{ type: "camera", id: "camera-track", blocks }, ...cartTracks]
    });
    // shotTimingKey + dollyKey cover every field this memo reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shotTimingKey, dollyKey]);
  const timelineActive = pipDriver === "timeline" && demoTimeline != null;
  // The rig preview only has a source while an editable path drives it; with
  // no timeline/shot/selection and no path, the PiP shows "no output".
  const hasPipSource = Boolean(
    timelineActive || virtualCameraActivation || selectedVirtualCamera || bezierPath
  );
  const pipLabel = timelineActive
    ? "Timeline"
    : virtualCameraActivation
      ? "Brain Camera"
      : selectedVirtualCamera
        ? selectedVirtualCamera.name
        : bezierPath
          ? "Rig Camera"
          : "No output";

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
    setSelectedVirtualCameraId(id);
    setVirtualCameras((current) => [
      ...current,
      {
        id,
        name,
        bodyType,
        cartId: defaultDollyId,
        cartOffset: { x: 0, y: 0, z: 0 },
        trackTargetId: null,
        noisePreset: "off",
        dutchDeg: 0,
        shotStart,
        shotEnd: shotStart + 5,
        railFrom: null,
        railTo: null,
        snapshot: {
          ...snapshot,
          name,
          settings: composerSettingsToVirtualCameraSettings(composerSettings)
        },
        poseSource,
        aimMode,
        composerSettings
      }
    ]);
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

  function activateVirtualCamera(id: string): void {
    const camera = virtualCameras.find((item) => item.id === id);
    if (!camera) return;

    const durationSeconds = virtualCameraBlendCurve === "cut" ? 0 : virtualCameraBlendDuration;
    selectVirtualCamera(id);
    setDriveMainCamera(false);
    setPoseSource(camera.poseSource);
    setAimMode(camera.aimMode);
    setComposerSettings(mergeVirtualCameraSettings(camera.composerSettings, camera.snapshot.settings));
    setVirtualCameraTransitionProgress(durationSeconds <= 0 ? 1 : 0);
    setVirtualCameraActivation({
      key: Date.now(),
      toId: id,
      durationSeconds,
      curve: virtualCameraBlendCurve
    });
  }

  function updateVirtualCameraShot(id: string, patch: DemoShotPatch): void {
    setVirtualCameras((current) =>
      current.map((camera) => (camera.id === id ? { ...camera, ...patch } : camera))
    );
  }

  function updateVirtualCameraComposer(id: string, settings: ComposerSettings): void {
    setVirtualCameras((current) =>
      current.map((camera) =>
        camera.id === id
          ? {
              ...camera,
              composerSettings: settings,
              snapshot: {
                ...camera.snapshot,
                settings: composerSettingsToVirtualCameraSettings(settings)
              }
            }
          : camera
      )
    );
    // Keep the live rig in sync when the edited shot is the one on screen.
    if (id === selectedVirtualCameraId || id === virtualCameraActivation?.toId) {
      setComposerSettings(settings);
    }
  }

  function deleteVirtualCamera(id: string): void {
    setVirtualCameras((current) => current.filter((camera) => camera.id !== id));
    if (selectedVirtualCameraId === id) {
      setSelectedVirtualCameraId(null);
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
    setSelectedVirtualCameraId(id);
    if (id !== null) {
      setSelectedHandleIndex(null);
      setSelectedMidpointIndex(null);
      setPipDriver("shots");
      timelinePlayerRef.current.playing = false;
    }
  }

  function updateVirtualCameraSnapshot(id: string, snapshot: VirtualCameraSnapshot): void {
    setVirtualCameras((current) =>
      current.map((camera) =>
        camera.id === id
          ? {
              ...camera,
              snapshot: {
                ...snapshot,
                name: camera.name,
                settings: camera.snapshot.settings ?? {}
              }
            }
          : camera
      )
    );
    if (virtualCameraActivation?.toId === id) {
      releaseVirtualCamera();
    }
  }

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <div
        style={{
          position: "fixed",
          top: 12,
          left: 12,
          zIndex: 10,
          width: 380,
          maxHeight: "calc(100vh - 24px)",
          overflowY: "auto",
          padding: 12,
          borderRadius: 8,
          background: "rgba(10, 16, 28, 0.92)",
          color: "#f8fafc",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          boxShadow: "0 24px 60px rgba(15, 23, 42, 0.28)",
          border: "1px solid rgba(148, 163, 184, 0.22)",
          boxSizing: "border-box"
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 800 }}>Path Creator Demo</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
            Edit spline, drive rigs, validate cameras
          </div>
        </div>

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
              <div
                key={dolly.id}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
              >
                <span style={{ flex: 1 }}>{dolly.name}</span>
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
                  value={dolly.endOfPath}
                  onChange={(event) =>
                    updateDolly(dolly.id, {
                      endOfPath: event.target.value as EndOfPathInstruction
                    })
                  }
                >
                  <option value={EndOfPathInstruction.Loop}>Loop</option>
                  <option value={EndOfPathInstruction.Reverse}>Ping-pong</option>
                  <option value={EndOfPathInstruction.Stop}>Stop</option>
                </select>
                <button onClick={() => deleteDolly(dolly.id)}>Del</button>
              </div>
            ))}
            <button onClick={addDolly}>Add Dolly</button>
          </div>
        </SettingsSection>

        <SettingsSection title="Paths">
          <div style={{ display: "grid", gap: 4 }}>
            {paths.map((path) => (
              <div
                key={path.id}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}
              >
                <label style={{ flex: 1 }}>
                  <input
                    type="radio"
                    name="active-path"
                    checked={path.id === activePathId}
                    onChange={() => switchPath(path.id)}
                  />
                  <span style={{ marginLeft: 6 }}>{path.name}</span>
                </label>
                <button onClick={() => deletePath(path.id)}>Del</button>
              </div>
            ))}
            <button onClick={addPath}>Add Path</button>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>
              The selected path is editable in the viewport; others render dashed.
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Rig Driver">
          <NumberSlider
            label="Speed"
            value={speed}
            min={0.2}
            max={3}
            step={0.1}
            onChange={setSpeed}
          />

          <label style={{ display: "block", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={driveMainCamera}
              onChange={(e) => {
                setDriveMainCamera(e.target.checked);
                if (e.target.checked) releaseVirtualCamera();
              }}
            />
            <span style={{ marginLeft: 6 }}>Drive main viewport from rig</span>
          </label>

          <label style={{ display: "grid", gridTemplateColumns: "112px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span>Pose Source</span>
            <select
              value={poseSource}
              onChange={(e) => setPoseSource(e.target.value as CameraPoseSource)}
            >
              <option value="dolly">Dolly Rail</option>
              <option value="static">Static</option>
            </select>
          </label>

          <label style={{ display: "grid", gridTemplateColumns: "112px 1fr", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span>Aim Mode</span>
            <select
              value={aimMode}
              onChange={(e) => setAimMode(e.target.value as CameraAimMode)}
            >
              <option value="screen-composer">Screen Composer</option>
              <option value="path-lookahead">Path Lookahead</option>
              <option value="look-at-target">Look At Target</option>
            </select>
          </label>
        </SettingsSection>

        <SettingsSection title="Viewport Debug">
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
            <span style={{ marginLeft: 6 }}>Show rig frustum</span>
          </label>

          <label style={{ display: "block", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={showCartRider}
              onChange={(e) => setShowCartRider(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>Show cart rider prop</span>
          </label>

          <label style={{ display: "block", fontSize: 12 }}>
            <input
              type="checkbox"
              checked={showTargetRig}
              onChange={(e) => setShowTargetRig(e.target.checked)}
            />
            <span style={{ marginLeft: 6 }}>Show target rig (named nodes)</span>
          </label>

          <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.45 }}>
            Orbit: right-drag. Pan: middle-drag. Zoom: wheel.
          </div>
        </SettingsSection>
      </div>

      {driveMainCamera && aimMode === "screen-composer" ? (
        <ComposerGuides settings={composerSettings} />
      ) : null}
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
          captureSource={virtualCameraCaptureSource}
          blendCurve={virtualCameraBlendCurve}
          blendDuration={virtualCameraBlendDuration}
          transitionProgress={virtualCameraTransitionProgress}
          onCaptureSourceChange={setVirtualCameraCaptureSource}
          onBlendCurveChange={setVirtualCameraBlendCurve}
          onBlendDurationChange={setVirtualCameraBlendDuration}
          onCapture={captureVirtualCamera}
          onAddCart={addCartVirtualCamera}
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
        style={{
          position: "fixed",
          bottom: 12,
          left: 404,
          right: 404,
          zIndex: 9
        }}
      >
        <TimelineLanes
          shots={virtualCameras.map((vcam) => ({
            id: vcam.id,
            name: vcam.name,
            start: vcam.shotStart,
            end: vcam.shotEnd
          }))}
          dollyMoves={virtualCameras
            .filter(
              (vcam) =>
                vcam.bodyType === "cart" && vcam.railFrom !== null && vcam.railTo !== null
            )
            .map((vcam) => ({
              shotId: vcam.id,
              dollyId: vcam.cartId,
              dollyName: dollies.find((dolly) => dolly.id === vcam.cartId)?.name ?? vcam.cartId,
              start: vcam.shotStart,
              end: vcam.shotEnd,
              label: `${vcam.railFrom} → ${vcam.railTo}`
            }))}
          selectedShotId={selectedVirtualCameraId}
          playerRef={timelinePlayerRef}
          duration={demoTimeline?.duration ?? 0}
          driving={timelineActive}
          onShotTiming={(vcamId, shotStart, shotEnd) =>
            updateVirtualCameraShot(vcamId, { shotStart, shotEnd })
          }
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
          composerActive={aimMode === "screen-composer"}
          composerSettings={composerSettings}
          label={pipLabel}
          hasSource={hasPipSource}
          targetMarkerRef={dollyTargetMarkerRef}
          targetLineRef={dollyTargetLineRef}
          lookaheadMarkerRef={lookaheadMarkerRef}
          lookaheadLineRef={lookaheadLineRef}
        />
      ) : null}

      <Canvas style={{ width: "100%", height: "100%" }} camera={{ position: [0, 0, 6], fov: 45 }}>
        <color attach="background" args={["#f8fafc"]} />
        <OrbitControls
          makeDefault
          enabled={!isTransforming && !driveMainCamera}
          enableDamping
          dampingFactor={0.08}
          mouseButtons={{ MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE }}
        />
        <Scene
          bezierPath={bezierPath}
          vertexPath={vertexPath}
          targetRegistry={targetRegistry}
          dollies={dollies}
          vertexPaths={vertexPaths}
          activeTimeline={timelineActive ? demoTimeline : null}
          timelinePlayerRef={timelinePlayerRef}
          pathVersion={pathVersion}
          speed={speed}
          driveMainCamera={driveMainCamera}
          poseSource={poseSource}
          aimMode={aimMode}
          composerSettings={composerSettings}
          debugPreview={debugPreview}
          debugFrustum={debugFrustum}
          showCartRider={showCartRider}
          showTargetRig={showTargetRig}
          selectedHandleIndex={selectedHandleIndex}
          selectedMidpointIndex={selectedMidpointIndex}
          anchorScales={anchorScales}
          useWorldSpaceGizmo={useWorldSpaceGizmo}
          isTransforming={isTransforming}
          onSelectHandle={(idx) => {
            setSelectedHandleIndex(idx);
            if (idx !== null) {
              setSelectedMidpointIndex(null);
            }
          }}
          onSelectMidpoint={(idx) => {
            setSelectedMidpointIndex(idx);
            if (idx !== null) {
              setSelectedHandleIndex(null);
            }
          }}
          onTransformingChange={setIsTransforming}
          onRotateMidpointNormal={rotateMidpointNormal}
          dollyTargetMarkerRef={dollyTargetMarkerRef}
          dollyTargetLineRef={dollyTargetLineRef}
          lookaheadMarkerRef={lookaheadMarkerRef}
          lookaheadLineRef={lookaheadLineRef}
          virtualCameraCaptureRequest={virtualCameraCaptureRequest}
          virtualCameraCaptureSource={virtualCameraCaptureSource}
          virtualCameraActivation={virtualCameraActivation}
          virtualCameras={virtualCameras}
          selectedVirtualCameraId={selectedVirtualCameraId}
          onVirtualCameraCaptured={addCapturedVirtualCamera}
          onVirtualCameraResolved={({ snapshot, progress }) => {
            setVirtualCameraTransitionProgress(progress);
            setComposerSettings((current) => mergeVirtualCameraSettings(current, snapshot.settings));
          }}
          onSelectVirtualCamera={selectVirtualCamera}
          onUpdateVirtualCameraSnapshot={updateVirtualCameraSnapshot}
          onUpdateCartOffset={(id, cartOffset) => updateVirtualCameraShot(id, { cartOffset })}
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
      </Canvas>
    </div>
  );
}
