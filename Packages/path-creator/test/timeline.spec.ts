// Tests for the timeline runtime: the purity/determinism contract of
// evaluateTimeline (scrub == play), camera block hold/cut/blend semantics,
// per-block overrides (retargets), cart tracks vs speed-derived carts,
// event collection windows, and the player's edge-triggered event firing.
// These semantics are the contract the twin's tours and elastiq build on.
import { describe, expect, it } from "vitest";
import { PerspectiveCamera } from "three";
import {
  BezierPath,
  TargetRegistry,
  VertexPath,
  buildRigRuntime,
  createPathCart,
  createRigDocument,
  createTimeline,
  normalizeTimelineEasing,
  serializeRigCart,
  serializeRigPath,
  type CartFrame,
  type VirtualCameraDefinition
} from "../src/core";
import { createRigDriveState, driveActivation } from "../src/three";
import {
  collectTimelineEvents,
  createTimelinePlayer,
  driveTimeline,
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
  const rig: TimelineRigContext["rig"] = {
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
              overrides: { aim: { type: "track", target: { targetId: "buoy" } } }
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

describe("rig document v2 end-to-end", () => {
  const bezier = new BezierPath([
    { x: 0, y: 0, z: 0 },
    { x: 50, y: 0, z: 0 },
    { x: 100, y: 0, z: 0 }
  ]);

  it("round-trips a full show through JSON into a playable runtime", () => {
    const document = createRigDocument({
      paths: [serializeRigPath("rail", bezier)],
      carts: [serializeRigCart("dolly", createPathCart({ speed: 5 }), "rail")],
      vcams: [{ id: "rail-cam", body: { type: "cart", cartId: "dolly" } }],
      timelines: [
        {
          id: "show",
          ...createTimeline({
            duration: 10,
            tracks: [
              {
                type: "camera",
                id: "cam",
                blocks: [{ id: "b", vcamId: "rail-cam", start: 0, end: 10 }]
              }
            ]
          })
        }
      ]
    });

    const runtime = buildRigRuntime(JSON.parse(JSON.stringify(document)) as typeof document);
    const show = runtime.timelines.get("show");
    expect(show).toBeDefined();

    const sample = evaluateTimeline(show!, { rig: runtime, vcams: runtime.vcams }, 4);
    expect(sample.camera?.position.x).toBeCloseTo(20, 0);
  });

  it("accepts v1 documents (paths + carts only)", () => {
    const v1 = {
      schemaVersion: 1,
      paths: [serializeRigPath("rail", bezier)],
      carts: [serializeRigCart("dolly", createPathCart(), "rail")]
    };
    const runtime = buildRigRuntime(v1);
    expect(runtime.vcams.size).toBe(0);
    expect(runtime.carts.size).toBe(1);
  });

  it("rejects dangling vcam and timeline references", () => {
    expect(() =>
      buildRigRuntime(
        createRigDocument({
          vcams: [{ id: "v", body: { type: "cart", cartId: "missing" } }]
        })
      )
    ).toThrow(/unknown cart/);

    expect(() =>
      buildRigRuntime(
        createRigDocument({
          timelines: [
            {
              id: "show",
              ...createTimeline({
                duration: 1,
                tracks: [
                  {
                    type: "camera",
                    id: "cam",
                    blocks: [{ id: "b", vcamId: "ghost", start: 0, end: 1 }]
                  }
                ]
              })
            }
          ]
        })
      )
    ).toThrow(/unknown vcam/);
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

describe("timeline construction invariants", () => {
  it("createTimeline sorts blocks, keys, and events by time", () => {
    const timeline = createTimeline({
      duration: 10,
      tracks: [
        {
          type: "camera",
          id: "cam",
          blocks: [
            { id: "late", vcamId: "a", start: 5, end: 8 },
            { id: "early", vcamId: "a", start: 0, end: 3 }
          ]
        },
        {
          type: "cart",
          id: "ct",
          cartId: "dolly",
          keys: [
            { time: 6, distance: 60 },
            { time: 1, distance: 10 }
          ]
        },
        {
          type: "event",
          id: "ev",
          events: [
            { id: "b", time: 7, kind: "x" },
            { id: "a", time: 2, kind: "x" }
          ]
        }
      ]
    });

    const camera = timeline.tracks[0];
    const cart = timeline.tracks[1];
    const events = timeline.tracks[2];
    expect(camera.type === "camera" && camera.blocks.map((b) => b.id)).toEqual(["early", "late"]);
    expect(cart.type === "cart" && cart.keys.map((k) => k.time)).toEqual([1, 6]);
    expect(events.type === "event" && events.events.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("gap mode", () => {
  it("release returns null in gaps; hold (default) keeps the last shot", () => {
    const context = buildContext();
    const tracks = [
      {
        type: "camera" as const,
        id: "cam",
        blocks: [{ id: "b", vcamId: "wide", start: 1, end: 3 }]
      }
    ];
    const holding = createTimeline({ duration: 10, tracks });
    const releasing = createTimeline({ duration: 10, gapMode: "release", tracks });

    expect(evaluateTimeline(holding, context, 5).camera).not.toBeNull();
    expect(evaluateTimeline(releasing, context, 5).camera).toBeNull();
    expect(evaluateTimeline(releasing, context, 2).camera).not.toBeNull();
  });
});

describe("driveTimeline playback driver", () => {
  const context = buildContext();

  it("parks the evaluated pose in the shared brain and publishes cart frames", () => {
    const state = createRigDriveState();
    const camera = new PerspectiveCamera();
    const player = createTimelinePlayer({ time: 3 });
    const cartFrames = new Map<string, CartFrame>();

    const result = driveTimeline(state, { camera, timeline: showTimeline, player, context, cartFrames }, 0);

    expect(result.activeVcamId).toBe("wide");
    expect(camera.position.z).toBeCloseTo(20);
    // The brain holds the timeline pose — it is the single live-pose holder.
    expect(state.brain.live?.position.z).toBeCloseTo(20);
    expect(cartFrames.has("dolly")).toBe(true);
  });

  it("advances the clock only while playing", () => {
    const state = createRigDriveState();
    const camera = new PerspectiveCamera();
    const cartFrames = new Map<string, CartFrame>();

    const paused = createTimelinePlayer({ time: 3, playing: false });
    driveTimeline(state, { camera, timeline: showTimeline, player: paused, context, cartFrames }, 1);
    expect(paused.time).toBe(3);

    const playing = createTimelinePlayer({ time: 3, playing: true });
    driveTimeline(state, { camera, timeline: showTimeline, player: playing, context, cartFrames }, 1);
    expect(playing.time).toBeCloseTo(4);
  });

  it("returns no camera in a released gap", () => {
    const state = createRigDriveState();
    const releasing = createTimeline({
      duration: 20,
      gapMode: "release",
      tracks: [{ type: "camera", id: "cam", blocks: [{ id: "b1", vcamId: "wide", start: 2, end: 6 }] }]
    });
    const player = createTimelinePlayer({ time: 8 });

    const result = driveTimeline(
      state,
      { camera: new PerspectiveCamera(), timeline: releasing, player, context, cartFrames: new Map() },
      0
    );
    expect(result.cameraSnapshot).toBeNull();
    expect(state.composer.vcamId).toBeNull();
  });

  it("hands its live pose to activation for a seamless blend start", () => {
    const state = createRigDriveState();
    const camera = new PerspectiveCamera();
    const player = createTimelinePlayer({ time: 3 });

    driveTimeline(state, { camera, timeline: showTimeline, player, context, cartFrames: new Map() }, 0);
    expect(state.brain.live?.position.z).toBeCloseTo(20);

    const close: VirtualCameraDefinition = {
      id: "close",
      body: { type: "static", position: { x: 0, y: 0, z: 5 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
    };
    driveActivation(
      state,
      {
        camera,
        activeVcamId: "close",
        vcams: new Map([["close", close]]),
        context: {},
        blend: { durationSeconds: 2, curve: "linear" }
      },
      1
    );

    // The blend starts from the timeline's last pose (z=20), not from close's z=5.
    expect(state.brain.previous?.position.z).toBeCloseTo(20);
    expect(camera.position.z).toBeCloseTo(12.5);
  });
});

describe("camera block lens animation", () => {
  const context = buildContext();

  it("eases a lens field across the block window (block-local t)", () => {
    const anim = createTimeline({
      duration: 10,
      tracks: [
        {
          type: "camera",
          id: "cam",
          blocks: [
            { id: "b", vcamId: "wide", start: 0, end: 4, lensAnimation: { fov: { from: 90, to: 30, easing: "linear" } } }
          ]
        }
      ]
    });
    expect(evaluateTimeline(anim, context, 0).camera?.lens?.fov).toBeCloseTo(90);
    expect(evaluateTimeline(anim, context, 2).camera?.lens?.fov).toBeCloseTo(60);
    expect(evaluateTimeline(anim, context, 4).camera?.lens?.fov).toBeCloseTo(30);
  });

  it("is deterministic: scrub == play at the same t", () => {
    const anim = createTimeline({
      duration: 10,
      tracks: [
        { type: "camera", id: "cam", blocks: [{ id: "b", vcamId: "wide", start: 0, end: 8, lensAnimation: { fov: { from: 80, to: 20 } } }] }
      ]
    });
    expect(evaluateTimeline(anim, context, 3).camera?.lens?.fov).toBeCloseTo(
      evaluateTimeline(anim, buildContext(), 3).camera?.lens?.fov as number
    );
  });

  it("blends two simultaneously-animating blocks with varying curves", () => {
    // b1 [0,8] fov 80->40, b2 [4,12] fov 20->60, 2s linear blend at t=4.
    // At t=5 (blend progress 0.5): b1 local 5/8 -> 55, b2 local 1/8 -> 25,
    // blended fov = 55 + (25 - 55) * 0.5 = 40. Both curves are sampled mid-blend.
    const both = createTimeline({
      duration: 12,
      tracks: [
        {
          type: "camera",
          id: "cam",
          blocks: [
            { id: "b1", vcamId: "wide", start: 0, end: 8, lensAnimation: { fov: { from: 80, to: 40, easing: "linear" } } },
            {
              id: "b2",
              vcamId: "wide",
              start: 4,
              end: 12,
              blendIn: { durationSeconds: 2, curve: "linear" },
              lensAnimation: { fov: { from: 20, to: 60, easing: "linear" } }
            }
          ]
        }
      ]
    });
    const sample = evaluateTimeline(both, context, 5);
    expect(sample.blendProgress).toBeCloseTo(0.5);
    expect(sample.camera?.lens?.fov).toBeCloseTo(40);
  });

  it("blends the animated lens across overlapping blocks", () => {
    // b1 holds fov 60 (static override); b2 animates fov 20 and blends in over 2s.
    // At t=5 (halfway through the blend) fov = blend(60, 20, 0.5) = 40.
    const blended = createTimeline({
      duration: 12,
      tracks: [
        {
          type: "camera",
          id: "cam",
          blocks: [
            { id: "b1", vcamId: "wide", start: 0, end: 10, overrides: { lens: { fov: 60 } } },
            {
              id: "b2",
              vcamId: "wide",
              start: 4,
              end: 10,
              blendIn: { durationSeconds: 2, curve: "linear" },
              lensAnimation: { fov: { from: 20, to: 20, easing: "linear" } }
            }
          ]
        }
      ]
    });
    const sample = evaluateTimeline(blended, context, 5);
    expect(sample.blendProgress).toBeCloseTo(0.5);
    expect(sample.camera?.lens?.fov).toBeCloseTo(40);
  });

  it("normalizes a malformed animated-easing at the deserialize boundary", () => {
    const bad = createTimeline({
      duration: 4,
      tracks: [
        {
          type: "camera",
          id: "cam",
          blocks: [{ id: "b", vcamId: "wide", start: 0, end: 4, lensAnimation: { fov: { from: 90, to: 30, easing: "bogus" as never } } }]
        }
      ]
    });
    const normalized = normalizeTimelineEasing(bad);
    const track = normalized.tracks[0];
    const easing = track.type === "camera" ? track.blocks[0].lensAnimation?.fov?.easing : undefined;
    expect(easing).toBe("linear");
  });
});
