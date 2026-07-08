// Unit tests for the pure Activation/Audio timeline evaluators. Pure functions of
// t, so these assert clip-coverage boundaries, gap/pre-first-clip hiding, track
// layering, and audio offset/gain math without any DOM/three dependency.
import { describe, expect, it } from "vitest";
import {
  evaluateActivation,
  evaluateAudio,
  type ActivationTrack,
  type AudioTrack
} from "./extra-tracks";

const activation = (objectId: string, clips: [number, number][]): ActivationTrack => ({
  id: `act-${objectId}`,
  objectId,
  postPlaybackState: "revert",
  clips: clips.map(([start, end], i) => ({ id: `${objectId}-${i}`, start, end }))
});

describe("evaluateActivation", () => {
  it("visible only inside a clip window [start, end)", () => {
    const tracks = [activation("cube", [[2, 5]])];
    expect(evaluateActivation(tracks, 1.9).get("cube")).toBe(false); // before first clip
    expect(evaluateActivation(tracks, 2).get("cube")).toBe(true); // inclusive start
    expect(evaluateActivation(tracks, 4.99).get("cube")).toBe(true);
    expect(evaluateActivation(tracks, 5).get("cube")).toBe(false); // exclusive end
    expect(evaluateActivation(tracks, 6).get("cube")).toBe(false); // gap after
  });

  it("hidden in gaps between multiple clips", () => {
    const tracks = [activation("cube", [[0, 1], [3, 4]])];
    expect(evaluateActivation(tracks, 0.5).get("cube")).toBe(true);
    expect(evaluateActivation(tracks, 2).get("cube")).toBe(false); // gap
    expect(evaluateActivation(tracks, 3.5).get("cube")).toBe(true);
  });

  it("later track binding the same object wins (layering)", () => {
    const first = activation("cube", [[0, 10]]); // would show
    const second = activation("cube", []); // shows nothing
    expect(evaluateActivation([first, second], 5).get("cube")).toBe(false);
    expect(evaluateActivation([second, first], 5).get("cube")).toBe(true);
  });

  it("independent objects evaluate independently", () => {
    const tracks = [activation("a", [[0, 2]]), activation("b", [[3, 5]])];
    const at1 = evaluateActivation(tracks, 1);
    expect(at1.get("a")).toBe(true);
    expect(at1.get("b")).toBe(false);
  });
});

const audio = (id: string, clips: AudioTrack["clips"], extra: Partial<AudioTrack> = {}): AudioTrack => ({
  id,
  clips,
  ...extra
});

describe("evaluateAudio", () => {
  it("desired only inside [start, start+duration); offset advances with t", () => {
    const tracks = [audio("music", [{ id: "c1", src: "tone:440", start: 2, duration: 4 }])];
    expect(evaluateAudio(tracks, 1.9).has("c1")).toBe(false);
    expect(evaluateAudio(tracks, 6).has("c1")).toBe(false); // exclusive end (2+4)
    const at3 = evaluateAudio(tracks, 3).get("c1");
    expect(at3?.offset).toBeCloseTo(1); // t - start
    expect(at3?.gain).toBe(1);
  });

  it("applies clip offset + clip gain × track gain", () => {
    const tracks = [
      audio("music", [{ id: "c1", src: "s", start: 0, duration: 10, offset: 5, gain: 0.5, loop: true }], { gain: 0.5 })
    ];
    const d = evaluateAudio(tracks, 2).get("c1");
    expect(d?.offset).toBeCloseTo(7); // 5 + (2-0)
    expect(d?.gain).toBeCloseTo(0.25); // 0.5 * 0.5
    expect(d?.loop).toBe(true);
  });

  it("muted track produces nothing", () => {
    const tracks = [audio("music", [{ id: "c1", src: "s", start: 0, duration: 10 }], { mute: true })];
    expect(evaluateAudio(tracks, 5).size).toBe(0);
  });

  it("overlapping clips both sound", () => {
    const tracks = [
      audio("sfx", [
        { id: "a", src: "s", start: 0, duration: 5 },
        { id: "b", src: "s", start: 3, duration: 5 }
      ])
    ];
    const desired = evaluateAudio(tracks, 4);
    expect(desired.has("a")).toBe(true);
    expect(desired.has("b")).toBe(true);
  });
});
