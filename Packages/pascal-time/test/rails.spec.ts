// M1.7: rails. A path is a Pascal node whose points are LOCAL, a cart names its path by id, and a
// cart-bodied shot rides it — with the ride itself owned by a cart track, so the camera's position
// at time t comes out of the library's evaluator rather than out of anything here. The claims that
// matter: the world-matrix bake (which is what lets Pascal's own gizmo move a whole rail), the
// tolerance the authoring loop needs where the library's own rig builder throws, and the remap.
import { beforeEach, describe, expect, it } from "vitest";
import { Matrix4, Object3D, PerspectiveCamera } from "three";
import { sceneRegistry, useScene } from "@pascal-app/core";
import * as coreLayers from "@huma/path-creator/three";
import {
  buildCartNode,
  buildPathNode,
  buildShotNode,
  buildTimelineNode,
  createPluginNode,
  installPascalTimeOnScene,
  PascalCameraDirector,
  putTrack,
  readCarts,
  readPaths,
  readRig,
  readShotDefinitions,
  readShots,
  readTimeline,
  PASCAL_OVERLAY_LAYER,
  registerPascalTimeKinds,
  remapRailsAfterClone,
  // the pure point/run arithmetic
  anchorAt,
  anchorCount,
  cartTrackSpan,
  dollyRunEasing,
  newDollyRun,
  retimeCartTrack,
  starterRailPoints,
  withAppendedAnchor,
  withDollyRunEasing,
  withoutAnchor
} from "../src/index";

const CLOCK = "humatime_clock";

/** A straight rail from the origin to +10 on X: two anchors, four interleaved points. */
const STRAIGHT_RAIL = [
  { x: 0, y: 0, z: 0 },
  { x: 3, y: 0, z: 0 },
  { x: 7, y: 0, z: 0 },
  { x: 10, y: 0, z: 0 }
];

function freshScene(): void {
  useScene.getState().clearScene();
  useScene.temporal.getState().clear();
  sceneRegistry.clear();
  installPascalTimeOnScene();
  createPluginNode(buildTimelineNode({ id: CLOCK, durationSeconds: 10 }));
}

function authorRail(pathOverrides: Record<string, unknown> = {}): void {
  createPluginNode(
    buildPathNode({ id: "rail", name: "Rail", points: STRAIGHT_RAIL, ...pathOverrides })
  );
  createPluginNode(
    buildCartNode({ id: "cart", name: "Cart", timelineId: CLOCK, pathId: "rail" })
  );
}

beforeEach(() => {
  registerPascalTimeKinds();
  freshScene();
});

// ---------------------------------------------------------------- reading the rails

describe("a path node is the library's path definition", () => {
  it("its points are read out in the shape BezierPath.fromJSON takes", () => {
    authorRail();
    const [path] = readPaths();
    expect(path!.definition.bezier.points).toEqual(STRAIGHT_RAIL);
    expect(path!.definition.bezier.controlMode).toBe("automatic");
    expect(path!.definition.sampling).toEqual({ maxAngleError: 0.3, minVertexDistance: 0.01 });
  });

  it("spacing 0 is omitted rather than passed through", () => {
    // 0 means adaptive. Passing it to VertexPath would ask for a vertex every zero metres.
    authorRail({ spacing: 0 });
    expect(readPaths()[0]!.definition.sampling).not.toHaveProperty("spacing");
    useScene.getState().updateNode("rail" as never, { spacing: 0.5 } as never);
    expect(readPaths()[0]!.definition.sampling).toHaveProperty("spacing", 0.5);
  });

  it("the node's WORLD matrix is baked into the points — the whole rail moves with the node", () => {
    // This is why Pascal's own move gizmo can drag a rail: the points stay local, and the bake
    // hands the library a world-space path so no rig transform has to exist anywhere.
    authorRail();
    const moved = new Matrix4().makeTranslation(0, 5, -2);
    const [path] = readPaths(() => ({ elements: moved.elements }));
    expect(path!.definition.bezier.points[0]).toEqual({ x: 0, y: 5, z: -2 });
    expect(path!.definition.bezier.points[3]).toEqual({ x: 10, y: 5, z: -2 });
  });

  it("with no live object it falls back to the node's own position", () => {
    // A path read before its renderer has mounted (first frame, a headless test) still resolves.
    authorRail({ position: [1, 2, 3] });
    const [path] = readPaths();
    expect(path!.definition.bezier.points[0]).toEqual({ x: 1, y: 2, z: 3 });
  });

  it("a cart reads out as the library's cart definition, naming its path", () => {
    authorRail();
    const [cart] = readCarts(CLOCK);
    expect(cart!.definition.pathId).toBe("rail");
    expect(cart!.definition.orientationMode).toBe("path-frame");
    expect(cart!.definition.endOfPathInstruction).toBe("loop");
  });
});

