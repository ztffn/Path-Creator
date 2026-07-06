// In-viewport spline editing UX for a BezierPath/VertexPath pair: the active
// path line, dashed sibling paths, control-handle connectors, midpoint normal
// gizmos, anchor/handle glyphs, and the drag/rotate PivotControls. Themable via
// PathEditorProps.theme. The subtree renders inside <EditorHelpers>, so hosts
// must call useEditorHelpersVisible(editing) on their viewport camera to see it.
import { Billboard, PivotControls, Text } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Euler, Matrix4, Quaternion, Vector3 } from "three";
import {
  ControlMode,
  EndOfPathInstruction,
  type BezierPath,
  type Vec3,
  type VertexPath
} from "../core";
import { type DollyRailOptions } from "../three";
import { EditorHelpers } from "./editor";
import { PathVisual, buildPathLinePoints } from "./path-visual";
import { RigLine } from "./rig-line";

export interface PathEditorTheme {
  activeLine?: string;
  inactiveLine?: string;
  controlLine?: string;
  /** Dolly-rail (two rails + cross-ties) for the active path. */
  rail?: string;
  tie?: string;
  anchor?: string;
  anchorSelected?: string;
  handle?: string;
  handleSelected?: string;
  midpointNormal?: string;
  midpoint?: string;
  label?: string;
}

export interface PathEditorProps {
  bezierPath: BezierPath;
  vertexPath: VertexPath;
  pathVersion: number;
  otherPaths?: ReadonlyArray<{ id: string; vertexPath: VertexPath }>;
  selectedHandleIndex: number | null;
  selectedMidpointIndex: number | null;
  anchorScales?: number[];
  useWorldSpaceGizmo?: boolean;
  theme?: PathEditorTheme;
  /** Active-path rendering: a single centre line ("line", default) or a
   *  Cinemachine-style dolly rail with two rails + cross-ties ("rail"). */
  pathStyle?: "line" | "rail";
  /** Tuning for the "rail" style. */
  railOptions?: DollyRailOptions;
  onSelectHandle: (index: number | null) => void;
  onSelectMidpoint: (index: number | null) => void;
  onMovePoint: (index: number, point: Vec3) => void;
  onSetAnchorScale?: (anchorIndex: number, scale: number) => void;
  onRotateMidpointNormal?: (segmentIndex: number, deltaDegrees: number) => void;
  onTransformingChange?: (transforming: boolean) => void;
  onClearSelection?: () => void;
}

// Current demo colors become the theme defaults; a partial theme overrides.
const DEFAULT_THEME: Required<PathEditorTheme> = {
  activeLine: "#101828",
  inactiveLine: "#475569",
  controlLine: "#8b8f97",
  rail: "#101828",
  tie: "#334155",
  anchor: "#f97316",
  anchorSelected: "#ffffff",
  handle: "#2563eb",
  handleSelected: "#ffffff",
  midpointNormal: "#06b6d4",
  midpoint: "#06b6d4",
  label: "#f97316"
};

