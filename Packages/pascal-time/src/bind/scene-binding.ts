// Pascal's scene registry expressed as a path-creator ObjectBindingResolver. This is the seam
// the whole integration rests on: Pascal's `sceneRegistry.nodes` is a documented "master lookup:
// ID -> Object3D", and path-creator's directors ask for exactly that, by id. Neither side is
// changed to meet the other — the shapes already matched, and this file is the proof.
// Scope: binding only; nothing here reads a track or a clock.
import { sceneRegistry } from "@pascal-app/core";
import type { Object3D } from "three";
import type { ObjectAnimationBinding, ObjectBindingResolver } from "@huma/path-creator/three";

/**
 * The slice of Pascal's `sceneRegistry` the adapter needs, declared structurally rather than
 * imported as a concrete type. That is not squeamishness about the dependency — it is what lets
 * a host bind a *subset* of the scene (one world, one level, a filtered view) by handing in any
 * id-to-object map, without this package having an opinion about where the map came from.
 */
export interface PascalSceneRegistryLike {
  nodes: {
    get(id: string): Object3D | undefined;
  };
}

/**
 * Wraps an id-to-object map as a resolver path-creator's directors accept.
 *
 * `resolveAnimation` returns null unconditionally, and that is a statement about Pascal rather
 * than a stub. Pascal has no runtime `AnimationMixer` for its nodes — its only animation surface
 * bakes clips into an exported GLB — so there is nothing for an additive transform track to
 * layer over, and every transform track over a Pascal node is absolute. Skinned GLB clip
 * playback stays path-creator's job, on objects it registers itself. If Pascal ever grows
 * runtime clips, this is the one function that has to change.
 */
export function pascalObjectBinding(registry: PascalSceneRegistryLike): ObjectBindingResolver {
  return {
    resolve: (id: string): Object3D | null => registry.nodes.get(id) ?? null,
    resolveAnimation: (): ObjectAnimationBinding | null => null
  };
}

/**
 * The binding over Pascal's own module-level registry — the one a host mounting Pascal's viewer
 * actually wants. It is a function rather than a constant so it is never captured before
 * Pascal's module has initialised.
 */
export function pascalSceneBinding(): ObjectBindingResolver {
  return pascalObjectBinding(sceneRegistry as PascalSceneRegistryLike);
}
