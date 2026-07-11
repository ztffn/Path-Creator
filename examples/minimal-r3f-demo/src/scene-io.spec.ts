// Round-trip tests for scene persistence: the demo's extra tracks (activation/audio/
// animation/transform) survive serializeScene -> deserializeScene, the file stays a
// valid RigDocument (extra tracks in the x-demo-tracks extension key), and a bare
// document with no extension deserializes to empty tracks (back-compat).
import { describe, expect, it } from "vitest";
import { parseRigDocument } from "@huma/path-creator/core";
import { serializeScene, deserializeScene, type DemoScene } from "./scene-io";
import { EMPTY_EXTRA_TRACKS, type ExtraTracks } from "./extra-tracks";

const extraTracks: ExtraTracks = {
  activationTracks: [{ id: "act1", objectId: "turbine", clips: [{ id: "c", start: 0, end: 2 }], postPlaybackState: "revert" }],
  audioTracks: [{ id: "aud1", name: "VO", clips: [{ id: "a", src: "/audio/x.mp3", start: 1, duration: 3 }], gain: 0.8 }],
  animationTracks: [{ id: "anim1", objectId: "fox", clips: [{ id: "k", clipName: "Run", start: 0, end: 4, loop: "once" }] }],
  transformTracks: [{ id: "xf1", objectId: "fox", position: [{ time: 0, value: [3, 0, -2] }, { time: 4, value: [8, 0, -2], easing: "linear" }] }]
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

  it("keeps the file a valid RigDocument (extra tracks in a namespaced key)", () => {
    const json = serializeScene(scene);
    // The core parser accepts it and ignores the extension key.
    expect(() => parseRigDocument(json)).not.toThrow();
    const raw = JSON.parse(json) as Record<string, unknown>;
    expect(typeof raw.schemaVersion).toBe("number");
    expect(raw["x-demo-tracks"]).toBeTruthy();
  });

  it("deserializes a bare RigDocument (no extension) to empty tracks", () => {
    const bare = serializeScene({ ...scene, extraTracks: EMPTY_EXTRA_TRACKS });
    const stripped = JSON.parse(bare) as Record<string, unknown>;
    delete stripped["x-demo-tracks"];
    expect(deserializeScene(JSON.stringify(stripped)).extraTracks).toEqual(EMPTY_EXTRA_TRACKS);
  });
});
