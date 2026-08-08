// Tests for the pure waveform helpers in core: downsampling a decoded buffer to a
// min/max envelope, and slicing that envelope to the window a clip actually covers.
// Both are what any consumer drawing a timeline needs, which is why they live in core
// rather than in the demo.
import { describe, expect, it } from "vitest";
import { extractPeaks, slicePeaksToWindow, type ChannelSource } from "../src/core";

const source = (samples: number[]): ChannelSource => ({
  getChannelData: () => Float32Array.from(samples)
});

describe("extractPeaks", () => {
  it("reduces each bucket to its min and max", () => {
    // Four samples into two buckets: [1, -1] then [0.5, -0.25].
    expect(extractPeaks(source([1, -1, 0.5, -0.25]), 2)).toEqual([-1, 1, -0.25, 0.5]);
  });

  it("never invents more buckets than there are samples", () => {
    expect(extractPeaks(source([1, -1]), 512)).toHaveLength(4); // 2 buckets x [min, max]
  });

  it("reports a silent region as a flat pair rather than as noise", () => {
    expect(extractPeaks(source([0, 0, 0, 0]), 2)).toEqual([0, 0, 0, 0]);
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

  it("clamps a window running past the end of the file", () => {
    expect(slicePeaksToWindow(peaks, 10, 8, 30)).toEqual(peaks.slice(16));
  });

  it("always yields at least one bucket, so a zero-length window still draws", () => {
    expect(slicePeaksToWindow(peaks, 10, 3, 0)).toHaveLength(2);
  });
});