export function buildControlLinePositions(path: BezierPath): Float32Array {
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

export function normalizeAnchorScales(count: number, previous: number[]): number[] {
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

/**
 * Suggests the next anchor position when extending a path: continues the last
 * segment's tangent, blended with the path direction, at the previous segment's
 * length. Hosts call this for their Add-anchor UX.
 */
export function getSuggestedNextAnchor(path: BezierPath): Vec3 {
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

export function PathEditor({
  bezierPath,
  vertexPath,
  pathVersion,
  otherPaths = [],
  selectedHandleIndex,
  selectedMidpointIndex,
  anchorScales = [],
  useWorldSpaceGizmo = false,
  theme,
  pathStyle = "line",
  railOptions,
  onSelectHandle,
  onSelectMidpoint,
  onMovePoint,
  onSetAnchorScale,
  onRotateMidpointNormal,
  onTransformingChange,
  onClearSelection
}: PathEditorProps): ReactNode {
  const t: Required<PathEditorTheme> = { ...DEFAULT_THEME, ...theme };

  // The two recompute effects skip while a gizmo drag is live; that state is
  // owned here (the host learns of it via onTransformingChange for OrbitControls).
  const [isTransforming, setIsTransformingState] = useState(false);
  const setTransforming = (value: boolean): void => {
    setIsTransformingState(value);
    onTransformingChange?.(value);
  };

  const handlePivotMatrix = useMemo(() => new Matrix4(), []);
  const [handleGizmoRotation, setHandleGizmoRotation] = useState<[number, number, number]>([0, 0, 0]);
  const anchorDragStartRef = useRef<{
    anchorIndex: number;
    anchorStart: Vec3;
    controlStarts: Array<{ index: number; point: Vec3 }>;
  } | null>(null);

  const controlLinePositions = useMemo(
    () => buildControlLinePositions(bezierPath),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // Anchors align to the surface plane (Z = normal). Control handles align
    // local X to their in/out direction (anchor -> handle), so dragging that axis
    // is pure length and the gizmo tracks the tangent after a move — rather than
    // snapping to the anchor's surface normal, which is unrelated to the handle.
    let quat: Quaternion;
    if (selectedHandleIsAnchor) {
      const [qx, qy, qz, qw] = getSurfaceAlignedQuaternion(
        vertexPath,
        bezierPath.getPoint(selectedHandleIndex)
      );
      quat = new Quaternion(qx, qy, qz, qw);
    } else {
      const anchor = bezierPath.getPoint(getAnchorPointIndexForHandle(bezierPath, selectedHandleIndex));
      const handle = bezierPath.getPoint(selectedHandleIndex);
      const dir = new Vector3(handle.x - anchor.x, handle.y - anchor.y, handle.z - anchor.z);
      if (dir.lengthSq() < 1e-10) {
        setHandleGizmoRotation([0, 0, 0]);
        return;
      }
      quat = new Quaternion().setFromUnitVectors(new Vector3(1, 0, 0), dir.normalize());
    }
    const euler = new Euler().setFromQuaternion(quat, "XYZ");
    setHandleGizmoRotation([euler.x, euler.y, euler.z]);
  }, [bezierPath, isTransforming, selectedHandleIndex, selectedHandleIsAnchor, useWorldSpaceGizmo, vertexPath]);

  return (
    <EditorHelpers>
      <PathVisual
        vertexPath={vertexPath}
        version={pathVersion}
        style={pathStyle}
        {...(railOptions && { railOptions })}
        color={pathStyle === "rail" ? t.rail : t.activeLine}
        tieColor={t.tie}
        lineWidth={pathStyle === "rail" ? 2 : 4}
        tieWidth={2}
      />
      {otherPaths.map(({ id, vertexPath: other }) => (
        <RigLine
          key={id}
          points={buildPathLinePoints(other)}
          color={t.inactiveLine}
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
        <lineBasicMaterial color={t.controlLine} />
      </lineSegments>

      {/* The rail already shows banking, so the normal indicators are redundant there. */}
      {pathStyle === "rail" ? null : (
        <lineSegments>
          <bufferGeometry>
            <bufferAttribute
              attach="attributes-position"
              args={[midpointNormalPositions, 3]}
              count={midpointNormalPositions.length / 3}
            />
          </bufferGeometry>
          <lineBasicMaterial color={t.midpointNormal} />
        </lineSegments>
      )}

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
              <meshBasicMaterial color={t.midpoint} transparent opacity={0} depthWrite={false} />
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
          onDragStart={() => setTransforming(true)}
          onDragEnd={() => setTransforming(false)}
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
            onRotateMidpointNormal?.(selectedMidpoint.segmentIndex, deltaDegrees);
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
        const color = isAnchor ? t.anchor : t.handle;
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
                  <meshBasicMaterial color={t.handleSelected} opacity={0.9} transparent depthTest={false} />
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
                  <meshBasicMaterial color={t.anchor} transparent opacity={0.55} side={2} />
                </mesh>
              ) : null}
              {isAnchor ? (
                <Text
                  position={[0, 0, 0.002]}
                  fontSize={0.09}
                  color={t.label}
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
                <meshBasicMaterial color={t.anchor} transparent opacity={0.65} side={2} />
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
                color={t.label}
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
                <meshBasicMaterial color={isAnchor ? t.anchorSelected : t.handleSelected} opacity={0.9} transparent side={2} />
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

            setTransforming(true);
          }}
          onDragEnd={() => {
            anchorDragStartRef.current = null;
            setTransforming(false);
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
              onSetAnchorScale?.(Math.floor(selectedHandleIndex / 3), uniformScale);
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
          onClearSelection?.();
        }}
      >
        <sphereGeometry args={[0.0001, 4, 4]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </EditorHelpers>
  );
}
