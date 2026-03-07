import { Canvas, useFrame } from "@react-three/fiber";
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
import { useMemo, useState } from "react";
import type { Mesh } from "three";

const STORAGE_KEY = "path-creator:minimal-demo:path";

function createDefaultBezier(): BezierPath {
  return new BezierPath(
    [
      { x: -2, y: 0, z: 0 },
      { x: -1, y: 1.1, z: 0 },
      { x: 1, y: 0.7, z: 0 },
      { x: 2, y: -0.1, z: 0 }
    ],
    {
      space: PathSpace.XY,
      controlMode: ControlMode.Automatic
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
  speed,
  cameraFollow,
  onMovePoint
}: {
  bezierPath: BezierPath;
  vertexPath: VertexPath;
  speed: number;
  cameraFollow: boolean;
  onMovePoint: (index: number, point: Vec3) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const follower = usePathFollower({
    path: vertexPath,
    speed,
    mode: EndOfPathInstruction.Loop
  });

  const pathLinePositions = useMemo(() => buildPathLinePositions(vertexPath), [vertexPath]);
  const controlLinePositions = useMemo(() => buildControlLinePositions(bezierPath), [bezierPath]);

  useFrame(({ camera, scene }, delta) => {
    const followerObject = scene.getObjectByName("follower") as Mesh | null;
    const sample = follower.step(delta);

    if (followerObject) {
      applySampleToObject(followerObject, sample);
    }

    if (cameraFollow) {
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

        return (
          <mesh
            key={`handle-${i}`}
            position={[p.x, p.y, p.z]}
            onPointerDown={(e) => {
              e.stopPropagation();
              if (draggable) {
                setDragIndex(i);
              }
            }}
          >
            <sphereGeometry args={[isAnchor ? 0.085 : 0.06, 16, 16]} />
            <meshStandardMaterial color={isAnchor ? "#f97316" : "#2563eb"} />
          </mesh>
        );
      })}

      <mesh
        position={[0, 0, 0]}
        onPointerMove={(e) => {
          if (dragIndex === null) return;
          onMovePoint(dragIndex, { x: e.point.x, y: e.point.y, z: 0 });
        }}
        onPointerUp={() => setDragIndex(null)}
        onPointerLeave={() => setDragIndex(null)}
      >
        <planeGeometry args={[200, 200]} />
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

  const vertexPath = useMemo(
    () => new VertexPath(bezierPath, { spacing: 0.06 }),
    [bezierPath, pathVersion]
  );

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
      path.addSegmentToEnd({ x: lastAnchor.x + 1, y: lastAnchor.y, z: 0 });
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
      setPathVersion((v) => v + 1);
    } catch {
      // keep current path if local storage is invalid
    }
  }

  function resetPath(): void {
    setBezierPath(createDefaultBezier());
    setPathVersion((v) => v + 1);
  }

  return (
    <>
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
          width: 340
        }}
      >
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>
          Path Editor (Minimal)
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button onClick={addAnchor}>Add Anchor</button>
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

        <label style={{ display: "block" }}>
          <input
            type="checkbox"
            checked={cameraFollow}
            onChange={(e) => setCameraFollow(e.target.checked)}
          />
          <span style={{ marginLeft: 6 }}>Dolly Camera</span>
        </label>

        <div style={{ fontSize: 12, opacity: 0.8, marginTop: 10 }}>
          Drag anchors/controls to modify the curve in real-time.
        </div>
      </div>

      <Canvas camera={{ position: [0, 0, 6], fov: 45 }}>
        <color attach="background" args={["#f8fafc"]} />
        <Scene
          bezierPath={bezierPath}
          vertexPath={vertexPath}
          speed={speed}
          cameraFollow={cameraFollow}
          onMovePoint={(index, point) => {
            mutatePath((path) => path.movePoint(index, point));
          }}
        />
      </Canvas>
    </>
  );
}
