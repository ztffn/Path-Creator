// Regression tests for the demo's pure audio math: the per-frame gain envelope
// (evaluateAudio), the clip resize/left-trim offset rule (resizeAudioClip), and the
// waveform windowing (slicePeaksToWindow). These are where a silent regression hides.
import { describe, expect, it } from "vitest";
import { evaluateAudio, resizeAudioClip, type AudioClip, type AudioTrack } from "./extra-tracks";
import { slicePeaksToWindow } from "./audio-peaks";

const clip = (over: Partial<AudioClip> = {}): AudioClip => ({ id: "c", src: "tone:1", start: 2, duration: 6, offset: 0, ...over });

describe("evaluateAudio gain envelope", () => {
  const track: AudioTrack = {
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
});

describe("slicePeaksToWindow", () => {
  const peaks = Array.from({ length: 20 }, (_, i) => i); // 10 buckets
  it("slices to the [offset, offset+duration] fraction of the source", () => {
    expect(slicePeaksToWindow(peaks, 10, 2, 4)).toEqual(peaks.slice(4, 12)); // 0.2..0.6 -> buckets 2..6
  });
  it("returns the full peaks when the file duration is unknown", () => {
    expect(slicePeaksToWindow(peaks, 0, 2, 4)).toBe(peaks);
  });
});
