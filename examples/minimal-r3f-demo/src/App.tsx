import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Billboard, OrbitControls, PivotControls, TransformControls } from "@react-three/drei";
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
  applyDollyCamera,
  applySampleToObject,
  samplePathAtDistance,
  usePathFollower
} from "@huma/path-creator/r3f";
import { useEffect, useMemo, useRef, useState } from "react";
import { Euler, MOUSE, Matrix4, Quaternion, Vector3, type Mesh, type Object3D } from "three";

const STORAGE_KEY = "path-creator:minimal-demo:path";
type TransformMode = "translate" | "rotate" | "scale";

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

function buildPathLinePositions(path: BezierPath, samplesPerSegment = 24): Float32Array {
  const values: number[] = [];
  for (let segmentIndex = 0; segmentIndex < path.numSegments; segmentIndex += 1) {
    const startStep = segmentIndex === 0 ? 0 : 1;
    for (let step = startStep; step <= samplesPerSegment; step += 1) {
      const t = step / samplesPerSegment;
      const p = path.evaluate(segmentIndex, t);
      values.push(p.x, p.y, p.z);
    }
  }
  return new Float32Array(values);
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

function Scene({
  bezierPath,
  vertexPath,
  pathVersion,
  speed,
  cameraFollow,
  selectedHandleIndex,
  selectedMidpointIndex,
  transformMode,
  isTransforming,
  onSelectHandle,
  onSelectMidpoint,
  onMovePoint,
  onRotateMidpointNormal,
  onTransformingChange
}: {
  bezierPath: BezierPath;
  vertexPath: VertexPath;
  pathVersion: number;
  speed: number;
  cameraFollow: boolean;
  selectedHandleIndex: number | null;
  selectedMidpointIndex: number | null;
  transformMode: TransformMode;
  isTransforming: boolean;
  onSelectHandle: (index: number | null) => void;
  onSelectMidpoint: (index: number | null) => void;
  onMovePoint: (index: number, point: Vec3) => void;
  onRotateMidpointNormal: (segmentIndex: number, deltaDegrees: number) => void;
  onTransformingChange: (isTransforming: boolean) => void;
}) {
  const follower = usePathFollower({
    path: vertexPath,
    speed,
    mode: EndOfPathInstruction.Loop
  });

  const pathLinePositions = useMemo(
    () => buildPathLinePositions(bezierPath, 32),
    [bezierPath, pathVersion]
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
  const handleRefs = useRef<Array<Object3D | null>>([]);
  const { gl } = useThree();

  useEffect(() => {
    const onContextMenu = (e: Event) => e.preventDefault();
    gl.domElement.addEventListener("contextmenu", onContextMenu);
    return () => gl.domElement.removeEventListener("contextmenu", onContextMenu);
  }, [gl.domElement]);

  useFrame(({ camera, scene }, delta) => {
    const followerObject = scene.getObjectByName("follower") as Mesh | null;
    const sample = follower.step(delta);

    if (followerObject) {
      applySampleToObject(followerObject, sample);
    }

    if (cameraFollow && !isTransforming) {
      const lookSample = samplePathAtDistance(
        vertexPath,
        follower.state.current.distance + 0.6,
        EndOfPathInstruction.Loop
      );
      applyDollyCamera(camera, sample, lookSample.position, 8, delta);
    }
  });

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 4]} intensity={1.2} />

      <line>
        <bufferGeometry>
          <bufferAttribute
            attach="attributes-position"
            args={[pathLinePositions, 3]}
            count={pathLinePositions.length / 3}
          />
        </bufferGeometry>
        <lineBasicMaterial color="#101828" linewidth={2} />
      </line>

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

        if (!isAnchor) {
          return (
            <Billboard
              key={`handle-${i}`}
              ref={(el) => {
                handleRefs.current[i] = el;
              }}
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
            </group>
          );
        }

        return (
          <group
            key={`handle-${i}`}
            ref={(el) => {
              handleRefs.current[i] = el;
            }}
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

      {selectedHandleIndex !== null && handleRefs.current[selectedHandleIndex] ? (
        <TransformControls
          object={handleRefs.current[selectedHandleIndex]!}
          mode={transformMode}
          size={0.85}
          space="world"
          onMouseDown={() => onTransformingChange(true)}
          onMouseUp={() => onTransformingChange(false)}
          onObjectChange={() => {
            const obj = handleRefs.current[selectedHandleIndex];
            if (!obj) return;
            onMovePoint(selectedHandleIndex, {
              x: obj.position.x,
              y: obj.position.y,
              z: obj.position.z
            });
          }}
        />
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
    </>
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
  const [cameraFollow, setCameraFollow] = useState(false);
  const [isTransforming, setIsTransforming] = useState(false);
  const [selectedHandleIndex, setSelectedHandleIndex] = useState<number | null>(0);
  const [selectedMidpointIndex, setSelectedMidpointIndex] = useState<number | null>(null);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");

  const vertexPath = useMemo(
    () => new VertexPath(bezierPath, { spacing: 0.06 }),
    [bezierPath, pathVersion]
  );

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
      const lastAnchor = path.getAnchor(path.numAnchorPoints - 1);
      path.addSegmentToEnd({ x: lastAnchor.x + 1, y: lastAnchor.y, z: lastAnchor.z });
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
      setSelectedHandleIndex(0);
      setSelectedMidpointIndex(null);
      setPathVersion((v) => v + 1);
    } catch {
      // keep current path if local storage is invalid
    }
  }

  function resetPath(): void {
    setBezierPath(createDefaultBezier());
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
          Transform Mode
          <select
            style={{ marginLeft: 8 }}
            value={transformMode}
            onChange={(e) => setTransformMode(e.target.value as TransformMode)}
          >
            <option value="translate">Translate</option>
            <option value="rotate">Rotate</option>
            <option value="scale">Scale</option>
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

        <label style={{ display: "block" }}>
          <input
            type="checkbox"
            checked={cameraFollow}
            onChange={(e) => setCameraFollow(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Dolly Camera</span>
        </label>

        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 10 }}>
          Click a handle to select it, then edit via TransformControls gizmo.
          <br />
          Orbit: right-drag. Zoom: wheel. Pan: middle-drag.
          <br />
          Insert Midpoint splits the segment after selected anchor.
        </div>
      </div>

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
          pathVersion={pathVersion}
          speed={speed}
          cameraFollow={cameraFollow}
          selectedHandleIndex={selectedHandleIndex}
          selectedMidpointIndex={selectedMidpointIndex}
          transformMode={transformMode}
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
          onMovePoint={(index, point) => {
            mutatePath((path) => path.movePoint(index, point));
          }}
        />
      </Canvas>
    </div>
  );
}
