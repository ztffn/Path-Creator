// Renderer for the `elastiq:hotspot` node kind. Registers under the node id like every other kind,
// so a hotspot is drivable by the timeline exactly as a model is, and pushes its opaque action
// payload on click for the product layer to interpret. Default export + lazy import are required
// by Pascal's renderer dispatch — a direct component reference is dropped silently.
// Scope: prototype scene layer.
import { useRef } from "react";
import { useRegistry } from "@pascal-app/core";
import type { Object3D } from "three";
import { hotspotClicks, type HotspotNodeType } from "./scene-kinds";

export default function HotspotRenderer({ node }: { node: HotspotNodeType }) {
  const ref = useRef<Object3D>(null!);
  useRegistry(node.id, "elastiq:hotspot", ref);

  return (
    <group name={node.label} position={node.position} ref={ref} visible={node.visible !== false}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          hotspotClicks.push({ id: node.id, action: node.action });
        }}
      >
        <sphereGeometry args={[0.3, 20, 20]} />
        <meshStandardMaterial color="#ffb454" emissive="#7a4a10" roughness={0.4} />
      </mesh>
    </group>
  );
}
