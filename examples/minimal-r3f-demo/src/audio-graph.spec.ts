// Tests for the shared audio graph builder — the scheduling decisions that make
// preview and the offline bake identical. The headline case is the one the old
// per-frame reconciler got wrong: a clip whose start lies AHEAD of the current frame
// must be scheduled into the future and play from the head of its file, not started
// immediately part-way in. Asserted against a recording fake context, so the numbers
// are exact and need no Web Audio implementation.
import { describe, expect, it } from "vitest";
import { buildAudioGraph, audioTracksEnd, type AudioGraphLayer } from "./audio-graph";
import type { AudioClip, AudioTrack } from "@huma/path-creator/core";

interface StartCall {
  when: number;
  offset: number;
}

interface FakeSource {
  buffer: AudioBuffer | null;
  loop: boolean;
  playbackRate: { value: number };
  starts: StartCall[];
  stops: number[];
}

interface FakeGain {
  curves: { curve: Float32Array; when: number; duration: number }[];
}

function fakeContext(currentTime = 0) {
  const sources: FakeSource[] = [];
  const gains: FakeGain[] = [];
  const context = {
    currentTime,
    sampleRate: 48000,
    destination: { id: "destination" },
    createBufferSource() {
      const source: FakeSource = {
        buffer: null,
        loop: false,
        playbackRate: { value: 1 },
        starts: [],
        stops: []
      };
      sources.push(source);
      return {
        ...source,
        set buffer(value: AudioBuffer | null) { source.buffer = value; },
        get buffer() { return source.buffer; },
        set loop(value: boolean) { source.loop = value; },
        get loop() { return source.loop; },
        playbackRate: source.playbackRate,
        connect: (node: unknown) => node,
        disconnect: () => undefined,
        start: (when: number, offset: number) => source.starts.push({ when, offset }),
        stop: (when: number) => source.stops.push(when),
        onended: null
      };
    },
    createGain() {
      const gain: FakeGain = { curves: [] };
      gains.push(gain);
      return {
        gain: {
          value: 1,
          setValueCurveAtTime: (curve: Float32Array, when: number, duration: number) => {
            gain.curves.push({ curve, when, duration });
          }
        },
        connect: (node: unknown) => node,
        disconnect: () => undefined
      };
    }
  };
  return { context: context as unknown as BaseAudioContext, sources, gains };
}

const buffer = (duration = 30): AudioBuffer =>
  ({ duration, length: duration * 48000, sampleRate: 48000, numberOfChannels: 1 }) as AudioBuffer;

const track = (clips: AudioClip[], over: Partial<AudioTrack> = {}): AudioTrack =>
  ({ type: "audio", id: "t", clips, ...over });

const layer = (tracks: AudioTrack[], time: number): AudioGraphLayer => ({ tracks, time });

function build(layers: AudioGraphLayer[], currentTime = 0, origin = 0) {
  const fake = fakeContext(currentTime);
  const missing: string[] = [];
  const scheduled = buildAudioGraph(fake.context, layers, {
    originContextTime: origin,
    getBuffer: (src) => (src === "absent" ? null : buffer()),
    destination: fake.context.destination,
    onMissing: (src) => missing.push(src)
  });
  return { ...fake, scheduled, missing };
}