// ---------------------------------------------------------------- the rig, and its tolerance

describe("the rig is built tolerantly, where the library's own builder throws", () => {
  it("a rail and its cart become a real rig", () => {
    authorRail();
    const rig = readRig();
    expect(rig.paths.get("rail")).toBeDefined();
    expect(rig.carts.get("cart")).toBeDefined();
    expect(rig.cartPaths.get("cart")).toBe("rail");
    // Measured along the vertex path, not the chord — a straight rail is the case where the two
    // agree, which is exactly why it is the fixture.
    expect(rig.paths.get("rail")!.length).toBeCloseTo(10, 1);
  });

  it("a cart naming a path that does not exist is SKIPPED, not thrown", () => {
    // buildRigRuntime throws here, which is right for a finished document loaded whole and wrong
    // mid-edit: a cart exists for a moment before its path is chosen, and a path can be deleted
    // while a cart still names it. Throwing would take the viewer down during authoring.
    createPluginNode(buildCartNode({ id: "orphan", timelineId: CLOCK, pathId: "nothing" }));
    const rig = readRig();
    expect(rig.carts.has("orphan")).toBe(false);
    expect(rig.paths.size).toBe(0);
  });

  it("a path with no segment yet is skipped — an author's first click has one point", () => {
    createPluginNode(buildPathNode({ id: "half", points: [{ x: 0, y: 0, z: 0 }] }));
    expect(readRig().paths.has("half")).toBe(false);
  });
});

// ---------------------------------------------------------------- the ride

