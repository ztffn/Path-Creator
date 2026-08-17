// The adapter under test: Pascal's scene registry expressed as a path-creator
// ObjectBindingResolver, so this library's track directors drive objects Pascal owns.
// Pascal's `sceneRegistry.nodes` is a documented "master lookup: ID -> Object3D"; this
// library's directors ask for exactly that, by id. If the spike survives, THIS file is the
// part with a promotion path — everything else here is throwaway harness.
import type { Object3D } from "three";
import type { ObjectAnimationBinding, ObjectBindingResolver } from "@huma/path-creator/three";

/**
 * The slice of Pascal's `sceneRegistry` this adapter needs. Declared structurally rather
 * than imported so the binding — and its tests — can run against a stand-in registry
 * without pulling Pascal's React/Three surface into a headless test.
 */
export interface PascalSceneRegistryLike {
  nodes: {
    get(id: string): Object3D | undefined;
  };
}

/**
 * Wraps Pascal's registry as a resolver this library's directors accept.
 *
 * `resolveAnimation` returns null unconditionally: Pascal has no AnimationMixer notion for
 * its nodes (its only animation surface is an export hook that bakes clips into a GLB), so
 * every transform track over a Pascal node is absolute or additive-over-nothing. If Pascal
 * later grows runtime clips, this is where they would be threaded through.
 */
export function pascalObjectBinding(registry: PascalSceneRegistryLike): ObjectBindingResolver {
  return {
    resolve: (id: string): Object3D | null => registry.nodes.get(id) ?? null,
    resolveAnimation: (): ObjectAnimationBinding | null => null
  };
}
