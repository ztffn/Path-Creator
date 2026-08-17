// Renderer for `harness:marker`. `useRegistry` is the whole coupling to the time layer: once
// the node id is in `sceneRegistry`, a path-creator track drives this box without either side
// knowing about the other. Default export and lazy import are required by Pascal's renderer
// dispatch — a direct component reference is dropped with no warning.
// Scope: harness render layer.
import { useRef } from "react";
import { useRegistry } from "@pascal-app/core";
import type { Object3D } from "three";
import { MARKER_KIND, type MarkerNodeType } from "./kinds";

export default function MarkerRenderer({ node }: { node: MarkerNodeType }) {
  const ref = useRef<Object3D>(null!);
  useRegistry(node.id, MARKER_KIND, ref);

  return (
    <group
      name={node.name ?? node.id}
      position={node.position}
      ref={ref}
      visible={node.visible !== false}
    >
      <mesh castShadow receiveShadow>
        <boxGeometry args={[0.8, 0.8, 0.8]} />
        <meshStandardMaterial color={node.color} roughness={0.45} />
      </mesh>
    </group>
  );
}
