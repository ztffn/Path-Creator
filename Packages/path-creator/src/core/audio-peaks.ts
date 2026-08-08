// Waveform peak extraction and windowing for audio clips: pure array math with no
// engine, DOM or Web Audio dependency. Lives in core because any consumer drawing a
// timeline needs the same envelope the editor draws, and because the windowing rule
// (which slice of a source a clip actually covers) is part of the clip's meaning, not
// a rendering detail. Decoding, caching and file import stay with the host.

/**
 * The minimum of an AudioBuffer this needs. Typed structurally rather than as
 * AudioBuffer so core stays free of the DOM lib — a real AudioBuffer satisfies it.
 */
export interface ChannelSource {
  getChannelData(channel: number): Float32Array;
}

/**
 * Downsample channel 0 to `buckets` [min, max] pairs (a flat array, values in -1..1).
 * Returns fewer pairs than asked when the source has fewer samples than buckets.
 */
export function extractPeaks(buffer: ChannelSource, buckets = 512): number[] {
  const data = buffer.getChannelData(0);
  const n = Math.min(buckets, data.length);
  const peaks = new Array<number>(n * 2);
  const step = data.length / n;
  for (let i = 0; i < n; i++) {
    const from = Math.floor(i * step);
    const to = Math.min(data.length, Math.floor((i + 1) * step));
    let min = 0;
    let max = 0;
    for (let j = from; j < to; j++) {
      const v = data[j]!;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }
  return peaks;
}

/**
 * Slice full-file peaks to the `[offset, offset + duration]` window, both in SOURCE
 * seconds — so a clip playing at a non-unit speed must pass `duration * speed`, not its
 * timeline duration. Returns the input unchanged when the file duration is unknown (<= 0).
 */
export function slicePeaksToWindow(peaks: number[], fileDuration: number, offset: number, duration: number): number[] {
  if (!fileDuration || fileDuration <= 0) return peaks;
  const n = peaks.length / 2;
  const from = Math.max(0, Math.min(1, offset / fileDuration));
  const to = Math.max(from, Math.min(1, (offset + duration) / fileDuration));
  const i0 = Math.floor(from * n);
  const i1 = Math.max(i0 + 1, Math.ceil(to * n));
  return peaks.slice(i0 * 2, i1 * 2);
}