describe("a cart-bodied shot rides its rail", () => {
  function authorRidingShot(keys: { time: number; distance: number; easing?: string }[]): void {
    authorRail();
    createPluginNode(
      buildShotNode({
        id: "riding",
        name: "Riding",
        timelineId: CLOCK,
        timeSeconds: 0,
        blendSeconds: 0,
        body: "cart",
        cartId: "cart"
      })
    );
    putTrack(CLOCK, { type: "cart", id: "run", cartId: "cart", keys });
  }

  const driveAt = (director: PascalCameraDirector, camera: PerspectiveCamera, time: number) =>
    director.sync(camera, {
      timeline: readTimeline(CLOCK)!,
      vcams: readShotDefinitions(CLOCK),
      rig: readRig(),
      time
    });

  it("the shot's body reads out as the library's cart body", () => {
    authorRidingShot([{ time: 0, distance: 0 }]);
    expect(readShots(CLOCK)[0]!.definition.body).toEqual({
      type: "cart",
      cartId: "cart",
      positionOffset: { x: 0, y: 0, z: 0 }
    });
  });

  it("the camera moves along the rail between the run's two keys", () => {
    authorRidingShot([
      { time: 0, distance: 0, easing: "linear" },
      { time: 10, distance: 10 }
    ]);
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();

    const at = (time: number): number => driveAt(director, camera, time)!.snapshot.position.x;
    expect(at(0)).toBeCloseTo(0, 1);
    expect(at(5)).toBeCloseTo(5, 1);
    expect(at(9.9)).toBeCloseTo(9.9, 1);
  });

  it("a run that ends AT the rail's length wraps to the start, because the cart loops", () => {
    // Not a rounding artefact and worth pinning: `endOfPathInstruction` defaults to `loop`, and
    // distance 10 on a 10 m rail resolves to 0. A run meant to stop at the end wants `stop`.
    authorRidingShot([
      { time: 0, distance: 0, easing: "linear" },
      { time: 10, distance: 10 }
    ]);
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();
    expect(driveAt(director, camera, 10)!.snapshot.position.x).toBeCloseTo(0, 5);

    useScene.getState().updateNode("cart" as never, { endOfPathInstruction: "stop" } as never);
    expect(driveAt(director, camera, 10)!.snapshot.position.x).toBeCloseTo(10, 5);
  });

  it("a cart key's easing shapes the segment AFTER it, not into it", () => {
    // The asymmetry that will bite anyone reading this alongside the transform tracks:
    // `TransformKey.easing` eases INTO its key, `CartKey.easing` eases OUT of it. So a run's
    // profile lives on its FIRST key, and the panel writes it there.
    authorRidingShot([
      { time: 0, distance: 0, easing: "easeInOut" },
      { time: 10, distance: 10 }
    ]);
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();
    // easeInOut is slow off the mark, so a quarter of the way through it is behind linear's 2.5.
    expect(driveAt(director, camera, 2.5)!.snapshot.position.x).toBeLessThan(2.4);
  });

  it("CONTROL: the same easing on the LAST key changes nothing", () => {
    // Which is how the asymmetry above hides: putting the curve on the wrong key is not an
    // error, it is a run that quietly stays linear.
    authorRidingShot([
      { time: 0, distance: 0 },
      { time: 10, distance: 10, easing: "easeInOut" }
    ]);
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();
    expect(driveAt(director, camera, 2.5)!.snapshot.position.x).toBeCloseTo(2.5, 5);
  });

  it("a rail's transform is a SEPARATE signal from the document — it lags one frame behind it", () => {
    // The bug this pins, measured in the browser: moving a path node replaces the nodes map, but
    // the live object's matrixWorld is only recomposed during the render that follows. A rig cached
    // on the document-change frame therefore bakes the OLD transform, and because its cache key
    // was satisfied it never re-bakes — the cart stays where it was, permanently. So the driver
    // watches the rail transforms too, and this is the shape of the staleness it watches for.
    authorRail();
    const live = new Object3D();
    live.updateMatrixWorld(true);
    sceneRegistry.nodes.set("rail" as never, live as never);

    const railAt = (): number =>
      readRig(() => ({ elements: live.matrixWorld.elements })).paths.get("rail")!.getPointAtTime(0).y;
    expect(railAt()).toBeCloseTo(0, 6);

    // The document says one thing...
    useScene.getState().updateNode("rail" as never, { position: [0, 9, 0] } as never);
    // ...and until the object catches up, a world-matrix bake still reads the old place. Which is
    // exactly why the rebuild cannot be keyed on the document alone.
    expect(railAt()).toBeCloseTo(0, 6);

    live.position.set(0, 9, 0);
    live.updateMatrixWorld(true);
    expect(railAt()).toBeCloseTo(9, 6);
  });

  it("the rail is dragged by the node, and the shot follows with no timeline edit", () => {
    // The seam paying for itself again: a cart-bodied shot names a cart, the cart names a rail,
    // and the rail's world matrix is the author's to move.
    authorRidingShot([
      { time: 0, distance: 0, easing: "linear" },
      { time: 10, distance: 10 }
    ]);
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();
    const before = driveAt(director, camera, 5)!.snapshot.position;

    useScene.getState().updateNode("rail" as never, { position: [0, 7, 0] } as never);
    const after = director.sync(camera, {
      timeline: readTimeline(CLOCK)!,
      vcams: readShotDefinitions(CLOCK),
      rig: readRig(),
      time: 5
    })!.snapshot.position;

    expect(after.y - before.y).toBeCloseTo(7, 5);
    expect(after.x).toBeCloseTo(before.x, 5);
  });

  it("cart frames are reported even with no camera on the rail", () => {
    // The gizmos ride these, and a scene can have a moving cart nobody films.
    authorRail();
    putTrack(CLOCK, {
      type: "cart",
      id: "run",
      cartId: "cart",
      keys: [
        { time: 0, distance: 0, easing: "linear" },
        { time: 10, distance: 10 }
      ]
    });
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();
    // No shot at all, so sync returns null — and the frames are still there.
    expect(driveAt(director, camera, 5)).toBeNull();
    const frame = director.frames().get("cart");
    expect(frame).toBeDefined();
    expect(frame!.position.x).toBeCloseTo(5, 1);
  });

  it("evaluating is scrub-exact — a cart is positioned from t, never stepped", () => {
    authorRidingShot([
      { time: 0, distance: 0, easing: "easeInOut" },
      { time: 10, distance: 10 }
    ]);
    const director = new PascalCameraDirector();
    const camera = new PerspectiveCamera();
    const first = { ...driveAt(director, camera, 3.7)!.snapshot.position };
    driveAt(director, camera, 0);
    driveAt(director, camera, 9);
    expect({ ...driveAt(director, camera, 3.7)!.snapshot.position }).toEqual(first);
  });
});

// ---------------------------------------------------------------- the clone remap (R8)

