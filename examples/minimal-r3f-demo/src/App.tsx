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
  EditorHelpers,
  useEditorHelpersVisible,
  useRegisteredTargets
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
  type Group
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
  /** Retained authored aim tuning for a future screen-composer aim mode. */
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

function composerSettingsToVirtualCameraSettings(
  settings: ComposerSettings
): Record<string, number> {
  const values: Record<string, number> = {};
  for (const key of VIRTUAL_CAMERA_SETTING_KEYS) {
    values[key] = settings[key];
  }
  return values;
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
// targets are authored, deletable entities: a fixed world position registered
// under an id that vcam aims can track. `visibleInRender` controls whether the
// sphere shows in the PiP (the stand-in for the real, non-authoring renderer) —
// off makes it an invisible aim point, still manipulable in the authoring view.
type DemoPointTarget = { id: string; name: string; position: Vec3; visibleInRender: boolean };

const INITIAL_POINT_TARGETS: DemoPointTarget[] = [
  { id: "target-1", name: "Target 1", position: { x: 3.3, y: 0.8, z: 0 }, visibleInRender: true },
  { id: "target-2", name: "Target 2", position: { x: 1.95, y: 1.15, z: 0.78 }, visibleInRender: true },
  { id: "target-3", name: "Target 3", position: { x: 1.95, y: 0.6, z: -0.78 }, visibleInRender: true }
];

// Next "Target N" that doesn't collide with an existing trailing number, so
// names stay stable after deletes.
function nextTargetName(current: DemoPointTarget[]): string {
  const highest = current.reduce((max, t) => {
    const match = /(\d+)$/.exec(t.name);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `Target ${highest + 1}`;
}

// Authored point targets: each a live pull-source in the registry, rendered as a
// cyan sphere. The sphere sits on layer 0 (seen by the PiP/render) when visible,
// or on the editor-helpers layer (authoring-only) when hidden. The selection
// ring and move gizmo are always authoring-only. Registration keys on the
// id/name set, so a drag moves the source via ref without re-registering.
function PointTargets({
  targets,
  registry,
  selectedId,
  onSelect,
  onMove,
  onTransformingChange
}: {
  targets: DemoPointTarget[];
  registry: TargetRegistry;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: Vec3) => void;
  onTransformingChange: (isTransforming: boolean) => void;
}) {
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const membershipKey = targets.map((t) => `${t.id}:${t.name}`).join("|");

  useEffect(() => {
    const unregister = targets.map((t) =>
      registry.register(
        t.id,
        () => targetsRef.current.find((x) => x.id === t.id)?.position ?? t.position,
        t.name
      )
    );
    return () => unregister.forEach((fn) => fn());
    // Positions are read live via targetsRef; only re-register when the set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipKey, registry]);

  return (
    <>
      {targets.map((t) => {
        const isSelected = t.id === selectedId;
        const sphere = (
          <group position={[t.position.x, t.position.y, t.position.z]}>
            <mesh
              onPointerDown={(event) => {
                event.stopPropagation();
                onSelect(isSelected ? null : t.id);
              }}
            >
              <sphereGeometry args={[0.1, 16, 16]} />
              <meshStandardMaterial
                color="#06b6d4"
                emissive="#06b6d4"
                emissiveIntensity={isSelected ? 0.55 : 0.3}
              />
            </mesh>
          </group>
        );
        return (
          <group key={t.id}>
            {t.visibleInRender ? sphere : <EditorHelpers>{sphere}</EditorHelpers>}
            {isSelected ? (
              <EditorHelpers>
                <group position={[t.position.x, t.position.y, t.position.z]}>
                  <Billboard>
                    <mesh>
                      <ringGeometry args={[0.16, 0.19, 28]} />
                      <meshBasicMaterial color="#06b6d4" transparent opacity={0.85} depthTest={false} />
                    </mesh>
                  </Billboard>
                </group>
                <PivotControls
                  {...VCAM_PIVOT_PROPS}
                  matrix={new Matrix4().makeTranslation(t.position.x, t.position.y, t.position.z)}
                  disableRotations
                  disableScaling
                  onDragStart={() => onTransformingChange(true)}
                  onDragEnd={() => onTransformingChange(false)}
                  onDrag={(matrix) =>
                    onMove(t.id, { x: matrix.elements[12], y: matrix.elements[13], z: matrix.elements[14] })
                  }
                >
                  <mesh>
                    <sphereGeometry args={[0.001, 4, 4]} />
                    <meshBasicMaterial transparent opacity={0} />
                  </mesh>
                </PivotControls>
              </EditorHelpers>
            ) : null}
          </group>
        );
      })}
    </>
  );
}

function Scene({
  bezierPath,
  vertexPath,
  pathVersion,
  speed,
  debugPreview,
  debugFrustum,
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
  virtualCameraCaptureRequest,
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
  debugPreview: boolean;
  debugFrustum: boolean;
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
  virtualCameraCaptureRequest: number;
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
  useEditorHelpersVisible();
  // One live free-running cart per dolly; the timeline branch overwrites the
  // frames with evaluated ones while it owns playback.
  const liveDollies = useMemo(
    () => new Map(dollies.map((dolly) => [dolly.id, createPathCart({ endOfPathInstruction: dolly.endOfPath })])),
    [dollies]
  );
  const dollyFramesRef = useRef<Map<string, CartFrame>>(new Map());
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

  useFrame(({ camera }, delta) => {
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

    frustumHelper.update();

    if (virtualCameraCaptureRequest !== lastCaptureRequestRef.current) {
      lastCaptureRequestRef.current = virtualCameraCaptureRequest;
      // Capture the main viewport (orbit) camera as a new static vcam.
      onVirtualCameraCaptured(
        captureVirtualCameraSnapshot(mainCamera, {
          settings: composerSettingsToVirtualCameraSettings(DEFAULT_COMPOSER_SETTINGS)
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
      }
      // Released gap (no camera): the PiP holds the last pose; there is no
      // separate live rig camera in the authored model.
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
    } else {
      activeVirtualCameraKeyRef.current = null;
      resolvedVirtualCameraKeyRef.current = null;
      virtualCameraBrainRef.current = createVirtualCameraBrainState();
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

// The PiP overlay chrome: just a framed panel + label. The camera view is
// rendered into this screen region by DollyCameraPip; a slate border/label
// reads "no output" when nothing drives it.
function DollyPreviewChrome({ label, hasSource }: { label: string; hasSource: boolean }) {
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
  blendCurve,
  blendDuration,
  transitionProgress,
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
  onSelect: (id: string) => void;
  onActivate: (id: string) => void;
  onDelete: (id: string) => void;
  onRelease: () => void;
  trackTargets: RegisteredTarget[];
  onUpdateShot: (id: string, patch: DemoShotPatch) => void;
  dollies: DemoDolly[];
}) {
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

      <SettingsSection title="Cameras">
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onCapture}>Add VCam (from viewport)</button>
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
  const [debugPreview, setDebugPreview] = useState(true);
  const [debugFrustum, setDebugFrustum] = useState(true);
  const targetRegistry = useMemo(() => new TargetRegistry(), []);
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
            dollies?: Partial<DemoDolly>[];
            vcams?: Partial<DemoVirtualCamera>[];
            paths?: DemoPath[];
            activePathId?: string;
            pointTargets?: DemoPointTarget[];
          };
      return Array.isArray(parsed) ? { vcams: parsed } : parsed;
    } catch {
      return null;
    }
  }, []);
  const [pointTargets, setPointTargets] = useState<DemoPointTarget[]>(
    () =>
      // Default visibleInRender for targets persisted before the field existed.
      storedShow?.pointTargets?.map((t) => ({ ...t, visibleInRender: t.visibleInRender ?? true })) ??
      INITIAL_POINT_TARGETS
  );
  const [selectedPointTargetId, setSelectedPointTargetId] = useState<string | null>(null);

  function selectPointTarget(id: string | null): void {
    setSelectedPointTargetId(id);
    if (id !== null) {
      setSelectedHandleIndex(null);
      setSelectedMidpointIndex(null);
      setSelectedVirtualCameraId(null);
    }
  }

  function addPointTarget(): void {
    const id = `target-${Date.now()}`;
    setPointTargets((current) => [
      ...current,
      { id, name: nextTargetName(current), position: { x: 2.4, y: 0.8, z: 0 }, visibleInRender: true }
    ]);
    selectPointTarget(id);
  }

  function deletePointTarget(id: string): void {
    setPointTargets((current) => current.filter((t) => t.id !== id));
    if (selectedPointTargetId === id) setSelectedPointTargetId(null);
  }

  function movePointTarget(id: string, position: Vec3): void {
    setPointTargets((current) => current.map((t) => (t.id === id ? { ...t, position } : t)));
  }

  function renamePointTarget(id: string, name: string): void {
    setPointTargets((current) => current.map((t) => (t.id === id ? { ...t, name } : t)));
  }

  function togglePointTargetVisible(id: string): void {
    setPointTargets((current) =>
      current.map((t) => (t.id === id ? { ...t, visibleInRender: !t.visibleInRender } : t))
    );
  }

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
      JSON.stringify({ dollies, vcams: virtualCameras, paths, activePathId, pointTargets })
    );
  }, [dollies, virtualCameras, paths, activePathId, pointTargets]);

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
          settings: composerSettingsToVirtualCameraSettings(DEFAULT_COMPOSER_SETTINGS)
        },
        composerSettings: DEFAULT_COMPOSER_SETTINGS
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
      setSelectedPointTargetId(null);
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
                <input
                  type="text"
                  value={dolly.name}
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
                <input
                  type="radio"
                  name="active-path"
                  title="Edit this path in the viewport"
                  checked={path.id === activePathId}
                  onChange={() => switchPath(path.id)}
                />
                <input
                  type="text"
                  value={path.name}
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
                  value={target.name}
                  aria-label="Target name"
                  onChange={(event) => renamePointTarget(target.id, event.target.value)}
                  onFocus={() => selectPointTarget(target.id)}
                  style={{ flex: 1, minWidth: 0, boxSizing: "border-box" }}
                />
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
                    fontSize: 13,
                    opacity: target.visibleInRender ? 1 : 0.4,
                    textDecoration: target.visibleInRender ? "none" : "line-through"
                  }}
                >
                  👁
                </button>
                <button onClick={() => deletePointTarget(target.id)}>Del</button>
              </div>
            ))}
            <button onClick={addPointTarget}>Add Target</button>
            <div style={{ fontSize: 11, color: "#94a3b8" }}>
              Point targets a vcam aim can track. Drag the selected one to place it; the eye
              hides it from the render (still an aim point).
            </div>
          </div>
        </SettingsSection>

        <SettingsSection title="Dolly Speed">
          <NumberSlider
            label="Speed"
            value={speed}
            min={0.2}
            max={3}
            step={0.1}
            onChange={setSpeed}
          />
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
            <span style={{ marginLeft: 6 }}>Show camera frustum</span>
          </label>

          <div style={{ fontSize: 11, color: "#94a3b8", lineHeight: 1.45 }}>
            Orbit: right-drag. Pan: middle-drag. Zoom: wheel.
          </div>
        </SettingsSection>
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
          trackTargets={registeredTargets}
          onUpdateShot={updateVirtualCameraShot}
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
        <DollyPreviewChrome label={pipLabel} hasSource={hasPipSource} />
      ) : null}

      <Canvas style={{ width: "100%", height: "100%" }} camera={{ position: [0, 0, 6], fov: 45 }}>
        <color attach="background" args={["#f8fafc"]} />
        <OrbitControls
          makeDefault
          enabled={!isTransforming}
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
          debugPreview={debugPreview}
          debugFrustum={debugFrustum}
          selectedHandleIndex={selectedHandleIndex}
          selectedMidpointIndex={selectedMidpointIndex}
          anchorScales={anchorScales}
          useWorldSpaceGizmo={useWorldSpaceGizmo}
          isTransforming={isTransforming}
          onSelectHandle={(idx) => {
            setSelectedHandleIndex(idx);
            if (idx !== null) {
              setSelectedMidpointIndex(null);
              setSelectedPointTargetId(null);
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
          virtualCameraCaptureRequest={virtualCameraCaptureRequest}
          virtualCameraActivation={virtualCameraActivation}
          virtualCameras={virtualCameras}
          selectedVirtualCameraId={selectedVirtualCameraId}
          onVirtualCameraCaptured={addCapturedVirtualCamera}
          onVirtualCameraResolved={({ progress }) => {
            setVirtualCameraTransitionProgress(progress);
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
        <PointTargets
          targets={pointTargets}
          registry={targetRegistry}
          selectedId={selectedPointTargetId}
          onSelect={selectPointTarget}
          onMove={movePointTarget}
          onTransformingChange={setIsTransforming}
        />
      </Canvas>
    </div>
  );
}
