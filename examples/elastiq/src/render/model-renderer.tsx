// Renderer for the `elastiq:model` node kind. Loads the GLB, applies the node's transform, and
// registers the group under the node id — that registration is the entire coupling to the
// timeline: once the id is in `sceneRegistry`, a path-creator track can drive this model
// without either side knowing about the other. Default export and lazy import are required by
// Pascal's renderer dispatch. Scope: prototype scene layer.
import { useMemo, useRef } from "react";
import { useGLTF } from "@react-three/drei";
import { useRegistry } from "@pascal-app/core";
import { MathUtils, type Object3D } from "three";
import type { ModelNodeType } from "./scene-kinds";

export default function ModelRenderer({ node }: { node: ModelNodeType }) {
  const ref = useRef<Object3D>(null!);
  useRegistry(node.id, "elastiq:model", ref);
  const { scene } = useGLTF(node.url);
  // Clone per node so the same GLB can be placed many times without sharing one Object3D.
  const model = useMemo(() => scene.clone(true), [scene]);

  return (
    <group
      name={node.name ?? node.id}
      position={node.position}
      ref={ref}
      rotation={node.rotationDeg.map(MathUtils.degToRad) as unknown as [number, number, number]}
      scale={node.scale}
      visible={node.visible !== false}
    >
      <primitive object={model} />
    </group>
  );
}
