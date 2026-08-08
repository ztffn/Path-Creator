// Tests for the WSOLA time stretch. The property that matters is the one the whole
// feature is named for: length changes, pitch does not. Measured by counting zero
// crossings of a stretched sine rather than by ear.
import { describe, expect, it } from "vitest";
import { wsolaStretch } from "./audio-stretch";

const SAMPLE_RATE = 44100;

const sine = (freq: number, seconds: number): Float32Array => {
  const data = new Float32Array(Math.round(SAMPLE_RATE * seconds));
  for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
  return data;
};

/** Frequency estimated from sign changes over the steady middle of the signal. */
function measureHz(data: Float32Array): number {
  const from = Math.floor(data.length * 0.25);
  const to = Math.floor(data.length * 0.75);
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) {
    if ((data[i - 1]! < 0 && data[i]! >= 0) || (data[i - 1]! >= 0 && data[i]! < 0)) crossings += 1;
  }
  return (crossings * SAMPLE_RATE) / (2 * (to - from));
}

describe("wsolaStretch", () => {
  it("holds pitch while changing length", () => {
    const input = sine(440, 1);
    for (const factor of [0.5, 2]) {
      const output = wsolaStretch(input, factor, SAMPLE_RATE);
      expect(output.length).toBeCloseTo(input.length / factor, -2);
      // Within a couple of percent of 440Hz — the point is that it did not transpose.
      expect(measureHz(output)).toBeGreaterThan(430);
      expect(measureHz(output)).toBeLessThan(450);
    }
  });

  it("contrasts with a naive resample, which WOULD transpose", () => {
    // Guards the test itself: if measureHz could not detect a pitch shift, the check
    // above would pass for a broken implementation too.
    const input = sine(440, 1);
    const resampled = new Float32Array(Math.round(input.length / 2));
    for (let i = 0; i < resampled.length; i += 1) resampled[i] = input[i * 2]!;
    expect(measureHz(resampled)).toBeGreaterThan(800); // an octave up, as expected
  });

  it("returns the input untouched at factor 1 and for nonsense factors", () => {
    const input = sine(440, 1);
    expect(wsolaStretch(input, 1, SAMPLE_RATE)).toBe(input);
    expect(wsolaStretch(input, 0, SAMPLE_RATE)).toBe(input);
    expect(wsolaStretch(input, -2, SAMPLE_RATE)).toBe(input);
    expect(wsolaStretch(input, Number.NaN, SAMPLE_RATE)).toBe(input);
  });

  it("passes very short input through rather than windowing it to nothing", () => {
    const short = sine(440, 0.01);
    expect(wsolaStretch(short, 2, SAMPLE_RATE)).toBe(short);
  });

  it("preserves amplitude rather than fading across the overlap-add", () => {
    const output = wsolaStretch(sine(440, 1), 0.5, SAMPLE_RATE);
    const middle = output.subarray(Math.floor(output.length * 0.4), Math.floor(output.length * 0.6));
    let peak = 0;
    for (const v of middle) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThanOrEqual(1.05);
  });
});
