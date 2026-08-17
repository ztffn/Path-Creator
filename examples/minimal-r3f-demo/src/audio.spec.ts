// Regression tests for the demo's pure audio math: the per-frame gain envelope
// (evaluateAudio), the clip resize/left-trim offset rule (resizeAudioClip), and the
// clip re-laning. The waveform windowing math moved to the package (core/audio-peaks)
// and is tested there. These are where a silent regression hides.
import { describe, expect, it } from "vitest";
import { evaluateAudio, moveAudioClipBetweenTracks, resizeAudioClip, type AudioClip, type AudioTrack } from "./extra-tracks";

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({ id: "c", src: "tone:1", start: 2, duration: 6, offset: 0, ...over });

describe("evaluateAudio gain envelope", () => {
  const track: AudioTrack = {
    type: "audio",
    id: "t",
    clips: [{ id: "c", src: "tone:1", start: 0, duration: 4, gain: 0.5, gainCurve: { type: "curve", keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }]
  };
  it("folds level x trackGain x envelope, over the half-open window", () => {
    expect(evaluateAudio([track], 0).get("c")?.gain).toBeCloseTo(0, 5); // env(0)=0
    expect(evaluateAudio([track], 2).get("c")?.gain).toBeCloseTo(0.25, 2); // 0.5 x env(0.5)=0.5
    expect(evaluateAudio([track], 3.999).get("c")?.gain).toBeCloseTo(0.5, 1); // env->1
    expect(evaluateAudio([track], 4).has("c")).toBe(false); // end is exclusive
  });
  it("applies track gain and mute", () => {
    expect(evaluateAudio([{ ...track, gain: 0.5 }], 3.999).get("c")?.gain).toBeCloseTo(0.25, 1);
    expect(evaluateAudio([{ ...track, mute: true }], 2).size).toBe(0);
  });
  it("crossfades adjacent overlapping clips with complementary weights", () => {
    const crossfadeTrack: AudioTrack = {
      type: "audio",
      id: "xf",
      clips: [
        { id: "out", src: "tone:1", start: 0, duration: 4 },
        { id: "in", src: "tone:2", start: 2, duration: 4 }
      ]
    };
    expect(evaluateAudio([crossfadeTrack], 2).get("out")?.gain).toBeCloseTo(1, 6);
    expect(evaluateAudio([crossfadeTrack], 2).get("in")?.gain).toBeCloseTo(0, 6);
    expect(evaluateAudio([crossfadeTrack], 3).get("out")?.gain).toBeCloseTo(0.5, 6);
    expect(evaluateAudio([crossfadeTrack], 3).get("in")?.gain).toBeCloseTo(0.5, 6);
    expect(evaluateAudio([crossfadeTrack], 3.999).get("out")?.gain).toBeCloseTo(0, 2);
    expect(evaluateAudio([crossfadeTrack], 3.999).get("in")?.gain).toBeCloseTo(1, 2);
  });
  it("multiplies automatic crossfade weight by authored gain and envelope", () => {
    const crossfadeTrack: AudioTrack = {
      type: "audio",
      id: "xf",
      gain: 0.5,
      clips: [
        { id: "out", src: "tone:1", start: 0, duration: 4, gain: 0.5 },
        { id: "in", src: "tone:2", start: 2, duration: 4, gainCurve: { type: "curve", keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }
      ]
    };
    expect(evaluateAudio([crossfadeTrack], 3).get("out")?.gain).toBeCloseTo(0.125, 6);
    expect(evaluateAudio([crossfadeTrack], 3).get("in")?.gain).toBeCloseTo(0.0625, 6);
  });
});

describe("resizeAudioClip", () => {
  it("left-trim advances offset by the start delta (head cut, right edge fixed)", () => {
    const r = resizeAudioClip(clip(), 4, 8); // start 2->4, end stays 8
    expect(r.duration).toBeCloseTo(4, 6);
    expect(r.offset).toBeCloseTo(2, 6);
  });
  it("right-trim and move leave the offset unchanged", () => {
    expect(resizeAudioClip(clip(), 2, 5).offset).toBeCloseTo(0, 6); // right-trim
    expect(resizeAudioClip(clip(), 5, 11).offset).toBeCloseTo(0, 6); // move (duration 6)
  });
  it("adds to an existing offset and never goes negative", () => {
    expect(resizeAudioClip(clip({ offset: 1 }), 4, 8).offset).toBeCloseTo(3, 6);
    expect(resizeAudioClip(clip({ start: 5 }), 2, 8).offset).toBeGreaterThanOrEqual(0);
  });
  it("converts the start delta to SOURCE seconds via the clip's speed", () => {
    // Same two-second left-trim as above, but the clip consumes source at 2x (rate)
    // and 6x (rate x stretch) — so it skips that much more of the file.
    expect(resizeAudioClip(clip({ rate: 2 }), 4, 8).offset).toBeCloseTo(4, 6);
    expect(resizeAudioClip(clip({ rate: 2, stretch: 3 }), 4, 8).offset).toBeCloseTo(12, 6);
    // A speed of 0 is nonsense and reads as 1, matching the evaluator.
    expect(resizeAudioClip(clip({ rate: 0 }), 4, 8).offset).toBeCloseTo(2, 6);
  });
});

describe("moveAudioClipBetweenTracks", () => {
  it("moves the complete clip into the destination lane with updated timing", () => {
    const gainCurve = { type: "curve" as const, keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] };
    const tracks: AudioTrack[] = [
      { type: "audio", id: "a", clips: [{ id: "clip", src: "voice.mp3", start: 0, duration: 4, offset: 2, gain: 0.7, gainCurve }] },
      { type: "audio", id: "b", clips: [] }
    ];
    const moved = moveAudioClipBetweenTracks(tracks, "a", "b", "clip", 3, 7);
    expect(moved[0]?.clips).toEqual([]);
    expect(moved[1]?.clips).toEqual([{ id: "clip", src: "voice.mp3", start: 3, duration: 4, offset: 2, gain: 0.7, gainCurve }]);
  });

  it("is a no-op for an invalid destination", () => {
    const tracks: AudioTrack[] = [{ type: "audio", id: "a", clips: [] }];
    expect(moveAudioClipBetweenTracks(tracks, "a", "missing", "clip", 0, 2)).toBe(tracks);
  });
});