describe("buildAudioGraph scheduling", () => {
  it("schedules a clip that has not started yet from the HEAD of its file", () => {
    // The regression this whole change exists for. The playhead is at 1s, the clip
    // starts at 2s: it must be booked one second into the future at offset 0, so its
    // attack plays whole. The old reconciler waited for a frame past 2s and then
    // started immediately, seeking in by the frame's overshoot and eating the attack.
    const { sources } = build([layer([track([
      { id: "c", src: "shot.wav", start: 2, duration: 3 }
    ])], 1)]);
    expect(sources).toHaveLength(1);
    expect(sources[0]!.starts).toEqual([{ when: 1, offset: 0 }]);
  });

  it("starts an already-underway clip immediately, seeking in to match", () => {
    const { sources } = build([layer([track([
      { id: "c", src: "a.wav", start: 2, duration: 6, offset: 0.5 }
    ])], 3)]);
    expect(sources[0]!.starts).toEqual([{ when: 0, offset: 1.5 }]); // 0.5 in-point + 1s elapsed
  });

  it("bounds every source to the end of its clip window", () => {
    const { sources } = build([layer([track([
      { id: "c", src: "a.wav", start: 2, duration: 6 }
    ])], 3)]);
    expect(sources[0]!.stops).toEqual([5]); // clip ends at t=8, drive clock is at 3
  });

  it("puts rate on playbackRate and converts the seek-in by it", () => {
    const { sources } = build([layer([track([
      { id: "c", src: "a.wav", start: 2, duration: 6, rate: 2 }
    ])], 3)]);
    expect(sources[0]!.playbackRate.value).toBe(2);
    expect(sources[0]!.starts[0]!.offset).toBeCloseTo(2, 6); // 1s elapsed x rate 2
  });

  it("divides the in-point by stretch, since a stretched buffer has its own time base", () => {
    // rate stays 1 (pitch unchanged); the source is consumed at 2x because the buffer
    // handed over is already half as long, so one elapsed second is 2 source seconds
    // but only 1 second into that buffer.
    const { sources } = build([layer([track([
      { id: "c", src: "a.wav", start: 2, duration: 6, stretch: 2 }
    ])], 3)]);
    expect(sources[0]!.playbackRate.value).toBe(1);
    expect(sources[0]!.starts[0]!.offset).toBeCloseTo(1, 6);
  });

  it("never schedules into the past when the context clock has moved on", () => {
    // Live case: origin was captured a beat before the graph is built.
    const { sources } = build([layer([track([
      { id: "c", src: "a.wav", start: 0, duration: 4 }
    ])], 1)], 10, 9.5);
    expect(sources[0]!.starts[0]!.when).toBe(10);
  });

  it("skips muted tracks, finished clips and empty windows", () => {
    expect(build([layer([track([{ id: "c", src: "a.wav", start: 0, duration: 4 }], { mute: true })], 1)]).sources).toHaveLength(0);
    expect(build([layer([track([{ id: "c", src: "a.wav", start: 0, duration: 4 }])], 9)]).sources).toHaveLength(0);
    expect(build([layer([track([{ id: "c", src: "a.wav", start: 0, duration: 0 }])], 0)]).sources).toHaveLength(0);
  });

  it("reports a source with no decoded buffer instead of scheduling silence", () => {
    const { sources, missing } = build([layer([track([
      { id: "c", src: "absent", start: 1, duration: 4 }
    ])], 0)]);
    expect(sources).toHaveLength(0);
    expect(missing).toEqual(["absent"]);
  });
});

describe("buildAudioGraph gain automation", () => {
  it("takes its curve from evaluateAudio, so the authored envelope carries over", () => {
    const { gains } = build([layer([track([
      { id: "c", src: "a.wav", start: 0, duration: 4, gain: 0.5, gainCurve: { type: "curve", keys: [{ x: 0, y: 0 }, { x: 1, y: 1 }] } }
    ])], 0)]);
    const curve = gains[0]!.curves[0]!;
    expect(curve.when).toBe(0);
    expect(curve.duration).toBe(4);
    expect(curve.curve[0]).toBeCloseTo(0, 6); // envelope starts closed
    expect(curve.curve[curve.curve.length - 1]!).toBeGreaterThan(0.4); // and opens to level
  });

  it("carries the automatic crossfade between adjacent overlapping clips", () => {
    const { gains } = build([layer([track([
      { id: "out", src: "a.wav", start: 0, duration: 4 },
      { id: "in", src: "b.wav", start: 2, duration: 4 }
    ])], 0)]);
    const outgoing = gains[0]!.curves[0]!.curve;
    const incoming = gains[1]!.curves[0]!.curve;
    expect(outgoing[0]).toBeCloseTo(1, 6);
    expect(outgoing[outgoing.length - 1]!).toBeLessThan(0.2); // fades out across the overlap
    expect(incoming[0]).toBeCloseTo(0, 6);
    expect(incoming[incoming.length - 1]!).toBeCloseTo(1, 1); // and the neighbour fades in
  });

  it("samples strictly inside the window so the tail is not notched to zero", () => {
    const { gains } = build([layer([track([
      { id: "c", src: "a.wav", start: 0, duration: 4 }
    ])], 0)]);
    const curve = gains[0]!.curves[0]!.curve;
    expect(curve[curve.length - 1]).toBeCloseTo(1, 6);
  });
});

describe("audioTracksEnd", () => {
  it("reports the last moment any clip is still sounding", () => {
    expect(audioTracksEnd([track([
      { id: "a", src: "a.wav", start: 0, duration: 4 },
      { id: "b", src: "b.wav", start: 6, duration: 3 }
    ])])).toBe(9);
    expect(audioTracksEnd([])).toBe(0);
  });

  it("ignores muted tracks, so a muted lane cannot pad the mixdown with silence", () => {
    const audible = track([{ id: "a", src: "a.wav", start: 0, duration: 3 }]);
    const silent = { ...track([{ id: "b", src: "b.wav", start: 0, duration: 30 }]), id: "m", mute: true };
    expect(audioTracksEnd([audible, silent])).toBe(3);
  });
});
