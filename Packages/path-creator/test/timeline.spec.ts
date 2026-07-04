// Tests for the timeline runtime: the purity/determinism contract of
// evaluateTimeline (scrub == play), camera block hold/cut/blend semantics,
// per-block overrides (retargets), cart tracks vs speed-derived carts,
// event collection windows, and the player's edge-triggered event firing.
// These semantics are the contract the twin's tours and elastiq build on.
import { describe, expect, it } from "vitest";
import {
  TargetRegistry,
  VertexPath,
  createPathCart,
  createTimeline,
  type RigRuntime,
  type VirtualCameraDefinition
} from "../src/core";
import {
  collectTimelineEvents,
  createTimelinePlayer,
  evaluateTimeline,
  seekTimelinePlayer,
  stepTimelinePlayer,
  type TimelineRigContext
} from "../src/timeline";

const path = new VertexPath(
  [
    { x: 0, y: 0, z: 0 },
    { x: 100, y: 0, z: 0 }
  ],
  [0, 100]
);

function buildContext(): TimelineRigContext {
  const rig: RigRuntime = {
    paths: new Map([["rail", path]]),
    carts: new Map([["dolly", createPathCart({ speed: 10 })]]),
    cartPaths: new Map([["dolly", "rail"]])
  };

  const vcams = new Map<string, VirtualCameraDefinition>([
    [
      "wide",
      {
        id: "wide",
        body: {
          type: "static",
          position: { x: 0, y: 5, z: 20 },
          quaternion: { x: 0, y: 0, z: 0, w: 1 }
        }
      }
    ],
    ["rail-cam", { id: "rail-cam", body: { type: "cart", cartId: "dolly" } }]
  ]);

  return { rig, vcams };
}

const showTimeline = createTimeline({
  duration: 20,
  tracks: [
    {
      type: "camera",
      id: "cam",
      blocks: [
        { id: "b1", vcamId: "wide", start: 2, end: 6 },
        {
          id: "b2",
          vcamId: "rail-cam",
          start: 8,
          end: 14,
          blendIn: { durationSeconds: 2, curve: "linear" }
        }
      ]
    },
    {
      type: "event",
      id: "events",
      events: [
        { id: "e1", time: 3, kind: "caption", payload: "hello" },
        { id: "e2", time: 9, kind: "caption" }
      ]
    }
  ]
});

describe("evaluateTimeline camera semantics", () => {
  const context = buildContext();

  it("is free before the first block", () => {
    expect(evaluateTimeline(showTimeline, context, 1).camera).toBeNull();
  });

  it("resolves the active block's vcam", () => {
    const sample = evaluateTimeline(showTimeline, context, 3);
    expect(sample.camera?.position).toEqual({ x: 0, y: 5, z: 20 });
    expect(sample.activeBlock?.block.id).toBe("b1");
  });

  it("holds the last shot through gaps", () => {
    const sample = evaluateTimeline(showTimeline, context, 7);
    expect(sample.camera?.position).toEqual({ x: 0, y: 5, z: 20 });
    expect(sample.activeBlock?.block.id).toBe("b1");
  });

  it("blends into the next block with both shots live", () => {
    const sample = evaluateTimeline(showTimeline, context, 9);
    // Halfway through a 2s linear blend at t=9: dolly cart is at 90 on the
    // rail; midpoint x = (0 + 90) / 2.
    expect(sample.blendProgress).toBeCloseTo(0.5);
    expect(sample.camera?.position.x).toBeCloseTo(45);
  });

  it("completes the blend and follows the moving cart", () => {
    const sample = evaluateTimeline(showTimeline, context, 12);
    expect(sample.blendProgress).toBe(1);
    // 10 u/s on a 100 u looping rail at t=12 -> distance 20.
    expect(sample.camera?.position.x).toBeCloseTo(20);
  });

  it("cuts when no blendIn is set", () => {
    const cutTimeline = createTimeline({
      duration: 10,
      tracks: [
        {
          type: "camera",
          id: "cam",
          blocks: [
            { id: "a", vcamId: "wide", start: 0, end: 2 },
            { id: "b", vcamId: "rail-cam", start: 2, end: 10 }
          ]
        }
      ]
    });
    const justAfter = evaluateTimeline(cutTimeline, context, 2.001);
    expect(justAfter.camera?.position.x).toBeCloseTo(20.01, 1);
    expect(justAfter.blendProgress).toBe(1);
  });

  it("is deterministic: scrubbing to t equals arriving at t", () => {
    const direct = evaluateTimeline(showTimeline, context, 11.37);
    const arrived = evaluateTimeline(showTimeline, buildContext(), 11.37);
    expect(direct).toEqual(arrived);
  });

  it("rejects unknown schema versions", () => {
    const bad = { ...showTimeline, schemaVersion: 99 };
    expect(() => evaluateTimeline(bad as never, context, 0)).toThrow(/schema version/);
  });
});

