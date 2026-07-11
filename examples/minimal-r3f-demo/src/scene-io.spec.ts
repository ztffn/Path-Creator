// Round-trip tests for scene persistence: the demo's extra tracks (activation/audio/
// animation/transform) survive serializeScene -> deserializeScene, the file stays a
// valid RigDocument (tracks embedded in its timeline), while legacy sidecars still load.
import { describe, expect, it } from "vitest";
import { parseRigDocument } from "@huma/path-creator/core";
import { serializeScene, deserializeScene, type DemoScene } from "./scene-io";
import { EMPTY_EXTRA_TRACKS, type ExtraTracks } from "./extra-tracks";

const extraTracks: ExtraTracks = {
  activationTracks: [{ type: "activation", id: "act1", objectId: "turbine", clips: [{ id: "c", start: 0, end: 2 }], postPlaybackState: "revert" }],
  audioTracks: [{ type: "audio", id: "aud1", name: "VO", clips: [{ id: "a", src: "/audio/x.mp3", start: 1, duration: 3 }], gain: 0.8 }],
  animationTracks: [{ type: "animation", id: "anim1", objectId: "fox", clips: [{ id: "k", clipName: "Run", start: 0, end: 4, loop: "once" }] }],
  transformTracks: [{ type: "transform", id: "xf1", objectId: "fox", position: [{ time: 0, value: [3, 0, -2] }, { time: 4, value: [8, 0, -2], easing: "linear" }] }]
};

const scene: DemoScene = {
  paths: [],
  activePathId: null,
  dollies: [],
  vcamDefs: [],
  editorVcams: {},
  shotTiming: {},
  dollyRuns: {},
  fovAnimations: {},
  targets: [],
  extraTracks
};

describe("scene extra-tracks portability", () => {
  it("round-trips all four extra-track kinds through serialize -> deserialize", () => {
    const restored = deserializeScene(serializeScene(scene));
    expect(restored.extraTracks).toEqual(extraTracks);
  });

  it("embeds the tracks in the typed RigDocument timeline", () => {
    const json = serializeScene(scene);
    const document = parseRigDocument(json);
    expect(document.timelines?.[0]?.tracks.some((track) => track.type === "audio")).toBe(true);
    const raw = JSON.parse(json) as Record<string, unknown>;
    expect(typeof raw.schemaVersion).toBe("number");
    expect(raw["x-demo-tracks"]).toBeUndefined();
  });

  it("imports legacy x-demo-tracks sidecars", () => {
    const bare = JSON.parse(serializeScene({ ...scene, extraTracks: EMPTY_EXTRA_TRACKS })) as Record<string, unknown>;
    bare["x-demo-tracks"] = extraTracks;
    expect(deserializeScene(JSON.stringify(bare)).extraTracks).toEqual(extraTracks);
  });
});
