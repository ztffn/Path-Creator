// Loads an animated GLB and registers it as an activatable that also exposes its
// baked clips. drei's useGLTF gives { scene, animations }; we build one
// AnimationMixer per instance and pre-create (but do not start) an action per clip,
// so the MixerDirector can play + drive any clip by time (mixer.setTime) without a
// play clock. Purely demo scaffolding — the GLB analogue of <Activatable>.
import { useEffect, useMemo } from "react";
import { useGLTF } from "@react-three/drei";
import { AnimationMixer, type AnimationAction } from "three";
import { Activatable, type AnimationFacet } from "./activatables";

export function GltfActivatable({
  id,
  src,
  name,
  selected = false,
  onSelect,
  position,
  scale
}: {
  id: string;
  src: string;
  name?: string;
  selected?: boolean;
  onSelect?: () => void;
  position?: [number, number, number];
  scale?: number | [number, number, number];
}) {
  const { scene, animations } = useGLTF(src);
  // One mixer bound to this scene; an action is created per clip but left stopped —
  // the director plays exactly one at a time and scrubs it via mixer.setTime.
  // Rebuilt if the cached scene/clips swap.
  const facet = useMemo<AnimationFacet>(() => {
    const mixer = new AnimationMixer(scene);
    const actions = new Map<string, AnimationAction>();
    for (const clip of animations) actions.set(clip.name, mixer.clipAction(clip));
    return { mixer, actions, clips: animations.map((clip) => clip.name) };
  }, [scene, animations]);
  useEffect(() => () => void facet.mixer.stopAllAction(), [facet]);
  return (
    <Activatable id={id} {...(name !== undefined && { name })} selected={selected} {...(onSelect && { onSelect })} animation={facet}>
      <primitive object={scene} {...(position && { position })} {...(scale !== undefined && { scale })} />
    </Activatable>
  );
}
