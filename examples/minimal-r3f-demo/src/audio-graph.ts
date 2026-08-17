// Builds the Web Audio graph for a set of audio tracks: one buffer source per clip,
// each scheduled at its exact context time with its exact in-point, and its gain
// automated from evaluateAudio's own math so the envelope can never diverge from the
// evaluator. ONE builder serves both live preview (an AudioContext, origin = now) and
// the offline mixdown bake (an OfflineAudioContext, origin = 0) — what you audition
// and what you export are the same graph.
import { audioClipSpeeds, evaluateAudio, type AudioClip, type AudioTrack } from "@huma/path-creator/core";

/** A set of tracks and the local clock they read at the graph's origin. */
export interface AudioGraphLayer {
  tracks: readonly AudioTrack[];
  time: number;
}

export interface BuildAudioGraphOptions {
  /** Context time the layers' clocks read at. Live: ctx.currentTime. Bake: 0. */
  originContextTime: number;
  /**
   * Decoded buffer for a source at a given stretch factor, or null when not ready.
   * A stretched buffer's time base is `sourceSeconds / stretch`, which is why in-points
   * are divided by stretch before they index it.
   */
  getBuffer: (src: string, stretch: number) => AudioBuffer | null;
  destination: AudioNode;
  /** Every src that had no buffer ready, so a live caller can reschedule once it lands. */
  onMissing?: (src: string) => void;
}

export interface ScheduledClip {
  clipId: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

// Gain is automated as a sampled value curve rather than recomputed per frame. 20Hz
// resolves any fade a human authors; the floor covers very short clips and the ceiling
// stops a long one from allocating an absurd curve.
const AUTOMATION_HZ = 20;
const MIN_AUTOMATION_POINTS = 8;
const MAX_AUTOMATION_POINTS = 1024;

/**
 * Gain over `[from, to)` of a clip's local time, sampled through evaluateAudio so the
 * curve carries the authored envelope, the automatic adjacent-clip crossfade and the
 * track gain — all of it, without restating any of that math here.
 */
function sampleGainCurve(track: AudioTrack, clip: AudioClip, from: number, to: number): Float32Array {
  const span = to - from;
  const count = Math.min(
    MAX_AUTOMATION_POINTS,
    Math.max(MIN_AUTOMATION_POINTS, Math.ceil(span * AUTOMATION_HZ))
  );
  const curve = new Float32Array(count);
  // setValueCurveAtTime spreads the points evenly over the duration with point i landing at
  // i/(count-1) — so sample on that same grid, or the whole envelope replays stretched by
  // count/(count-1) and a fade never reaches its authored final value. The last point would
  // land exactly on the clip's exclusive end and read 0, notching every tail, so it is
  // pulled a hair inside the window instead.
  const lastIndex = count - 1;
  const insideEnd = to - span * 1e-6;
  // evaluateAudio walks the whole track (the curve has to carry the adjacent-clip
  // crossfade), so hand it clips already in start order once rather than per sample.
  const ordered: AudioTrack = { ...track, clips: [...track.clips].sort((a, b) => a.start - b.start) };
  for (let i = 0; i < count; i += 1) {
    const t = Math.min(from + (span * i) / lastIndex, insideEnd);
    curve[i] = evaluateAudio([ordered], t).get(clip.id)?.gain ?? 0;
  }
  return curve;
}

/**
 * Schedule every clip that is still to be heard from the graph's origin onward.
 * Clips already underway start immediately with a matching in-point; clips ahead are
 * scheduled at their exact future context time from their true beginning — which is
 * what keeps a percussive attack intact.
 */
export function buildAudioGraph(
  context: BaseAudioContext,
  layers: readonly AudioGraphLayer[],
  options: BuildAudioGraphOptions
): ScheduledClip[] {
  const { originContextTime: origin, getBuffer, destination, onMissing } = options;
  const scheduled: ScheduledClip[] = [];

  for (const layer of layers) {
    for (const track of layer.tracks) {
      if (track.mute) continue;
      for (const clip of track.clips) {
        const clipEnd = clip.start + clip.duration;
        if (clipEnd <= layer.time || clip.duration <= 0) continue; // already finished

        const { rate, stretch, speed } = audioClipSpeeds(clip);
        const buffer = getBuffer(clip.src, stretch);
        if (!buffer) {
          onMissing?.(clip.src);
          continue;
        }

        // A clip already underway cannot be scheduled in the past, so it starts now,
        // seeking in. One ahead of the origin is scheduled at its true start from the
        // head of the file, which is the whole point — that is the attack that used to
        // be eaten by wherever the animation frame happened to land.
        const from = Math.max(clip.start, layer.time);
        const when = Math.max(origin + (from - layer.time), context.currentTime);
        const stopAt = origin + (clipEnd - layer.time);
        if (stopAt <= when) continue;
        const sourceOffset = (clip.offset ?? 0) + (from - clip.start) * speed;

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.loop = clip.loop ?? false;
        source.playbackRate.value = rate;
        const gain = context.createGain();
        source.connect(gain).connect(destination);

        // A stretched buffer is `stretch` times shorter than its source, so a source
        // in-point divides by stretch to index it.
        const bufferOffset = sourceOffset / stretch;
        const curve = sampleGainCurve(track, clip, from, clipEnd);
        gain.gain.setValueCurveAtTime(curve, when, stopAt - when);
        source.start(when, source.loop ? bufferOffset % Math.max(buffer.duration, 1e-6) : bufferOffset);
        source.stop(stopAt);

        scheduled.push({ clipId: clip.id, source, gain });
      }
    }
  }

  return scheduled;
}

/**
 * The last moment anything is still AUDIBLE, in local track time. Muted tracks are
 * excluded deliberately: this sizes the mixdown, and a muted lane running past the
 * music would otherwise pad the exported file with silence.
 */
export function audioTracksEnd(tracks: readonly AudioTrack[]): number {
  let end = 0;
  for (const track of tracks) {
    if (track.mute) continue;
    for (const clip of track.clips) end = Math.max(end, clip.start + clip.duration);
  }
  return end;
}
