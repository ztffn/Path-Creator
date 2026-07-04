// Tests for the tracking-target seam: registry registration/unregistration,
// live pull-based resolution, weighted group centroids, and virtual camera
// look-at aims referencing targets by id through the resolve context. Pins
// the contract that lets vcams track arbitrary scene objects without knowing
// what they are.
import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { TargetRegistry, type Vec3 } from "../src/core";
import { resolveVirtualCameraDefinition } from "../src/three";

describe("TargetRegistry", () => {
  it("resolves the live position at query time", () => {
    const registry = new TargetRegistry();
    const position: Vec3 = { x: 1, y: 0, z: 0 };
    registry.register("ball", () => ({ ...position }), "Ball");

    expect(registry.resolve("ball")).toEqual({ x: 1, y: 0, z: 0 });
    position.x = 5;
    expect(registry.resolve("ball")).toEqual({ x: 5, y: 0, z: 0 });
  });

  it("unregisters via the returned disposer without clobbering replacements", () => {
    const registry = new TargetRegistry();
    const disposeOld = registry.register("t", () => ({ x: 1, y: 0, z: 0 }));
    registry.register("t", () => ({ x: 2, y: 0, z: 0 }));

    disposeOld();
    expect(registry.resolve("t")).toEqual({ x: 2, y: 0, z: 0 });
  });

  it("lists registered targets with display names", () => {
    const registry = new TargetRegistry();
    registry.register("a", () => null, "Target A");
    registry.register("b", () => null);

    expect(registry.list()).toEqual([
      { id: "a", name: "Target A" },
      { id: "b", name: "b" }
    ]);
  });

  it("resolves weighted group centroids, skipping unresolvable members", () => {
    const registry = new TargetRegistry();
    registry.register("a", () => ({ x: 0, y: 0, z: 0 }));
    registry.register("b", () => ({ x: 10, y: 0, z: 0 }));
    registry.register("gone", () => null);

    const centroid = registry.resolveGroup([
      { targetId: "a", weight: 1 },
      { targetId: "b", weight: 3 },
      { targetId: "gone", weight: 100 },
      { targetId: "missing", weight: 100 }
    ]);

    expect(centroid?.x).toBeCloseTo(7.5);
    expect(registry.resolveGroup([{ targetId: "missing", weight: 1 }])).toBeNull();
  });
});

describe("vcam aim by targetId", () => {
  const staticBody = {
    type: "static" as const,
    position: { x: 0, y: 0, z: 0 },
    quaternion: { x: 0, y: 0, z: 0, w: 1 }
  };

  it("orients toward a registry-resolved target", () => {
    const registry = new TargetRegistry();
    registry.register("ball", () => ({ x: 0, y: 0, z: -10 }));

    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "v",
        body: staticBody,
        aim: { type: "look-at", target: { targetId: "ball" } }
      },
      { getTargetPosition: (id) => registry.resolve(id) }
    );

    const q = snapshot!.quaternion;
    const look = new Vector3(0, 0, -1).applyQuaternion(new Quaternion(q.x, q.y, q.z, q.w));
    expect(look.z).toBeCloseTo(-1);
  });

  it("keeps the body orientation when the target is unresolvable", () => {
    const snapshot = resolveVirtualCameraDefinition(
      {
        id: "v",
        body: staticBody,
        aim: { type: "look-at", target: { targetId: "missing" } }
      },
      { getTargetPosition: () => null }
    );

    expect(snapshot?.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});