describe("cloning rebinds rail references only when the target came along", () => {
  it("a cart cloned WITH its rail rides the copy", () => {
    authorRail();
    createPluginNode(buildPathNode({ id: "rail_copy", points: STRAIGHT_RAIL }));
    createPluginNode(buildCartNode({ id: "cart_copy", timelineId: CLOCK, pathId: "rail" }));

    const rebound = remapRailsAfterClone(
      new Map([
        ["rail", "rail_copy"],
        ["cart", "cart_copy"]
      ])
    );
    expect(rebound).toBe(1);
    expect(readCarts(CLOCK).find((c) => c.id === "cart_copy")!.definition.pathId).toBe("rail_copy");
  });

  it("a cart cloned ALONE keeps riding the original rail", () => {
    // Two carts on one rail is a reasonable thing to author, so this must not be rewritten.
    authorRail();
    createPluginNode(buildCartNode({ id: "cart_copy", timelineId: CLOCK, pathId: "rail" }));
    expect(remapRailsAfterClone(new Map([["cart", "cart_copy"]]))).toBe(0);
    expect(readCarts(CLOCK).find((c) => c.id === "cart_copy")!.definition.pathId).toBe("rail");
  });

  it("a cloned cart-bodied shot rides the cloned cart", () => {
    authorRail();
    createPluginNode(
      buildShotNode({ id: "shot", timelineId: CLOCK, body: "cart", cartId: "cart" })
    );
    createPluginNode(buildCartNode({ id: "cart_copy", timelineId: CLOCK, pathId: "rail" }));
    createPluginNode(
      buildShotNode({ id: "shot_copy", timelineId: CLOCK, body: "cart", cartId: "cart" })
    );

    expect(
      remapRailsAfterClone(
        new Map([
          ["cart", "cart_copy"],
          ["shot", "shot_copy"]
        ])
      )
    ).toBe(1);
    expect(
      readShots(CLOCK).find((s) => s.id === "shot_copy")!.definition.body
    ).toMatchObject({ cartId: "cart_copy" });
  });

  it("the remap lands as ONE store operation, so it is one undo step with the clone", () => {
    authorRail();
    createPluginNode(buildPathNode({ id: "rail_copy", points: STRAIGHT_RAIL }));
    createPluginNode(buildCartNode({ id: "cart_copy", timelineId: CLOCK, pathId: "rail" }));
    createPluginNode(
      buildShotNode({ id: "shot_copy", timelineId: CLOCK, body: "cart", cartId: "cart" })
    );
    createPluginNode(buildCartNode({ id: "cart2", timelineId: CLOCK, pathId: "rail" }));

    const depth = (): number => useScene.temporal.getState().pastStates.length;
    const before = depth();
    const rebound = remapRailsAfterClone(
      new Map([
        ["rail", "rail_copy"],
        ["cart", "cart_copy"],
        ["cart2", "cart_copy"]
      ])
    );
    expect(rebound).toBeGreaterThan(0);
    // Pascal's undo is granular over store OPERATIONS, so N rebound nodes must still be 1 step.
    expect(depth() - before).toBe(1);
  });
});

// ---------------------------------------------------------------- the pure point arithmetic

