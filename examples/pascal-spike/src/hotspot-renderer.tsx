// The hotspot's 3D renderer, in its own module because Pascal's dispatch requires a
// `RendererSource` of kind 'parametric' whose `module` is a lazy import with a DEFAULT export —
// a plain component reference is silently dropped by `getRegistryRenderer`. Registering its
// group through `useRegistry` is what puts the hotspot into `sceneRegistry.nodes`, and so what
// makes a plugin-contributed node drivable by a path-creator track. Scope: spike harness.
import { useRef } from "react";
import { useRegistry } from "@pascal-app/core";
import type { Object3D } from "three";
import { hotspotClicks, type HotspotNodeType } from "./hotspot-schema";

export default function HotspotRenderer({ node }: { node: HotspotNodeType }) {
  const ref = useRef<Object3D>(null!);
  useRegistry(node.id, "huma:hotspot", ref);

  return (
    <group name={node.label} position={node.position} ref={ref} visible={node.visible !== false}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          hotspotClicks.push({ id: node.id, action: node.action });
        }}
      >
        <sphereGeometry args={[0.35, 20, 20]} />
        <meshStandardMaterial color="#ffb454" emissive="#7a4a10" roughness={0.4} />
      </mesh>
    </group>
  );
}
