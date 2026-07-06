// P0.3 WebGPU validation surface (see GEOSPATIAL-INTEGRATION-DEBRIEF.md): mounts
// only the WebGPU-safe package visuals — PathVisual (dolly rail) + CartGizmo —
// under three's WebGPURenderer, to prove RigLine's thin-line path renders with no
// LineMaterial device loss. Deliberately excludes PivotControls and troika text
// (still WebGPU-unfinished). Run in a WebGPU browser to catch B-class regressions.
import { Canvas, extend } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { useMemo, useRef } from "react";
// three/webgpu re-exports core THREE plus the node materials + WebGPURenderer.
// extend() registers them as R3F JSX intrinsics so <lineBasicMaterial> etc. map
// to node-compatible materials on the WebGPU backend.
import * as THREE from "three/webgpu";
import {
  VertexPath,
  createPathCart,
  sampleCartFrame,
  type CartFrame
} from "@huma/path-creator/core";
import { CartGizmo, PathVisual, TransformGizmo } from "@huma/path-creator/r3f";

extend(THREE as unknown as Record<string, unknown>);

function Scene() {
  const path = useMemo(
    () =>
      new VertexPath(
        [
          { x: -2, y: 0, z: 0 },
          { x: -1, y: 0.4, z: 1.2 },
          { x: 1, y: 0.4, z: 1.2 },
          { x: 2, y: 0, z: 0 }
        ],
        [0, 1, 2, 3]
      ),
    []
  );

  // One static cart frame parked mid-rail, so CartGizmo's core edge lines render.
  const framesRef = useRef<Map<string, CartFrame>>(new Map());
  useMemo(() => {
    framesRef.current.set("cart", sampleCartFrame(path, createPathCart({}), path.length * 0.5));
  }, [path]);

  // Interactive drag test: TransformGizmo (WebGPU-safe) attached directly to a
  // root-level box — no rotated parent, so the axes are clean and it's a pure
  // "does the gizmo attach + drag on WebGPU" check.
  const boxMatrix = useMemo(() => new THREE.Matrix4().makeTranslation(0, 0.7, 1.6), []);

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[3, 4, 2]} intensity={1} />
      <PathVisual vertexPath={path} style="rail" color="#22c55e" tieColor="#15803d" />
      {/* No `name` → no troika text, so this validates only the WebGPU-safe lines. */}
      <CartGizmo framesRef={framesRef} cartId="cart" color="#e2e8f0" />
      <TransformGizmo matrix={boxMatrix} onDrag={() => {}}>
        <mesh>
          <boxGeometry args={[0.25, 0.25, 0.25]} />
          <meshStandardMaterial color="#f97316" emissive="#f97316" emissiveIntensity={0.3} />
        </mesh>
      </TransformGizmo>
    </>
  );
}

export function App() {
  return (
    <Canvas
      camera={{ position: [0, 2.5, 4], fov: 45 }}
      gl={async (props) => {
        const renderer = new THREE.WebGPURenderer(props as ConstructorParameters<typeof THREE.WebGPURenderer>[0]);
        await renderer.init();
        return renderer;
      }}
    >
      <color attach="background" args={["#0a101c"]} />
      <Scene />
      {/* Camera-only (no materials), so WebGPU-safe. makeDefault so the gizmo
          drag suppresses orbit. */}
      <OrbitControls makeDefault />
    </Canvas>
  );
}
