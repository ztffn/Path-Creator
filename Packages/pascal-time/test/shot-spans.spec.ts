// A shot owns a BLOCK of time, and where its block reaches past the next shot's start, the excess
// IS the crossover between them — the model `@huma/path-creator`'s own demo authors with, where
// the thing you drag on the lane is the thing that shapes the hand-off. Before this the blend was
// a separate number and blocks abutted, so the lane drew a hard seam over a real ramp. The claims
// that matter here are the derivation, and the reconstruction that lets older documents play.
import { beforeEach, describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three";
import { sceneRegistry, useScene } from "@pascal-app/core";
import {
  buildShotNode,
  buildTimelineNode,
  createPluginNode,
  installPascalTimeOnScene,
  PascalCameraDirector,
  readShotBlocks,
  readShotDefinitions,
  readTimeline,
  registerPascalTimeKinds
} from "../src/index";

const CLOCK = "humatime_clock";
const DURATION = 20;

function freshScene(): void {
  useScene.getState().clearScene();
  useScene.temporal.getState().clear();
  sceneRegistry.clear();
  installPascalTimeOnScene();
  createPluginNode(buildTimelineNode({ id: CLOCK, durationSeconds: DURATION }));
}

/** Two static shots looking from clearly different places, so a blend is visible in the numbers. */
function twoShots(a: Record<string, unknown>, b: Record<string, unknown>): void {
  createPluginNode(
    buildShotNode({
      id: "a",
      name: "A",
      timelineId: CLOCK,
      body: "static",
      position: [0, 0, 0],
      rotationDeg: [0, 0, 0],
      ...a
    })
  );
  createPluginNode(
    buildShotNode({
      id: "b",
      name: "B",
      timelineId: CLOCK,
      body: "static",
      position: [100, 0, 0],
      rotationDeg: [0, 0, 0],
      ...b
    })
  );
}

const blocks = (): ReturnType<typeof readShotBlocks> => readShotBlocks(CLOCK, DURATION);

beforeEach(() => {
  registerPascalTimeKinds();
  freshScene();
});

describe("the overlap between two blocks IS the blend", () => {
  it("abutting blocks are a cut", () => {
    twoShots(
      { timeSeconds: 0, endSeconds: 10, blendSeconds: 0 },
      { timeSeconds: 10, endSeconds: 20, blendSeconds: 0 }
    );
    expect(blocks().map((block) => block.blendSeconds)).toEqual([0, 0]);
  });

  it("an overlap of 3s is a 3s blend, with no blend field anywhere", () => {
    twoShots(
      { timeSeconds: 0, endSeconds: 13, blendSeconds: 0 },
      { timeSeconds: 10, endSeconds: 20, blendSeconds: 0 }
    );
    const [a, b] = blocks();
    expect(a!.end).toBe(13);
    expect(b!.blendSeconds).toBeCloseTo(3, 9);
    // The FIRST shot never carries a blend: there is nothing before it to come from.
    expect(a!.blendSeconds).toBe(0);
  });

  it("the overlap cannot exceed the incoming shot's own block", () => {
    // A predecessor reaching past the whole of the next block would otherwise claim a blend
    // longer than the shot it is blending into, and the progress ratio would never reach 1.
    twoShots(
      { timeSeconds: 0, endSeconds: 19, blendSeconds: 0 },
      { timeSeconds: 10, endSeconds: 12, blendSeconds: 0 }
    );
    expect(blocks()[1]!.blendSeconds).toBeCloseTo(2, 9);
  });

  it("the last shot runs to the timeline's duration when it says nothing", () => {
    twoShots({ timeSeconds: 0, endSeconds: 6, blendSeconds: 0 }, { timeSeconds: 5, blendSeconds: 0 });
    expect(blocks()[1]!.end).toBe(DURATION);
  });

  it("dragging a block's start over its predecessor lengthens the crossover", () => {
    // The gesture the model exists for: one shot's own two edges, and the blend follows.
    twoShots(
      { timeSeconds: 0, endSeconds: 12, blendSeconds: 0 },
      { timeSeconds: 10, endSeconds: 20, blendSeconds: 0 }
    );
    expect(blocks()[1]!.blendSeconds).toBeCloseTo(2, 9);
    useScene.getState().updateNode("b" as never, { timeSeconds: 6 } as never);
    expect(blocks()[1]!.blendSeconds).toBeCloseTo(6, 9);
  });
});

describe("a document written before spans existed still plays", () => {
  it("the legacy layout is reconstructed as an overlap of the old blend", () => {
    // No endSeconds anywhere. Blocks used to abut and B declared a 4s blend; the same hand-off is
    // now expressed as A's block reaching 4s past B's start.
    twoShots({ timeSeconds: 0, blendSeconds: 0 }, { timeSeconds: 10, blendSeconds: 4 });
    const [a, b] = blocks();
    expect(a!.end).toBe(14);
    expect(b!.blendSeconds).toBeCloseTo(4, 9);
  });

  it("and the reconstruction is not a rewrite — the document is untouched", () => {
    twoShots({ timeSeconds: 0, blendSeconds: 0 }, { timeSeconds: 10, blendSeconds: 4 });
    const depthBefore = useScene.temporal.getState().pastStates.length;
    blocks();
    blocks();
    const node = useScene.getState().nodes["a" as never] as Record<string, unknown>;
    expect(node.endSeconds).toBe(0);
    expect(useScene.temporal.getState().pastStates.length).toBe(depthBefore);
  });

  it("an authored span wins over the legacy field", () => {
    twoShots({ timeSeconds: 0, endSeconds: 11, blendSeconds: 0 }, { timeSeconds: 10, blendSeconds: 9 });
    // A's own end says 11, so B's stale 9s blend does not stretch it to 19.
    expect(blocks()[0]!.end).toBe(11);
    expect(blocks()[1]!.blendSeconds).toBeCloseTo(1, 9);
  });

  it("CONTROL: the legacy path and an equivalent authored span give the same camera", () => {
    // The migration's whole claim, made falsifiable: the same moment must look the same before
    // and after an author touches the span.
    const poseAt = (time: number): number => {
      const director = new PascalCameraDirector();
      return director.sync(new PerspectiveCamera(), {
        timeline: readTimeline(CLOCK)!,
        vcams: readShotDefinitions(CLOCK),
        time
      })!.snapshot.position.x;
    };

    twoShots({ timeSeconds: 0, blendSeconds: 0 }, { timeSeconds: 10, blendSeconds: 4 });
    const legacyMidBlend = poseAt(12);

    freshScene();
    twoShots(
      { timeSeconds: 0, endSeconds: 14, blendSeconds: 0 },
      { timeSeconds: 10, endSeconds: 20, blendSeconds: 0 }
    );
    expect(poseAt(12)).toBeCloseTo(legacyMidBlend, 9);
    // And the blend is real: halfway through a 4s crossover between x=0 and x=100 is neither end.
    expect(legacyMidBlend).toBeGreaterThan(1);
    expect(legacyMidBlend).toBeLessThan(99);
  });
});
