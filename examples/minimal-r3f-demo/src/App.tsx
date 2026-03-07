import { Canvas, useFrame } from "@react-three/fiber";
import { EndOfPathInstruction, VertexPath } from "@huma/path-creator/core";
import { updateFollowerState } from "@huma/path-creator/r3f";
import { useRef } from "react";
import type { Mesh } from "three";

const simplePath = new VertexPath(
  [
    { x: -2, y: 0, z: 0 },
    { x: 0, y: 1, z: 0 },
    { x: 2, y: 0, z: 0 }
  ],
  [0, 2, 4]
);

function Follower() {
  const meshRef = useRef<Mesh>(null);
  const state = useRef({ distance: 0 });

  useFrame((_, delta) => {
    state.current = updateFollowerState(
      state.current,
      1,
      delta,
      simplePath,
      EndOfPathInstruction.Loop
    );

    const d = state.current.distance;
    const t = d / simplePath.length;
    const x = -2 + 4 * t;
    const y = Math.sin(t * Math.PI) * 1;

    if (meshRef.current) {
      meshRef.current.position.set(x, y, 0);
    }
  });

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[0.15, 16, 16]} />
      <meshStandardMaterial color="#eb5e28" />
    </mesh>
  );
}

export function App() {
  return (
    <Canvas camera={{ position: [0, 0, 5], fov: 45 }}>
      <color attach="background" args={["#f7f5f2"]} />
      <ambientLight intensity={0.6} />
      <directionalLight position={[2, 3, 4]} intensity={1.2} />
      <Follower />
    </Canvas>
  );
}
