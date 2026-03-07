import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, TransformControls } from "@react-three/drei";
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
import { MOUSE, type Mesh } from "three";

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

function buildPathLinePositions(path: VertexPath): Float32Array {
  const values: number[] = [];
  for (const p of path.localPoints) {
    values.push(p.x, p.y, p.z);
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

function Scene({
  bezierPath,
  vertexPath,
  pathVersion,
  speed,
  cameraFollow,
  selectedHandleIndex,
  transformMode,
  isTransforming,
  onSelectHandle,
  onMovePoint,
  onTransformingChange
}: {
  bezierPath: BezierPath;
  vertexPath: VertexPath;
  pathVersion: number;
  speed: number;
  cameraFollow: boolean;
  selectedHandleIndex: number | null;
  transformMode: TransformMode;
  isTransforming: boolean;
  onSelectHandle: (index: number | null) => void;
  onMovePoint: (index: number, point: Vec3) => void;
  onTransformingChange: (isTransforming: boolean) => void;
}) {
  const follower = usePathFollower({
    path: vertexPath,
    speed,
    mode: EndOfPathInstruction.Loop
  });

  const pathLinePositions = useMemo(() => buildPathLinePositions(vertexPath), [vertexPath]);
  const controlLinePositions = useMemo(
    () => buildControlLinePositions(bezierPath),
    [bezierPath, pathVersion]
  );
  const handleRefs = useRef<Array<Mesh | null>>([]);
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

      {Array.from({ length: bezierPath.numPoints }).map((_, i) => {
        const p = bezierPath.getPoint(i);
        const isAnchor = i % 3 === 0;
        const draggable = isAnchor || bezierPath.controlMode !== ControlMode.Automatic;
        const isSelected = selectedHandleIndex === i;
        const color = isAnchor ? "#f97316" : "#2563eb";

        if (!draggable) {
          return (
            <mesh key={`handle-${i}`} position={[p.x, p.y, p.z]}>
              <sphereGeometry args={[isAnchor ? 0.085 : 0.06, 16, 16]} />
              <meshStandardMaterial color={color} opacity={0.35} transparent />
            </mesh>
          );
        }

        return (
          <mesh
            key={`handle-${i}`}
            ref={(el) => {
              handleRefs.current[i] = el;
            }}
            position={[p.x, p.y, p.z]}
            onPointerDown={(e) => {
              e.stopPropagation();
              onSelectHandle(i);
            }}
          >
            <sphereGeometry args={[isSelected ? (isAnchor ? 0.095 : 0.07) : isAnchor ? 0.085 : 0.06, 16, 16]} />
            <meshStandardMaterial
              color={color}
              emissive={isSelected ? "#ffffff" : "#000000"}
              emissiveIntensity={isSelected ? 0.15 : 0}
            />
          </mesh>
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

  function addAnchor(): void {
    mutatePath((path) => {
      if (path.isClosed) {
        path.setClosed(false);
      }
      const lastAnchor = path.getAnchor(path.numAnchorPoints - 1);
      path.addSegmentToEnd({ x: lastAnchor.x + 1, y: lastAnchor.y, z: lastAnchor.z });
      setSelectedHandleIndex(path.numPoints - 1);
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
      setPathVersion((v) => v + 1);
    } catch {
      // keep current path if local storage is invalid
    }
  }

  function resetPath(): void {
    setBezierPath(createDefaultBezier());
    setSelectedHandleIndex(0);
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
          transformMode={transformMode}
          isTransforming={isTransforming}
          onSelectHandle={setSelectedHandleIndex}
          onTransformingChange={setIsTransforming}
          onMovePoint={(index, point) => {
            mutatePath((path) => path.movePoint(index, point));
          }}
        />
      </Canvas>
    </div>
  );
}
