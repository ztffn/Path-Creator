// Q1 of the spike, headless: do this library's track directors drive objects held in a
// Pascal-shaped scene registry, and do they hand the pose back untouched on leave?
// Runs against a stand-in registry with the same contract as Pascal's `sceneRegistry`
// (a Map<string, Object3D> keyed by node id), so it answers the binding question without
// booting Pascal's viewer. Q2 — whether Pascal FIGHTS those writes — needs the real thing.
import { describe, expect, it } from "vitest";
import { Group, Object3D } from "three";
import { ActivationTrackDirector, TransformTrackDirector } from "@huma/path-creator/three";
import { pascalObjectBinding, type PascalSceneRegistryLike } from "./scene-binding";

/** Same shape as Pascal's registry: a plain id -> Object3D map at module scope. */
function registryWith(entries: Record<string, Object3D>): PascalSceneRegistryLike {
  const nodes = new Map(Object.entries(entries));
  return { nodes };
}

describe("path-creator tracks over a Pascal-shaped scene registry", () => {
  it("resolves a node id to the object Pascal registered", () => {
    const wall = new Group();
    const binding = pascalObjectBinding(registryWith({ "wall-1": wall }));
    expect(binding.resolve("wall-1")).toBe(wall);
    expect(binding.resolve("nope")).toBeNull();
    // Pascal has no runtime mixer for its nodes, so every track is absolute.
    expect(binding.resolveAnimation("wall-1")).toBeNull();
  });

  it("drives a transform track over a node and restores its pose on leave", () => {
    const item = new Group();
    item.position.set(1, 0, 3); // where Pascal placed it
    const binding = pascalObjectBinding(registryWith({ "item-7": item }));
    const director = new TransformTrackDirector();
    const tracks = [{
      type: "transform" as const,
      id: "lift",
      objectId: "item-7",
      position: [
        { time: 0, value: [1, 0, 3] as [number, number, number] },
        { time: 4, value: [1, 5, 3] as [number, number, number] }
      ]
    }];

    director.sync(binding, [{ tracks, time: 2 }], true);
    expect(item.position.toArray()).toEqual([1, 2.5, 3]); // halfway up the ramp

    // Leaving the timeline must hand Pascal back the pose it authored, or scrubbing would
    // silently rewrite the document's idea of where the item sits.
    director.sync(binding, [{ tracks, time: 2 }], false);
    expect(item.position.toArray()).toEqual([1, 0, 3]);
  });

  it("drives activation (visibility) over a node and reverts it", () => {
    const zone = new Group();
    const binding = pascalObjectBinding(registryWith({ "zone-2": zone }));
    const director = new ActivationTrackDirector();
    const layersAt = (time: number) => [{ tracks: [{
      type: "activation" as const,
      id: "reveal",
      objectId: "zone-2",
      clips: [{ id: "c", start: 0, end: 2 }],
      postPlaybackState: "revert" as const
    }], time }];

    director.sync(binding, layersAt(1), true, 4, 1, true);
    expect(zone.visible).toBe(true);
    director.sync(binding, layersAt(3), true, 4, 3, true);
    expect(zone.visible).toBe(false); // past the clip window
    director.sync(binding, layersAt(3), false, 4, 3, false);
    expect(zone.visible).toBe(true); // back to how Pascal had it
  });

  it("tolerates a node that Pascal has deleted mid-drive", () => {
    const nodes = new Map<string, Object3D>([["item-7", new Group()]]);
    const binding = pascalObjectBinding({ nodes });
    const director = new TransformTrackDirector();
    const tracks = [{
      type: "transform" as const, id: "lift", objectId: "item-7",
      position: [{ time: 0, value: [0, 0, 0] as [number, number, number] }]
    }];
    director.sync(binding, [{ tracks, time: 0 }], true);
    // Pascal owns the lifecycle: a node can vanish under a track that still references it.
    nodes.delete("item-7");
    expect(() => director.sync(binding, [{ tracks, time: 0 }], true)).not.toThrow();
    expect(() => director.sync(binding, [{ tracks, time: 0 }], false)).not.toThrow();
  });
});
