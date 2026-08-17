// Host-side waveform plumbing for the demo's Audio tracks: decode-once caching, the
// lazy bridge for clips whose peaks aren't precomputed, synthesized `tone:` peaks, and
// file import. The pure math — extractPeaks and slicePeaksToWindow — lives in
// @huma/path-creator/core and is re-exported here so demo call sites keep one import.
// Peaks-at-import (see importAudioFile) is the preferred path; ensurePeaks is the fallback.
import { audioClipSpeed, extractPeaks, slicePeaksToWindow, type AudioClip } from "@huma/path-creator/core";

export { extractPeaks, slicePeaksToWindow } from "@huma/path-creator/core";

const cache = new Map<string, number[]>();
const durations = new Map<string, number>();
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
        durations.set(src, audio.duration);
        onReady?.();
      })
      .catch((err) => console.warn(`[peaks] failed for ${src}`, err))
      .finally(() => inflight.delete(src));
  }
  return null;
}

/**
 * Peaks for just the slice of the source a clip plays, so the waveform matches the
 * timeline block / editor window rather than the whole file. The window is expressed in
 * SOURCE seconds, so a clip's timeline duration converts by its speed: at rate 2 a
 * four-second block shows eight seconds of file, squeezed to the block's width. Falls
 * back to the full peaks when the source duration isn't known yet (e.g. `tone:`).
 */
export function clipPeaks(clip: AudioClip, onReady?: () => void): number[] | null {
  const peaks = ensurePeaks(clip.src, onReady);
  if (!peaks) return null;
  const consumed = clip.duration * audioClipSpeed(clip);
  return slicePeaksToWindow(peaks, durations.get(clip.src) ?? 0, clip.offset ?? 0, consumed);
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
  durations.set(src, audio.duration);
  return { src, peaks, duration: audio.duration };
}
