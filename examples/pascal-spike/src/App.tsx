// Q2 harness: drive a timeline over objects held in a Pascal-shaped registry and measure,
// every frame, whether anything else rewrote the pose we wrote. Runs today against a
// stand-in registry as the control (drift must read zero); swapping `useRegistry` for
// Pascal's exported `sceneRegistry` is the one-line change that makes the number mean
// something. Scope: throwaway spike harness — see README.md for what it is answering.
import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Grid, OrbitControls } from "@react-three/drei";
import { Vector3, type Object3D } from "three";
import { TransformTrackDirector } from "@huma/path-creator/three";
import type { TransformTrack } from "@huma/path-creator/core";
import { pascalObjectBinding, type PascalSceneRegistryLike } from "./pascal-binding";

const DRIVEN_ID = "item-7";
const CYCLE_SECONDS = 6;

/**
 * Stands in for Pascal's module-level `sceneRegistry`. Same contract — a live map from node
 * id to Object3D that the renderer populates as it mounts nodes. To run the real test,
 * replace this with `import { sceneRegistry } from "@pascal-app/core"`, whose `nodes` is a
 * Map subclass and so satisfies this shape directly.
 */
interface StandInRegistry {
  nodes: Map<string, Object3D>;
  register(id: string, object: Object3D): () => void;
}

function useRegistry(): StandInRegistry {
  return useMemo(() => {
    const nodes = new Map<string, Object3D>();
    return {
      nodes,
      register(id, object) {
        nodes.set(id, object);
        return () => { if (nodes.get(id) === object) nodes.delete(id); };
      }
    };
  }, []);
}

/** A "node": something the scene editor owns and placed. We only borrow it. */
function Node({
  id, registry, position, color
}: {
  id: string;
  registry: ReturnType<typeof useRegistry>;
  position: [number, number, number];
  color: string;
}) {
  const ref = useRef<Object3D>(null);
  useEffect(() => (ref.current ? registry.register(id, ref.current) : undefined), [id, registry]);
  return (
    <mesh ref={ref as never} position={position} castShadow receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

/** The measurement: how far the pose moved between our write and our next read. */
function Driver({
  registry, onSample
}: {
  registry: PascalSceneRegistryLike;
  onSample: (drift: number, t: number) => void;
}) {
  const binding = useMemo(() => pascalObjectBinding(registry), [registry]);
  const director = useMemo(() => new TransformTrackDirector(), []);
  const written = useRef<Vector3 | null>(null);
  const elapsed = useRef(0);

  const tracks = useMemo<TransformTrack[]>(() => [{
    type: "transform",
    id: "orbit-lift",
    objectId: DRIVEN_ID,
    position: [
      { time: 0, value: [0, 0.5, 0] },
      { time: CYCLE_SECONDS / 2, value: [0, 3.5, 0] },
      { time: CYCLE_SECONDS, value: [0, 0.5, 0] }
    ]
  }], []);

  useFrame((_, delta) => {
    const object = registry.nodes.get(DRIVEN_ID);
    // Read BEFORE writing: anything that moved this object since our last write — the host
    // re-rendering from its own node data, a competing system — shows up as drift here.
    if (object && written.current) onSample(object.position.distanceTo(written.current), elapsed.current);

    elapsed.current = (elapsed.current + delta) % CYCLE_SECONDS;
    director.sync(binding, [{ tracks, time: elapsed.current }], true);

    if (object) written.current = object.position.clone();
  });

  useEffect(() => () => director.sync(binding, [], false), [director, binding]);
  return null;
}

export default function App() {
  const registry = useRegistry();
  const [drift, setDrift] = useState({ worst: 0, last: 0, samples: 0 });

  return (
    <div style={{ position: "fixed", inset: 0 }}>
      <Canvas shadows camera={{ position: [7, 5, 7], fov: 45 }}>
        <hemisphereLight args={[0xffffff, 0x334455, 0.9]} />
        <directionalLight position={[6, 12, 8]} intensity={1.3} castShadow />
        <Grid args={[30, 30]} cellColor="#2a3340" sectionColor="#3a4657" infiniteGrid fadeDistance={30} />
        <Node id="wall-1" registry={registry} position={[-2.5, 0.5, 0]} color="#3b4a5a" />
        <Node id={DRIVEN_ID} registry={registry} position={[0, 0.5, 0]} color="#c07a3e" />
        <Node id="zone-2" registry={registry} position={[2.5, 0.5, 0]} color="#3b4a5a" />
        <Driver
          registry={registry}
          onSample={(d) => setDrift((prev) => ({ worst: Math.max(prev.worst, d), last: d, samples: prev.samples + 1 }))}
        />
        <OrbitControls makeDefault />
      </Canvas>

      <div style={{
        position: "absolute", top: 16, left: 16, maxWidth: 420, padding: "12px 14px",
        borderRadius: 10, background: "rgba(20,26,34,0.85)", color: "#e6edf3",
        font: "12px/1.6 ui-monospace, SFMono-Regular, monospace"
      }}>
        <div style={{ font: "600 13px ui-sans-serif, system-ui", marginBottom: 6 }}>
          Q2 — does the scene owner fight our writes?
        </div>
        <div>registry holds: {[...registry.nodes.keys()].join(", ") || "…"}</div>
        <div>driving: {DRIVEN_ID}</div>
        <div>drift this frame: {drift.last.toFixed(6)}</div>
        <div>worst drift: {drift.worst.toFixed(6)} over {drift.samples} frames</div>
        <div style={{ marginTop: 8, opacity: 0.75, font: "11px/1.5 ui-sans-serif, system-ui" }}>
          Zero is the control — nothing else owns these objects yet. Swap `useRegistry` for
          Pascal's `sceneRegistry` and a non-zero worst drift means the two systems are
          fighting over the same transform.
        </div>
      </div>
    </div>
  );
}