describe("the point list is edited purely, and the index arithmetic is the risky part", () => {
  const P = (x: number): { x: number; y: number; z: number } => ({ x, y: 0, z: 0 });

  it("a starter rail has a real segment, so it is samplable the moment it exists", () => {
    // A one-point path is skipped by the rig builder, so an author who saw nothing could not tell
    // "not drawn yet" from "broken".
    const points = starterRailPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 6);
    expect(points).toHaveLength(4);
    expect(anchorCount(points)).toBe(2);
    expect(points[0]!.x).toBeCloseTo(-3, 6);
    expect(points[3]!.x).toBeCloseTo(3, 6);
  });

  it("a zero-length direction falls back to +X rather than producing NaN", () => {
    const points = starterRailPoints({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 8);
    expect(points.every((p) => Number.isFinite(p.x))).toBe(true);
    expect(points[3]!.x).toBeCloseTo(4, 6);
  });

  it("appending an anchor adds exactly one anchor and keeps the join smooth", () => {
    const start = starterRailPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 6);
    const grown = withAppendedAnchor(start, { x: 9, y: 0, z: 0 });
    expect(anchorCount(grown)).toBe(3);
    expect(anchorAt(grown, 2)).toEqual({ x: 9, y: 0, z: 0 });
    // The new incoming control mirrors the old outgoing one through the shared anchor, so the
    // tangent is continuous across the join rather than kinked.
    const anchor = start[3]!;
    const previousControl = start[2]!;
    expect(grown[4]!.x).toBeCloseTo(anchor.x * 2 - previousControl.x, 6);
  });

  it("appending never mutates its input", () => {
    // Pascal's undo snapshot aliases the stored array, so an in-place push corrupts the past.
    const start = starterRailPoints({ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, 6);
    const before = JSON.stringify(start);
    withAppendedAnchor(start, { x: 9, y: 0, z: 0 });
    expect(JSON.stringify(start)).toBe(before);
  });

  it("removing an anchor drops it and its own controls, wherever it sits", () => {
    // a0 c0 c1 a1 c2 c3 a2 — three anchors, seven points.
    const three = [P(0), P(1), P(2), P(3), P(4), P(5), P(6)];
    expect(anchorCount(three)).toBe(3);

    // First: loses the two controls that follow it.
    expect(withoutAnchor(three, 0).map((p) => p.x)).toEqual([3, 4, 5, 6]);
    // Last: loses the two before it.
    expect(withoutAnchor(three, 2).map((p) => p.x)).toEqual([0, 1, 2, 3]);
    // Interior: one control from either side.
    const four = [P(0), P(1), P(2), P(3), P(4), P(5), P(6), P(7), P(8), P(9)];
    expect(withoutAnchor(four, 1).map((p) => p.x)).toEqual([0, 1, 5, 6, 7, 8, 9]);
  });

  it("every removal leaves a list that still parses as a bezier", () => {
    const four = [P(0), P(1), P(2), P(3), P(4), P(5), P(6), P(7), P(8), P(9)];
    for (const index of [0, 1, 2, 3]) {
      const left = withoutAnchor(four, index);
      expect(anchorCount(left)).toBe(3);
      expect(left).toHaveLength(7);
    }
  });

  it("a two-anchor rail refuses to lose one — one anchor is not a rail", () => {
    const two = [P(0), P(1), P(2), P(3)];
    expect(withoutAnchor(two, 0)).toEqual(two);
    expect(withoutAnchor(two, 1)).toEqual(two);
  });
});

describe("a dolly run is created with its profile on the key that shapes it", () => {
  it("a fresh run rides the whole rail, eased from the first key", () => {
    const run = newDollyRun("cart", 12, 2, 4, "easeInOut");
    expect(run.keys).toEqual([
      { time: 2, distance: 0, easing: "easeInOut" },
      { time: 6, distance: 12 }
    ]);
  });

  it("reading and rewriting a run's profile both use the first key", () => {
    const run = newDollyRun("cart", 10, 0, 4, "easeInOut");
    expect(dollyRunEasing(run)).toBe("easeInOut");
    const relaxed = withDollyRunEasing(run, "linear");
    expect(dollyRunEasing(relaxed)).toBe("linear");
    // And the original is untouched.
    expect(dollyRunEasing(run)).toBe("easeInOut");
  });

  it("retiming a run moves WHEN, never WHERE", () => {
    const run = newDollyRun("cart", 10, 0, 4, "linear");
    const later = retimeCartTrack(run, 5, 15);
    expect(later.keys.map((k) => k.time)).toEqual([5, 15]);
    // Distances untouched: resizing a move changes the cart's speed, which is what dragging a
    // block's edge on a dolly lane means.
    expect(later.keys.map((k) => k.distance)).toEqual([0, 10]);
    expect(cartTrackSpan(later)).toEqual({ start: 5, end: 15 });
  });
});

// ---------------------------------------------------------------- the overlay's layer

describe("the rail handles render on Pascal's own overlay layer", () => {
  it("PASCAL_OVERLAY_LAYER matches @pascal-app/viewer's export", async () => {
    // Declared locally so the runtime entry keeps its dependency surface (core + fiber, never
    // /viewer). This is the pin that catches drift — and the drift would be SILENT: Pascal's
    // post-processing composes the frame from passes with fixed layer sets, so handles on any
    // other layer are in no pass and are simply never drawn, with the camera mask irrelevant.
    // The viewer only publishes its root, which re-exports the layer constants.
    const { OVERLAY_LAYER } = (await import("@pascal-app/viewer")) as unknown as {
      OVERLAY_LAYER: number;
    };
    expect(PASCAL_OVERLAY_LAYER).toBe(OVERLAY_LAYER);
  });

  it("it is NOT the library's own helper layer — that one is in no Pascal pass", () => {
    const { EDITOR_HELPERS_LAYER } = coreLayers;
    expect(PASCAL_OVERLAY_LAYER).not.toBe(EDITOR_HELPERS_LAYER);
  });
});
