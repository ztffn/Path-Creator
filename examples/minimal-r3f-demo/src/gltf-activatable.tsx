// Loads an animated GLB and registers it as an activatable that also exposes its
// baked clips. drei's useGLTF gives { scene, animations }; we build one
// AnimationMixer per instance and pre-create (but do not start) an action per clip,
// so AnimationTrackDirector can play and blend clips at explicit local times without a
// play clock. Purely demo scaffolding — the GLB analogue of <Activatable>.
import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { AnimationMixer, Quaternion, Vector3, type AnimationAction, type Object3D } from "three";
import { Activatable, type AnimationFacet } from "./activatables";

export function GltfActivatable({
  id,
  src,
  name,
  selected = false,
  onSelect,
  position,
  scale,
  gizmoEnabled = false,
  onTransformingChange
}: {
  id: string;
  src: string;
  name?: string;
  selected?: boolean;
  onSelect?: () => void;
  position?: [number, number, number];
  scale?: number | [number, number, number];
  gizmoEnabled?: boolean;
  onTransformingChange?: (transforming: boolean) => void;
}) {
  const { scene, animations } = useGLTF(src);
  // One mixer bound to this scene; an action is created per clip but left stopped —
  // the director plays exactly one at a time and scrubs it via mixer.setTime.
  // Rebuilt if the cached scene/clips swap.
  const facet = useMemo<AnimationFacet>(() => {
    const mixer = new AnimationMixer(scene);
    const actions = new Map<string, AnimationAction>();
    for (const clip of animations) actions.set(clip.name, mixer.clipAction(clip));
    // Snapshot the bind pose of every animated node (skip the scene root; placement
    // lives on the Activatable group, not here) so leaving the timeline can restore
    // it instead of freezing mid-clip.
    const rest: { node: Object3D; position: Vector3; quaternion: Quaternion; scale: Vector3 }[] = [];
    scene.traverse((node) => {
      if (node !== scene) rest.push({ node, position: node.position.clone(), quaternion: node.quaternion.clone(), scale: node.scale.clone() });
    });
    const resetToRest = (): void => {
      for (const r of rest) {
        r.node.position.copy(r.position);
        r.node.quaternion.copy(r.quaternion);
        r.node.scale.copy(r.scale);
      }
    };
    return { mixer, actions, clips: animations.map((clip) => clip.name), resetToRest };
  }, [scene, animations]);
  useEffect(() => () => void facet.mixer.stopAllAction(), [facet]);
  // Placement goes on the Activatable group (the node the gizmo + transform tracks
  // drive); the model itself sits at local identity inside it.
  return (
    <Activatable
      id={id}
      {...(name !== undefined && { name })}
      selected={selected}
      {...(onSelect && { onSelect })}
      animation={facet}
      {...(position && { position })}
      {...(scale !== undefined && { scale })}
      gizmoEnabled={gizmoEnabled}
      {...(onTransformingChange && { onTransformingChange })}
    >
      <primitive object={scene} />
    </Activatable>
  );
}
