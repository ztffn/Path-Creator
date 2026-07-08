// Waveform peak extraction for the demo's Audio tracks. `extractPeaks` downsamples
// a decoded AudioBuffer to a compact [min,max,…] envelope the timeline's BlockSeries
// draws. `ensurePeaks` is the lazy bridge for clips whose peaks aren't precomputed:
// it decodes each src once (via an OfflineAudioContext, no user gesture) into a
// module cache and notifies on completion. `tone:<freq>` peaks are synthesized.
// Peaks-at-import (see importAudioFile) is the preferred path; this is the fallback.

/** Downsample channel 0 to `buckets` [min,max] pairs (flat array, values in -1..1). */
export function extractPeaks(buffer: AudioBuffer, buckets = 512): number[] {
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

const cache = new Map<string, number[]>();
const inflight = new Set<string>();
let decodeCtx: OfflineAudioContext | null = null;

function ctx(): OfflineAudioContext {
  if (!decodeCtx) decodeCtx = new OfflineAudioContext(1, 1, 44100);
  return decodeCtx;
}

/** Flat-band peaks for a synthesized sine (amplitude matches audio-player.ts). */
function tonePeaks(buckets = 512, amp = 0.2): number[] {
  const peaks = new Array<number>(buckets * 2);
  for (let i = 0; i < buckets; i++) {
    peaks[i * 2] = -amp;
    peaks[i * 2 + 1] = amp;
  }
  return peaks;
}

/**
 * Peaks for `src`, or null while decoding. Decodes once per src and caches; calls
 * `onReady` when a decode completes so the caller can re-render. `tone:` is synthetic.
 */
export function ensurePeaks(src: string, onReady?: () => void): number[] | null {
  const cached = cache.get(src);
  if (cached) return cached;
  if (src.startsWith("tone:")) {
    const peaks = tonePeaks();
    cache.set(src, peaks);
    return peaks;
  }
  if (!inflight.has(src)) {
    inflight.add(src);
    void fetch(src)
      .then((r) => r.arrayBuffer())
      .then((buf) => ctx().decodeAudioData(buf))
      .then((audio) => {
        cache.set(src, extractPeaks(audio));
        onReady?.();
      })
      .catch((err) => console.warn(`[peaks] failed for ${src}`, err))
      .finally(() => inflight.delete(src));
  }
  return null;
}

/**
 * Import an uploaded audio file: decode it, extract peaks, and return everything an
 * AudioClip needs. The waveform then renders immediately from the stored `peaks` (no
 * decode-on-render); `src` is a blob URL the AudioTrackPlayer can fetch for playback.
 */
export async function importAudioFile(file: File): Promise<{ src: string; peaks: number[]; duration: number }> {
  const audio = await ctx().decodeAudioData(await file.arrayBuffer());
  const src = URL.createObjectURL(file);
  const peaks = extractPeaks(audio);
  cache.set(src, peaks); // so the lazy path never re-decodes this blob
  return { src, peaks, duration: audio.duration };
}
