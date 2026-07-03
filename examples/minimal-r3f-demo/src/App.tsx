import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, Line, OrbitControls, PivotControls, Text } from "@react-three/drei";
import {
  BezierPath,
  ControlMode,
  EndOfPathInstruction,
  PathSpace,
  VertexPath,
  type SerializedBezierPath,
  type Vec3
} from "@huma/path-creator/core";
import {
  applySampleToObject,
  applyScreenComposerAim,
  createScreenComposerState,
  samplePathAtDistance,
  usePathFollower
} from "@huma/path-creator/r3f";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  CameraHelper,
  Euler,
  MOUSE,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Vector3,
  type Mesh
} from "three";

const STORAGE_KEY = "path-creator:minimal-demo:path";
const DOLLY_PIP_ASPECT = 16 / 9;
const DOLLY_PIP_MARGIN = 16;
const STATIC_CAMERA_POSITION = { x: 0, y: 1.1, z: 6 };
type CameraPoseSource = "dolly" | "static";
type CameraAimMode = "path-lookahead" | "look-at-target" | "screen-composer";

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
  lookaheadLineRef
}: {
  bezierPath: BezierPath;
  vertexPath: VertexPath;
  pathVersion: number;
  speed: number;
  driveMainCamera: boolean;
  poseSource: CameraPoseSource;
  aimMode: CameraAimMode;
  composerSettings: ComposerSettings;
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
  dollyTargetMarkerRef: { current: HTMLDivElement | null };
  dollyTargetLineRef: { current: SVGLineElement | null };
  lookaheadMarkerRef: { current: HTMLDivElement | null };
  lookaheadLineRef: { current: SVGLineElement | null };
}) {
  const followMode = bezierPath.isClosed ? EndOfPathInstruction.Loop : EndOfPathInstruction.Stop;
  const follower = usePathFollower({
    path: vertexPath,
    speed,
    mode: followMode
  });
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
  const frustumHelper = useMemo(() => new CameraHelper(previewCamera), [previewCamera]);

  const pathLinePoints = useMemo(
    () => buildPathLinePoints(vertexPath),
    [vertexPath, pathVersion]
  );
  const controlLinePositions = useMemo(
    () => buildControlLinePositions(bezierPath),
    [bezierPath, pathVersion]
  );
  const midpointData = useMemo(() => {
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
    selectedHandleIndex !== null ? bezierPath.getPoint(selectedHandleIndex) : null;
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
    if (useWorldSpaceGizmo || selectedHandleIndex === null) {
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
    const followerObject = scene.getObjectByName("follower") as Mesh | null;
    const lookTargetObject = scene.getObjectByName("look-target") as Mesh | null;
    const sample = follower.step(delta);
    const elapsed = performance.now() / 1000;
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
    const aimTarget = aimMode === "look-at-target" || aimMode === "screen-composer"
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
    frustumHelper.update();
    projectedTarget.set(aimTarget.x, aimTarget.y, aimTarget.z).project(previewCamera);
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
    projectedTarget.set(lookaheadTarget.x, lookaheadTarget.y, lookaheadTarget.z).project(previewCamera);
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

    if (driveMainCamera && !isTransforming) {
      applyCameraPose(camera as PerspectiveCamera, poseSource, sample.position, cameraPositionTarget, delta);
      applyCameraAim(
        camera as PerspectiveCamera,
        aimMode,
        aimTarget,
        sample.normal,
        composerSettings,
        composerState.current,
        delta
      );
    } else {
      composerState.current = createScreenComposerState();
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 4]} intensity={1.2} />

      <Line points={pathLinePoints} color="#101828" lineWidth={4} />

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

      {Array.from({ length: bezierPath.numPoints }).map((_, i) => {
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
            if (selectedHandleIsAnchor && bezierPath.controlMode !== ControlMode.Automatic) {
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
        }}
      >
        <sphereGeometry args={[0.0001, 4, 4]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      <mesh name="follower">
        <sphereGeometry args={[0.13, 16, 16]} />
        <meshStandardMaterial color="#ef4444" />
      </mesh>

      <mesh name="look-target">
        <sphereGeometry args={[0.1, 16, 16]} />
        <meshStandardMaterial color="#06b6d4" emissive="#083344" emissiveIntensity={0.45} />
      </mesh>

      {debugFrustum ? <primitive object={frustumHelper} /> : null}
      {debugPreview ? <DollyCameraPip camera={previewCamera} frustumHelper={frustumHelper} /> : null}
    </>
  );
}

function DollyCameraPip({
  camera: dollyCamera,
  frustumHelper
}: {
  camera: PerspectiveCamera;
  frustumHelper: CameraHelper;
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
    frustumHelper.visible = false;
    gl.render(scene, dollyCamera);
    frustumHelper.visible = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, size.width, size.height);
  }, 1);

  return null;
}

function DollyPreviewChrome({
  composerActive,
  composerSettings,
  targetMarkerRef,
  targetLineRef,
  lookaheadMarkerRef,
  lookaheadLineRef
}: {
  composerActive: boolean;
  composerSettings: ComposerSettings;
  targetMarkerRef: { current: HTMLDivElement | null };
  targetLineRef: { current: SVGLineElement | null };
  lookaheadMarkerRef: { current: HTMLDivElement | null };
  lookaheadLineRef: { current: SVGLineElement | null };
}) {
  const zones = getComposerZones(composerSettings);

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
        Rig Camera
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
        position: "fixed",
        top: 12,
        right: 12,
        zIndex: 12,
        width: 340,
        maxHeight: "calc(100vh - 24px)",
        overflowY: "auto",
        padding: 12,
        borderRadius: 8,
        background: "rgba(10, 16, 28, 0.92)",
        color: "#f8fafc",
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
        boxShadow: "0 24px 60px rgba(15, 23, 42, 0.35)",
        border: "1px solid rgba(148, 163, 184, 0.26)"
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
    <label style={{ display: "grid", gridTemplateColumns: "118px 1fr 58px", alignItems: "center", gap: 8, fontSize: 12 }}>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
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

export function App() {
  const [bezierPath, setBezierPath] = useState<BezierPath>(() => {
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerSettings, setComposerSettings] = useState<ComposerSettings>(DEFAULT_COMPOSER_SETTINGS);
  const [useWorldSpaceGizmo, setUseWorldSpaceGizmo] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [selectedHandleIndex, setSelectedHandleIndex] = useState<number | null>(0);
  const [selectedMidpointIndex, setSelectedMidpointIndex] = useState<number | null>(null);
  const dollyTargetMarkerRef = useRef<HTMLDivElement | null>(null);
  const dollyTargetLineRef = useRef<SVGLineElement | null>(null);
  const lookaheadMarkerRef = useRef<HTMLDivElement | null>(null);
  const lookaheadLineRef = useRef<SVGLineElement | null>(null);
  const [anchorScales, setAnchorScales] = useState<number[]>(
    () => new Array(bezierPath.numAnchorPoints).fill(1)
  );

  const vertexPath = useMemo(
    () => new VertexPath(bezierPath, { spacing: 0.03 }),
    [bezierPath, pathVersion]
  );
  const selectedAnchorScaleForUi =
    selectedHandleIndex !== null && selectedHandleIndex % 3 === 0
      ? anchorScales[Math.floor(selectedHandleIndex / 3)] ?? 1
      : null;

  function getActiveAnchorPointIndex(path: BezierPath): number | null {
    if (selectedHandleIndex === null) return null;
    if (selectedHandleIndex < 0 || selectedHandleIndex >= path.numPoints) return null;
    const mod = selectedHandleIndex % 3;
    if (mod === 0) return selectedHandleIndex;
    if (mod === 1) return selectedHandleIndex - 1;
    return selectedHandleIndex + 1;
  }

  function mutatePath(mutator: (path: BezierPath) => void): void {
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
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bezierPath.toJSON()));
  }

  function loadPath(): void {
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
    const reset = createDefaultBezier();
    setBezierPath(reset);
    setAnchorScales(new Array(reset.numAnchorPoints).fill(1));
    setSelectedHandleIndex(0);
    setSelectedMidpointIndex(null);
    setPathVersion((v) => v + 1);
  }

  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <div
        style={{
          position: "fixed",
          top: 12,
          left: 12,
          zIndex: 10,
          padding: 12,
          borderRadius: 10,
          background: "rgba(16, 24, 40, 0.86)",
          color: "#f8fafc",
          fontFamily: "ui-sans-serif, system-ui, sans-serif",
          width: 380
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          Path Editor (TransformControls)
        </div>
        <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 8 }}>
          Anchor scale: select an anchor and use scale handles.
        </div>
        {selectedAnchorScaleForUi !== null ? (
          <div style={{ fontSize: 12, opacity: 0.9, marginBottom: 8 }}>
            Selected anchor scale: {selectedAnchorScaleForUi.toFixed(2)}
          </div>
        ) : null}
        <label style={{ display: "block", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={useWorldSpaceGizmo}
            onChange={(e) => setUseWorldSpaceGizmo(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>World-space gizmo</span>
        </label>

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button onClick={addAnchor}>Add Anchor</button>
          <button onClick={insertAnchorAtSelectedSegment}>Insert Midpoint</button>
          <button onClick={deleteSelectedAnchor}>Delete Selected Anchor</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
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
          <button onClick={resetPath}>Reset</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button onClick={savePath}>Save</button>
          <button onClick={loadPath}>Load</button>
        </div>

        <label style={{ display: "block", marginBottom: 8 }}>
          Control Mode
          <select
            style={{ marginLeft: 8 }}
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

        <label style={{ display: "block", marginBottom: 8 }}>
          Speed: {speed.toFixed(2)}
          <input
            style={{ width: "100%" }}
            type="range"
            min={0.2}
            max={3}
            step={0.1}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          />
        </label>

        <label style={{ display: "block", marginBottom: 8 }}>
          <input
            type="checkbox"
            checked={driveMainCamera}
            onChange={(e) => setDriveMainCamera(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Drive main viewport</span>
        </label>

        <label style={{ display: "block", marginBottom: 8 }}>
          Pose Source
          <select
            style={{ marginLeft: 8 }}
            value={poseSource}
            onChange={(e) => setPoseSource(e.target.value as CameraPoseSource)}
          >
            <option value="dolly">Dolly Rail</option>
            <option value="static">Static</option>
          </select>
        </label>

        <label style={{ display: "block", marginBottom: 8 }}>
          Aim Mode
          <select
            style={{ marginLeft: 8 }}
            value={aimMode}
            onChange={(e) => setAimMode(e.target.value as CameraAimMode)}
          >
            <option value="screen-composer">Screen Composer</option>
            <option value="path-lookahead">Path Lookahead</option>
            <option value="look-at-target">Look At Target</option>
          </select>
        </label>

        <label style={{ display: "block", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={debugPreview}
            onChange={(e) => setDebugPreview(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Rig PiP</span>
        </label>

        <label style={{ display: "block", marginTop: 8 }}>
          <input
            type="checkbox"
            checked={debugFrustum}
            onChange={(e) => setDebugFrustum(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Rig Frustum</span>
        </label>

        <button
          onClick={() => setSettingsOpen((open) => !open)}
          style={{ marginTop: 10, width: "100%" }}
        >
          {settingsOpen ? "Hide Rig Settings" : "Open Rig Settings"}
        </button>

        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 10 }}>
          Click a handle to select it, then edit via TransformControls gizmo.
          <br />
          Orbit: right-drag. Zoom: wheel. Pan: middle-drag.
          <br />
          Insert Midpoint splits the segment after selected anchor.
        </div>
      </div>

      {driveMainCamera && aimMode === "screen-composer" ? (
        <ComposerGuides settings={composerSettings} />
      ) : null}
      {debugPreview ? (
        <DollyPreviewChrome
          composerActive={aimMode === "screen-composer"}
          composerSettings={composerSettings}
          targetMarkerRef={dollyTargetMarkerRef}
          targetLineRef={dollyTargetLineRef}
          lookaheadMarkerRef={lookaheadMarkerRef}
          lookaheadLineRef={lookaheadLineRef}
        />
      ) : null}
      {settingsOpen ? (
        <RigSettingsPanel
          settings={composerSettings}
          onChange={setComposerSettings}
          onClose={() => setSettingsOpen(false)}
          onReset={() => setComposerSettings(DEFAULT_COMPOSER_SETTINGS)}
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
          pathVersion={pathVersion}
          speed={speed}
          driveMainCamera={driveMainCamera}
          poseSource={poseSource}
          aimMode={aimMode}
          composerSettings={composerSettings}
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
          onSetAnchorScale={(anchorIndex, scale) => {
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