describe("block overrides (retarget)", () => {
  it("patches the vcam definition per block", () => {
    const registry = new TargetRegistry();
    registry.register("buoy", () => ({ x: 0, y: 0, z: -50 }));

    const context: TimelineRigContext = {
      ...buildContext(),
      getTargetPosition: (id) => registry.resolve(id)
    };
    const retargetTimeline = createTimeline({
      duration: 10,
      tracks: [
        {
          type: "camera",
          id: "cam",
          blocks: [
            { id: "plain", vcamId: "wide", start: 0, end: 5 },
            {
              id: "retargeted",
              vcamId: "wide",
              start: 5,
              end: 10,
              overrides: { aim: { type: "look-at", target: { targetId: "buoy" } } }
            }
          ]
        }
      ]
    });

    const before = evaluateTimeline(retargetTimeline, context, 4);
    const after = evaluateTimeline(retargetTimeline, context, 6);
    expect(before.camera?.quaternion).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(after.camera?.quaternion).not.toEqual(before.camera?.quaternion);
    expect(after.camera?.position).toEqual(before.camera?.position);
  });
});

describe("cart tracks", () => {
  it("keyframed distance beats speed, with easing and end clamps", () => {
    const context = buildContext();
    const keyed = createTimeline({
      duration: 10,
      tracks: [
        {
          type: "cart",
          id: "ct",
          cartId: "dolly",
          keys: [
            { time: 2, distance: 0, easing: "linear" },
            { time: 6, distance: 40 }
          ]
        }
      ]
    });

    expect(evaluateTimeline(keyed, context, 0).cartFrames.get("dolly")?.distance).toBe(0);
    expect(evaluateTimeline(keyed, context, 4).cartFrames.get("dolly")?.distance).toBeCloseTo(20);
    expect(evaluateTimeline(keyed, context, 9).cartFrames.get("dolly")?.distance).toBe(40);
  });

  it("carts without a track derive distance from speed * t", () => {
    const context = buildContext();
    const empty = createTimeline({ duration: 10 });
    expect(evaluateTimeline(empty, context, 3).cartFrames.get("dolly")?.distance).toBeCloseTo(30);
  });
});

describe("events and player", () => {
  it("collects events in forward half-open windows only", () => {
    expect(collectTimelineEvents(showTimeline, 0, 5).map((e) => e.id)).toEqual(["e1"]);
    expect(collectTimelineEvents(showTimeline, 3, 9).map((e) => e.id)).toEqual(["e2"]);
    expect(collectTimelineEvents(showTimeline, 9, 3)).toEqual([]);
  });

  it("fires each event exactly once while stepping", () => {
    const player = createTimelinePlayer({ playing: true });
    const fired: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      for (const event of stepTimelinePlayer(player, showTimeline, 0.5)) {
        fired.push(event.id);
      }
    }
    expect(fired).toEqual(["e1", "e2"]);
    expect(player.playing).toBe(false);
    expect(player.time).toBe(20);
  });

  it("seek does not fire events", () => {
    const player = createTimelinePlayer({ playing: true });
    seekTimelinePlayer(player, 10);
    expect(stepTimelinePlayer(player, showTimeline, 0.1)).toEqual([]);
    expect(player.time).toBeCloseTo(10.1);
  });

  it("loops and fires the pre-wrap events", () => {
    const player = createTimelinePlayer({ playing: true, loop: true, time: 19.5 });
    const fired = stepTimelinePlayer(player, showTimeline, 1);
    expect(fired).toEqual([]);
    expect(player.time).toBeCloseTo(0.5);
    expect(player.playing).toBe(true);
  });
});
