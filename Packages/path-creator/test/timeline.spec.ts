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
  audioClipSpeed,
  buildRigRuntime,
  createPathCart,
  createRigDocument,
  createTimeline,
  evaluateAnimation,
  evaluateAudio,
  evaluateTransform,
  normalizeTimelineEasing,
  transformComponentAt,
  serializeRigCart,
  serializeRigPath,
  type AudioClip,
  type CartFrame,
  type VirtualCameraDefinition
} from "../src/core";
import { createRigDriveState, driveActivation } from "../src/three";
import {
  RIG_SCHEMA_VERSION,
  createArmState,
  getEntryScene,
  getScene,
  listScenes,
  parseRigDocument,
  sceneOwnsCamera,
  serializeRigDocument,
  stepArmPolicy,
  stepProximity
} from "../src/core";
import {
  createTriggerRuntimeState,
  resolveTriggerCommands,
  stepTriggers,
  type TriggerWorldSnapshot
} from "../src/timeline";
import {
  collectTimelineEvents,
  createSceneRuntimeState,
  createTimelinePlayer,
  driveRigWithScenes,
  driveTimeline,
  evaluateSceneLayers,
  evaluateTimeline,
  playScene,
  seekTimelinePlayer,
  stepTimelinePlayer,
  stopScene,
  type RigDriveIntent,
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

describe("portable object and media tracks", () => {
  it("crossfades embedded animation and audio clips deterministically", () => {
    const animation = evaluateAnimation([{ type: "animation", id: "anim", objectId: "fox", clips: [
      { id: "walk", clipName: "Walk", start: 0, end: 4 },
      { id: "run", clipName: "Run", start: 2, end: 6 }
    ] }], 3).get("fox");
    expect(animation?.map((sample) => sample.weight)).toEqual([0.5, 0.5]);
    const audio = evaluateAudio([{ type: "audio", id: "audio", clips: [
      { id: "out", src: "a", start: 0, duration: 4 },
      { id: "in", src: "b", start: 2, duration: 4 }
    ] }], 3);
    expect(audio.get("out")?.gain).toBeCloseTo(0.5);
    expect(audio.get("in")?.gain).toBeCloseTo(0.5);
  });

  it("evaluates portable transform tracks", () => {
    const value = evaluateTransform([{ type: "transform", id: "xf", objectId: "fox", position: [
      { time: 0, value: [0, 0, 0] }, { time: 2, value: [4, 0, 0] }
    ] }], 1).get("fox");
    expect(value?.position).toEqual([2, 0, 0]);
  });

  it("transformComponentAt: straight-tangent default equals a linear lerp", () => {
    const keys = [{ time: 0, value: [0, 0, 0] as [number, number, number] }, { time: 4, value: [8, 0, 0] as [number, number, number] }];
    expect(transformComponentAt(keys, 0, 0)).toBeCloseTo(0, 6);
    expect(transformComponentAt(keys, 0, 1)).toBeCloseTo(2, 6); // linear
    expect(transformComponentAt(keys, 0, 3)).toBeCloseTo(6, 6);
    // held before first / after last
    expect(transformComponentAt(keys, 0, -1)).toBe(0);
    expect(transformComponentAt(keys, 0, 9)).toBe(8);
  });

  it("transformComponentAt: a lifted tangent bulges between equal-value keys", () => {
    // Both endpoints 0, but the out/in handles lift the curve — the eased-lerp model
    // (value pinned to [a,b]) could never do this; the bezier can.
    const keys = [
      { time: 0, value: [0, 0, 0] as [number, number, number], tangentsAxes: [{ out: [0.7, 3] as [number, number] }, {}, {}] as const },
      { time: 2, value: [0, 0, 0] as [number, number, number], tangentsAxes: [{ in: [-0.7, 3] as [number, number] }, {}, {}] as const }
    ];
    expect(transformComponentAt(keys, 0, 1)).toBeGreaterThan(1); // bulged above the flat endpoints
    expect(transformComponentAt(keys, 1, 1)).toBeCloseTo(0, 6); // untouched axis stays flat
  });

  it("transformComponentAt matches evaluateTransform (editor draws what the runtime plays)", () => {
    const position: [number, number, number][] = [[0, 0, 0], [10, 5, -2]];
    const keys = [
      { time: 0, value: position[0]!, tangentsAxes: [{ out: [0.5, 6] as [number, number] }, {}, {}] as const },
      { time: 3, value: position[1]! }
    ];
    for (const t of [0.3, 1.1, 2.4]) {
      const viaEval = evaluateTransform([{ type: "transform", id: "xf", objectId: "fox", position: keys }], t).get("fox")?.position;
      for (let c = 0; c < 3; c += 1) expect(transformComponentAt(keys, c, t)).toBeCloseTo(viaEval![c]!, 6);
    }
  });

  it("advances the audio source position by rate x stretch", () => {
    const at = (t: number, over: Partial<AudioClip>) => evaluateAudio([{
      type: "audio", id: "a", clips: [{ id: "c", src: "s", start: 1, duration: 8, offset: 0.5, ...over }]
    }], t).get("c");
    // Unchanged default: one second of timeline consumes one second of source.
    expect(at(3, {})?.offset).toBeCloseTo(2.5, 6);
    expect(at(3, {})?.rate).toBe(1);
    expect(at(3, {})?.stretch).toBe(1);
    // rate and stretch are both speed multipliers and compose multiplicatively.
    expect(at(3, { rate: 2 })?.offset).toBeCloseTo(4.5, 6);
    expect(at(3, { stretch: 0.5 })?.offset).toBeCloseTo(1.5, 6);
    expect(at(3, { rate: 2, stretch: 3 })?.offset).toBeCloseTo(12.5, 6);
    // The in-point is a source position, so it is NOT scaled — only elapsed time is.
    expect(at(1, { rate: 4 })?.offset).toBeCloseTo(0.5, 6);
  });

  it("reads non-positive or non-finite audio speeds as 1", () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const desired = evaluateAudio([{
        type: "audio", id: "a", clips: [{ id: "c", src: "s", start: 0, duration: 4, rate: bad, stretch: bad }]
      }], 1).get("c");
      expect(desired?.rate).toBe(1);
      expect(desired?.stretch).toBe(1);
      expect(desired?.offset).toBeCloseTo(1, 6);
    }
  });

  it("audioClipSpeed reports the source seconds a clip spans per timeline second", () => {
    expect(audioClipSpeed({ id: "c", src: "s", start: 0, duration: 4 })).toBe(1);
    expect(audioClipSpeed({ id: "c", src: "s", start: 0, duration: 4, rate: 2, stretch: 1.5 })).toBeCloseTo(3, 6);
    expect(audioClipSpeed({ id: "c", src: "s", start: 0, duration: 4, rate: 0 })).toBe(1);
  });

  it("drops malformed persisted audio gain curves instead of crashing", () => {
    const timeline = normalizeTimelineEasing(createTimeline({
      tracks: [{
        type: "audio",
        id: "audio",
        clips: [{ id: "clip", src: "a", start: 0, duration: 2, gainCurve: "invalid" as never }]
      }]
    }));
    const track = timeline.tracks.find((candidate) => candidate.type === "audio");
    expect(track?.clips[0]?.gainCurve).toBeUndefined();
    expect(() => evaluateAudio(track ? [track] : [], 1)).not.toThrow();
    expect(evaluateAudio(track ? [track] : [], 1).get("clip")?.gain).toBe(1);
  });

  it("emits only the incoming animation after a crossfade ends", () => {
    const samples = evaluateAnimation([{ type: "animation", id: "anim", objectId: "fox", clips: [
      { id: "walk", clipName: "Walk", start: 0, end: 4 },
      { id: "run", clipName: "Run", start: 2, end: 6 }
    ] }], 4).get("fox");
    expect(samples).toEqual([{ clipName: "Run", localTime: 2, weight: 1, loop: true }]);
  });

  it("keeps duplicate transform-key times finite", () => {
    const value = evaluateTransform([{ type: "transform", id: "xf", objectId: "fox", position: [
      { time: 0, value: [0, 0, 0] },
      { time: 1, value: [1, 0, 0] },
      { time: 1, value: [2, 0, 0] },
      { time: 2, value: [3, 0, 0] }
    ] }], 1).get("fox")?.position;
    expect(value?.every(Number.isFinite)).toBe(true);
  });
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

describe("story schema (v7) migration and scene resolution", () => {
  const legacyDoc = {
    schemaVersion: 6,
    paths: [],
    carts: [],
    vcams: [
      {
        id: "wide",
        body: { type: "static", position: { x: 0, y: 5, z: 20 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } }
      }
    ],
    timelines: [
      {
        id: "show",
        ...createTimeline({
          duration: 10,
          tracks: [
            { type: "camera", id: "cam", blocks: [{ id: "b", vcamId: "wide", start: 0, end: 10 }] }
          ]
        })
      }
    ]
  };

  it("migrates a legacy single-timeline document to a Story with scene[0] as entry", () => {
    const migrated = parseRigDocument(JSON.stringify(legacyDoc));
    expect(migrated.schemaVersion).toBe(RIG_SCHEMA_VERSION);
    expect(migrated.entrySceneId).toBe("show");
    expect(listScenes(migrated)).toHaveLength(1);
    expect(getEntryScene(migrated)?.id).toBe("show");
  });

  it("round-trips a multi-scene story preserving the entry scene", () => {
    const migrated = parseRigDocument(JSON.stringify(legacyDoc));
    const story = {
      ...migrated,
      timelines: [
        ...(migrated.timelines ?? []),
        { id: "detail", ...createTimeline({ duration: 4, tracks: [] }) }
      ],
      entrySceneId: "detail"
    };
    const roundTripped = parseRigDocument(serializeRigDocument(story));
    expect(roundTripped.entrySceneId).toBe("detail");
    expect(listScenes(roundTripped).map((scene) => scene.id)).toEqual(["show", "detail"]);
    expect(getScene(roundTripped, "missing")).toBeNull();
    expect(getEntryScene(roundTripped)?.id).toBe("detail");
  });

  it("keeps a pre-existing entrySceneId through migration", () => {
    const doc = { ...legacyDoc, entrySceneId: "show" };
    expect(parseRigDocument(JSON.stringify(doc)).entrySceneId).toBe("show");
  });

  it("derives camera ownership from composition", () => {
    const migrated = parseRigDocument(JSON.stringify(legacyDoc));
    expect(sceneOwnsCamera(getScene(migrated, "show")!)).toBe(true);
    expect(sceneOwnsCamera(createTimeline({ duration: 3, tracks: [] }))).toBe(false);
    expect(
      sceneOwnsCamera(createTimeline({ duration: 3, tracks: [{ type: "camera", id: "cam", blocks: [] }] }))
    ).toBe(false);
  });
});

describe("active-scene runtime (playScene)", () => {
  const context = buildContext();

  // A scene whose static shot sits away from the caller pose, so blends are visible.
  const cameraScene = createTimeline({
    duration: 4,
    tracks: [
      { type: "camera", id: "cam", blocks: [{ id: "b", vcamId: "wide", start: 0, end: 4 }] }
    ]
  });
  const bareScene = createTimeline({ duration: 3, tracks: [] });
  const scenes = new Map([
    ["camera-scene", cameraScene],
    ["bare-scene", bareScene]
  ]);

  function makeParams(base: RigDriveIntent, camera: PerspectiveCamera) {
    return {
      camera,
      scenes,
      context,
      cartFrames: new Map<string, CartFrame>(),
      base
    };
  }

  function seededDrive() {
    const camera = new PerspectiveCamera();
    const rig = createRigDriveState({
      position: { x: 100, y: 5, z: 20 },
      quaternion: { x: 0, y: 0, z: 0, w: 1 }
    });
    const runtime = createSceneRuntimeState();
    return { camera, rig, runtime };
  }

  it("takes the camera with a blend, plays the scene, and releases back to the caller pose", () => {
    const { camera, rig, runtime } = seededDrive();
    const params = makeParams({ mode: "idle" }, camera);

    playScene(runtime, { sceneId: "camera-scene", blend: { durationSeconds: 1, curve: "linear" } });

    // Mid-take: halfway between the caller pose (x=100) and the shot (x=0).
    let result = driveRigWithScenes(runtime, rig, params, 0.5);
    expect(result.activeScene?.sceneId).toBe("camera-scene");
    expect(result.handoffProgress).toBeCloseTo(0.5);
    expect(result.cameraSnapshot?.position.x).toBeCloseTo(50);

    // Take completes; the scene owns the camera at its shot.
    result = driveRigWithScenes(runtime, rig, params, 0.5);
    expect(result.handoffProgress).toBe(1);
    expect(result.cameraSnapshot?.position.x).toBeCloseTo(0);
    expect(camera.position.x).toBeCloseTo(0);

    // Play to the end (already at t=1 after the take's two steps).
    driveRigWithScenes(runtime, rig, params, 3);
    // Completion begins the release; halfway back toward the caller pose.
    result = driveRigWithScenes(runtime, rig, params, 0.5);
    expect(result.activeScene).not.toBeNull();
    expect(result.handoffProgress).toBeCloseTo(0.5);
    expect(result.cameraSnapshot?.position.x).toBeCloseTo(50);

    // Release completes: control returns to the base intent.
    result = driveRigWithScenes(runtime, rig, params, 0.5);
    expect(result.cameraSnapshot?.position.x).toBeCloseTo(100);
    result = driveRigWithScenes(runtime, rig, params, 0.5);
    expect(result.activeScene).toBeNull();
  });

  it("evaluates a scene identically regardless of invocation history (determinism)", () => {
    const direct = evaluateTimeline(cameraScene, context, 2);
    const { rig, runtime, camera } = seededDrive();
    const params = makeParams({ mode: "idle" }, camera);
    playScene(runtime, { sceneId: "camera-scene", blend: { durationSeconds: 0 } });
    driveRigWithScenes(runtime, rig, params, 2);
    const afterHistory = evaluateTimeline(cameraScene, context, 2);
    expect(afterHistory).toEqual(direct);
  });

  it("a skippable takeover cancels on user input and blends back", () => {
    const { camera, rig, runtime } = seededDrive();
    const base: RigDriveIntent = { mode: "idle" };
    playScene(runtime, { sceneId: "camera-scene", blend: { durationSeconds: 1, curve: "linear" } });
    driveRigWithScenes(runtime, rig, makeParams(base, camera), 1); // take done, live at t=1

    const withInput = { ...makeParams(base, camera), overrideInput: { azimuthDeltaDeg: 2 } };
    const result = driveRigWithScenes(runtime, rig, withInput, 0.5);
    // Cancel entered release this frame: frozen at the scene pose, blend from next frame.
    expect(result.handoffProgress).toBe(0);
    expect(result.cameraSnapshot?.position.x).toBeCloseTo(0);
    const mid = driveRigWithScenes(runtime, rig, makeParams(base, camera), 0.5);
    expect(mid.handoffProgress).toBeCloseTo(0.5);
    expect(mid.cameraSnapshot?.position.x).toBeCloseTo(50);
    driveRigWithScenes(runtime, rig, makeParams(base, camera), 0.6);
    expect(driveRigWithScenes(runtime, rig, makeParams(base, camera), 0.1).activeScene).toBeNull();
  });

  it("a non-skippable takeover ignores user input", () => {
    const { camera, rig, runtime } = seededDrive();
    const base: RigDriveIntent = { mode: "idle" };
    playScene(runtime, { sceneId: "camera-scene", skippable: false, blend: { durationSeconds: 0 } });
    driveRigWithScenes(runtime, rig, makeParams(base, camera), 0.5);
    const withInput = { ...makeParams(base, camera), overrideInput: { azimuthDeltaDeg: 2 } };
    const result = driveRigWithScenes(runtime, rig, withInput, 0.5);
    expect(result.activeScene?.sceneId).toBe("camera-scene");
    expect(result.cameraSnapshot?.position.x).toBeCloseTo(0);
  });

  it("a camera-less scene plays while the base intent keeps the camera", () => {
    const { camera, rig, runtime } = seededDrive();
    const params = makeParams({ mode: "idle" }, camera);
    playScene(runtime, { sceneId: "bare-scene" });
    const result = driveRigWithScenes(runtime, rig, params, 1);
    expect(result.activeScene?.sceneId).toBe("bare-scene");
    expect(result.activeScene?.time).toBeCloseTo(1);
    // Idle base: the brain holds the caller pose untouched.
    expect(rig.brain.live?.position.x).toBeCloseTo(100);
    // Completion returns to the base with no handoff.
    driveRigWithScenes(runtime, rig, params, 2.5);
    expect(driveRigWithScenes(runtime, rig, params, 0.1).activeScene).toBeNull();
  });

  it("pauses a playing master timeline for the branch and resumes it on return", () => {
    const { camera, rig, runtime } = seededDrive();
    const master = createTimelinePlayer({ playing: true });
    const base: RigDriveIntent = {
      mode: "timeline",
      timeline: showTimeline,
      player: master,
      context,
      cartFrames: new Map()
    };
    const params = makeParams(base, camera);
    playScene(runtime, { sceneId: "camera-scene", blend: { durationSeconds: 0 } });
    driveRigWithScenes(runtime, rig, params, 1);
    expect(master.playing).toBe(false);

    stopScene(runtime);
    let guard = 0;
    while (runtime.active && guard < 100) {
      driveRigWithScenes(runtime, rig, params, 0.5);
      guard += 1;
    }
    expect(runtime.active).toBeNull();
    expect(master.playing).toBe(true);
  });

  it("seeks into a scene via fromTime", () => {
    const { camera, rig, runtime } = seededDrive();
    const params = makeParams({ mode: "idle" }, camera);
    playScene(runtime, { sceneId: "camera-scene", fromTime: 3, blend: { durationSeconds: 0 } });
    const result = driveRigWithScenes(runtime, rig, params, 0.25);
    expect(result.activeScene?.time).toBeCloseTo(3.25);
  });
});

describe("scene tracks (deterministic master-embed)", () => {
  const baseContext = buildContext();

  // Sub-scene: its own static shot + a cart track parking "dolly" at 42.
  const subScene = createTimeline({
    duration: 4,
    tracks: [
      { type: "camera", id: "cam", blocks: [{ id: "sb", vcamId: "wide", start: 0, end: 4 }] },
      { type: "cart", id: "ct", cartId: "dolly", keys: [{ time: 0, distance: 42 }, { time: 4, distance: 42 }] }
    ]
  });
  // A sub-scene that itself embeds another (must stay inert: depth-1).
  const nestingScene = createTimeline({
    duration: 4,
    tracks: [{ type: "scene", id: "inner", clips: [{ id: "n", sceneId: "sub", start: 0, end: 4 }] }]
  });
  const scenes = new Map([
    ["sub", subScene],
    ["nesting", nestingScene]
  ]);
  const context = { ...baseContext, getScene: (id: string) => scenes.get(id) ?? null };

  const master = createTimeline({
    duration: 20,
    tracks: [
      { type: "camera", id: "cam", blocks: [{ id: "mb", vcamId: "rail-cam", start: 0, end: 20 }] },
      // Embed at 10..14, entering the sub-scene at local 1 (offset).
      { type: "scene", id: "embeds", clips: [{ id: "e", sceneId: "sub", start: 10, end: 14, offset: 1 }] }
    ]
  });

  it("plays the embedded scene's camera inside the window and the master's outside", () => {
    const outside = evaluateTimeline(master, context, 5);
    expect(outside.activeBlock?.block.vcamId).toBe("rail-cam");
    const inside = evaluateTimeline(master, context, 11);
    expect(inside.activeBlock?.block.vcamId).toBe("wide");
    expect(inside.camera?.position.y).toBeCloseTo(5);
    const after = evaluateTimeline(master, context, 15);
    expect(after.activeBlock?.block.vcamId).toBe("rail-cam");
  });

  it("merges only carts the embedded scene tracks, at the mapped local time", () => {
    // Inside the window the sub-scene's cart track parks the dolly at 42.
    const inside = evaluateTimeline(master, context, 11);
    expect(inside.cartFrames.get("dolly")?.distance).toBeCloseTo(42);
    // Outside, the master's free-running cart (speed 10) is untouched.
    const outside = evaluateTimeline(master, context, 5);
    expect(outside.cartFrames.get("dolly")?.distance).toBeCloseTo(50);
  });

  it("keeps nesting depth-1: an embedded scene's own scene tracks are inert", () => {
    const nestingMaster = createTimeline({
      duration: 10,
      tracks: [{ type: "scene", id: "embeds", clips: [{ id: "e", sceneId: "nesting", start: 0, end: 10 }] }]
    });
    const sample = evaluateTimeline(nestingMaster, context, 2);
    expect(sample.camera).toBeNull();
  });

  it("stays inert without a getScene resolver and stays pure with one", () => {
    const withoutResolver = evaluateTimeline(master, baseContext, 11);
    expect(withoutResolver.activeBlock?.block.vcamId).toBe("rail-cam");
    const a = evaluateTimeline(master, context, 11);
    const b = evaluateTimeline(master, context, 11);
    expect(a).toEqual(b);
  });

  it("evaluateSceneLayers maps master time to scene-local time", () => {
    const layers = evaluateSceneLayers(master.tracks, (id) => scenes.get(id) ?? null, 12.5);
    expect(layers).toHaveLength(1);
    expect(layers[0]?.sceneId).toBe("sub");
    expect(layers[0]?.time).toBeCloseTo(3.5); // 12.5 - 10 + offset 1
    expect(evaluateSceneLayers(master.tracks, (id) => scenes.get(id) ?? null, 9)).toHaveLength(0);
  });

  it("buildRigRuntime rejects a scene clip referencing an unknown scene", () => {
    const document = createRigDocument({
      timelines: [
        {
          id: "show",
          ...createTimeline({
            duration: 5,
            tracks: [{ type: "scene", id: "embeds", clips: [{ id: "x", sceneId: "missing", start: 0, end: 2 }] }]
          })
        }
      ]
    });
    expect(() => buildRigRuntime(document)).toThrow(/unknown scene "missing"/);
  });
});

describe("trigger predicates and arm policies (pure)", () => {
  it("proximity enters at radius and only exits past the hysteresis band", () => {
    const target = { x: 0, y: 0, z: 0 };
    const at = (x: number) => ({ x, y: 0, z: 0 });
    let state = { inside: false };
    const step = (x: number) => {
      const edge = stepProximity(state, at(x), target, 3, 1);
      state = { inside: edge.inside };
      return edge;
    };
    expect(step(5).entered).toBe(false);
    expect(step(2.9).entered).toBe(true);
    // Boundary hover inside the band [3, 4]: no chatter in either direction.
    expect(step(3.5)).toEqual({ inside: true, entered: false, exited: false });
    expect(step(2.8)).toEqual({ inside: true, entered: false, exited: false });
    expect(step(3.9)).toEqual({ inside: true, entered: false, exited: false });
    // Past radius + hysteresis: exit fires once.
    expect(step(4.2).exited).toBe(true);
    expect(step(4.5)).toEqual({ inside: false, entered: false, exited: false });
    // Re-entry requires crossing the inner radius again.
    expect(step(3.5).entered).toBe(false);
    expect(step(2.5).entered).toBe(true);
  });

  it("arm policies gate re-firing (once / rearm-on-exit / every-time / cooldown)", () => {
    const fire = { conditionFired: true };
    const idle = { conditionFired: false };

    let once = createArmState();
    let r = stepArmPolicy(once, { type: "once" }, fire, 0.1);
    expect(r.fire).toBe(true);
    once = r.state;
    expect(stepArmPolicy(once, { type: "once" }, fire, 0.1).fire).toBe(false);

    let onExit = createArmState();
    r = stepArmPolicy(onExit, { type: "rearm-on-exit" }, fire, 0.1);
    expect(r.fire).toBe(true);
    onExit = r.state;
    r = stepArmPolicy(onExit, { type: "rearm-on-exit" }, fire, 0.1);
    expect(r.fire).toBe(false);
    onExit = r.state;
    r = stepArmPolicy(onExit, { type: "rearm-on-exit" }, { conditionFired: false, exited: true }, 0.1);
    onExit = r.state;
    expect(stepArmPolicy(onExit, { type: "rearm-on-exit" }, fire, 0.1).fire).toBe(true);

    let every = createArmState();
    r = stepArmPolicy(every, { type: "every-time" }, fire, 0.1);
    expect(r.fire).toBe(true);
    expect(stepArmPolicy(r.state, { type: "every-time" }, fire, 0.1).fire).toBe(true);

    let cool = createArmState();
    r = stepArmPolicy(cool, { type: "cooldown", seconds: 1 }, fire, 0.1);
    expect(r.fire).toBe(true);
    cool = r.state;
    r = stepArmPolicy(cool, { type: "cooldown", seconds: 1 }, fire, 0.5);
    expect(r.fire).toBe(false);
    cool = r.state;
    r = stepArmPolicy(cool, { type: "cooldown", seconds: 1 }, idle, 0.6);
    cool = r.state;
    expect(stepArmPolicy(cool, { type: "cooldown", seconds: 1 }, fire, 0.1).fire).toBe(true);
  });
});

describe("trigger runtime (stepTriggers)", () => {
  const markerScene = createTimeline({
    duration: 10,
    tracks: [
      { type: "event", id: "ev", events: [
        { id: "m1", time: 3, kind: "chapter" },
        { id: "m2", time: 5, kind: "sfx" }
      ] }
    ]
  });

  const defs = {
    triggers: [
      { id: "t-prox", source: { type: "proximity" as const, targetId: "crate", radius: 3, hysteresis: 1 }, arm: { type: "rearm-on-exit" as const } },
      { id: "t-marker", source: { type: "marker" as const, eventKind: "chapter" }, arm: { type: "every-time" as const } },
      { id: "t-click", source: { type: "click" as const, objectId: "crate" }, arm: { type: "once" as const } }
    ],
    actions: [
      { id: "a-play", type: "playScene" as const, sceneId: "detail" },
      { id: "a-pause", type: "transport" as const, op: "pause" as const }
    ],
    bindings: [
      { id: "b1", triggerId: "t-prox", actionId: "a-play" },
      { id: "b2", triggerId: "t-marker", actionId: "a-pause" },
      { id: "b3", triggerId: "t-click", actionId: "a-play", priority: 5 }
    ]
  };

  const snapshotAt = (x: number, extra: Partial<TriggerWorldSnapshot> = {}): TriggerWorldSnapshot => ({
    present: true,
    cameraPosition: { x, y: 0, z: 0 },
    resolvePosition: (id) => (id === "crate" ? { x: 0, y: 0, z: 0 } : null),
    ...extra
  });

  it("fires a proximity trigger once on entry and re-arms on exit", () => {
    const state = createTriggerRuntimeState();
    expect(stepTriggers(state, defs, snapshotAt(10), 0.1)).toHaveLength(0);
    const fired = stepTriggers(state, defs, snapshotAt(2), 0.1);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.action.type).toBe("playScene");
    // Still inside: no re-fire.
    expect(stepTriggers(state, defs, snapshotAt(2.5), 0.1)).toHaveLength(0);
    // Hover in the band: still armed=false, nothing fires.
    expect(stepTriggers(state, defs, snapshotAt(3.5), 0.1)).toHaveLength(0);
    // Exit past the band, re-enter: fires again.
    expect(stepTriggers(state, defs, snapshotAt(6), 0.1)).toHaveLength(0);
    expect(stepTriggers(state, defs, snapshotAt(1), 0.1)).toHaveLength(1);
  });

  it("markers fire on forward playback windows only (a scrub reports none)", () => {
    const state = createTriggerRuntimeState();
    // A playback step crossing t=3 fires the chapter marker.
    const fired = stepTriggers(state, defs, snapshotAt(10, {
      playback: [{ timeline: markerScene, from: 2.9, to: 3.1 }]
    }), 0.1);
    expect(fired.some((command) => command.action.type === "transport")).toBe(true);
    // The sfx marker (kind mismatch) does not match this trigger.
    expect(stepTriggers(state, defs, snapshotAt(10, {
      playback: [{ timeline: markerScene, from: 4.9, to: 5.1 }]
    }), 0.1)).toHaveLength(0);
    // A scrub is simply not reported as a playback window => nothing fires,
    // even when it jumps across every marker.
    expect(stepTriggers(state, defs, snapshotAt(10), 0.1)).toHaveLength(0);
  });

  it("stays inert and resets outside present mode", () => {
    const state = createTriggerRuntimeState();
    stepTriggers(state, defs, snapshotAt(2, { clicks: ["crate"] }), 0.1); // prox + once-click fire
    expect(state.arm.get("t-click")?.armed).toBe(false);
    // Leaving present resets everything (a spent "once" runs again next time).
    expect(stepTriggers(state, defs, { ...snapshotAt(2), present: false }, 0.1)).toHaveLength(0);
    expect(state.arm.size).toBe(0);
    const again = stepTriggers(state, defs, snapshotAt(2, { clicks: ["crate"] }), 0.1);
    expect(again.filter((command) => command.action.type === "playScene").length).toBeGreaterThan(0);
  });

  it("resolves playScene conflicts by binding priority (one per step)", () => {
    const state = createTriggerRuntimeState();
    // Proximity entry AND the click fire in the same frame; both bind playScene.
    const fired = stepTriggers(state, defs, snapshotAt(2, { clicks: ["crate"] }), 0.1);
    const plays = fired.filter((command) => command.action.type === "playScene");
    expect(plays).toHaveLength(1);
    expect(plays[0]?.bindingId).toBe("b3"); // priority 5 beats default 0
  });

  it("simulate path resolves a trigger's bound commands directly", () => {
    const commands = resolveTriggerCommands(defs, "t-prox");
    expect(commands).toHaveLength(1);
    expect(commands[0]?.action).toEqual({ id: "a-play", type: "playScene", sceneId: "detail" });
  });
});
