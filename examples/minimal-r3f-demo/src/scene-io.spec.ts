// Round-trip tests for story persistence: multi-scene assemble/serialize ->
// deserialize preserves per-scene content (shot participation, extra tracks) and
// the entry marker; the file stays a valid RigDocument (schema v7 Story); legacy
// x-demo-tracks sidecars still load onto the entry scene; a scene without camera
// timing entries persists with no camera track (composition = ownership).
import { describe, expect, it } from "vitest";
import { RIG_SCHEMA_VERSION, parseRigDocument, sceneOwnsCamera, getScene } from "@huma/path-creator/core";
import {
  EMPTY_SCENE_CONTENT,
  serializeStory,
  deserializeStory,
  type DemoStory
} from "./scene-io";
import { EMPTY_EXTRA_TRACKS, type ExtraTracks } from "./extra-tracks";

const extraTracks: ExtraTracks = {
  activationTracks: [{ type: "activation", id: "act1", objectId: "turbine", clips: [{ id: "c", start: 0, end: 2 }], postPlaybackState: "revert" }],
  audioTracks: [{ type: "audio", id: "aud1", name: "VO", clips: [{ id: "a", src: "/audio/x.mp3", start: 1, duration: 3 }], gain: 0.8 }],
  animationTracks: [{ type: "animation", id: "anim1", objectId: "fox", clips: [{ id: "k", clipName: "Run", start: 0, end: 4, loop: "once" }] }],
  transformTracks: [{ type: "transform", id: "xf1", objectId: "fox", position: [{ time: 0, value: [3, 0, -2] }, { time: 4, value: [8, 0, -2], easing: "linear" }] }]
};

const story: DemoStory = {
  paths: [],
  activePathId: null,
  dollies: [],
  vcamDefs: [
    { id: "vcam-1", name: "Wide", body: { type: "static", position: { x: 0, y: 2, z: 8 }, quaternion: { x: 0, y: 0, z: 0, w: 1 } } }
  ],
  editorVcams: {},
  targets: [],
  scenes: [
    { id: "show", name: "Show", ...EMPTY_SCENE_CONTENT, shotTiming: { "vcam-1": { start: 0, end: 5 } }, extraTracks },
    { id: "detail", name: "Detail", ...EMPTY_SCENE_CONTENT }
  ],
  entrySceneId: "show"
};

describe("story persistence", () => {
  it("round-trips a multi-scene story with per-scene content and the entry marker", () => {
    const restored = deserializeStory(serializeStory(story));
    expect(restored.scenes.map((scene) => scene.id)).toEqual(["show", "detail"]);
    expect(restored.entrySceneId).toBe("show");
    expect(restored.scenes[0]?.extraTracks).toEqual(extraTracks);
    expect(restored.scenes[0]?.shotTiming).toEqual({ "vcam-1": { start: 0, end: 5 } });
    expect(restored.scenes[1]?.shotTiming).toEqual({});
    expect(restored.scenes[1]?.extraTracks).toEqual(EMPTY_EXTRA_TRACKS);
  });

  it("persists a valid current-schema document; a scene without shots has no camera track", () => {
    const json = serializeStory(story);
    const document = parseRigDocument(json);
    expect(document.schemaVersion).toBe(RIG_SCHEMA_VERSION);
    expect(document.entrySceneId).toBe("show");
    expect(sceneOwnsCamera(getScene(document, "show")!)).toBe(true);
    expect(sceneOwnsCamera(getScene(document, "detail")!)).toBe(false);
    expect(document.timelines?.[0]?.tracks.some((track) => track.type === "audio")).toBe(true);
    const raw = JSON.parse(json) as Record<string, unknown>;
    expect(raw["x-demo-tracks"]).toBeUndefined();
  });

  it("loads a legacy single-timeline document as a one-scene story", () => {
    const legacy = JSON.parse(serializeStory({ ...story, scenes: [story.scenes[0]!], entrySceneId: null })) as Record<string, unknown>;
    legacy.schemaVersion = 6;
    delete legacy.entrySceneId;
    const restored = deserializeStory(JSON.stringify(legacy));
    expect(restored.scenes).toHaveLength(1);
    expect(restored.entrySceneId).toBe("show");
  });

  it("round-trips scene embeds (sceneClips) as a scene track", () => {
    const withEmbed: DemoStory = {
      ...story,
      scenes: [
        { ...story.scenes[0]!, sceneClips: [{ id: "e1", sceneId: "detail", start: 2, end: 6, offset: 0.5 }] },
        story.scenes[1]!
      ]
    };
    const restored = deserializeStory(serializeStory(withEmbed));
    expect(restored.scenes[0]?.sceneClips).toEqual([{ id: "e1", sceneId: "detail", start: 2, end: 6, offset: 0.5 }]);
    const document = parseRigDocument(serializeStory(withEmbed));
    expect(getScene(document, "show")?.tracks.some((track) => track.type === "scene")).toBe(true);
  });

  it("imports legacy x-demo-tracks sidecars onto the entry scene", () => {
    const bare = JSON.parse(
      serializeStory({ ...story, scenes: story.scenes.map((scene) => ({ ...scene, extraTracks: EMPTY_EXTRA_TRACKS })) })
    ) as Record<string, unknown>;
    bare["x-demo-tracks"] = extraTracks;
    const restored = deserializeStory(JSON.stringify(bare));
    expect(restored.scenes[0]?.extraTracks).toEqual(extraTracks);
    expect(restored.scenes[1]?.extraTracks).toEqual(EMPTY_EXTRA_TRACKS);
  });
});
