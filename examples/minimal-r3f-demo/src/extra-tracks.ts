// Demo working-set helpers around the portable package timeline track types.
// Runtime math and schemas live in @huma/path-creator/core; this file only groups
// the four kinds for the editor's existing per-section state shape.
import type { ActivationTrack, AnimationTrack, AudioClip, AudioTrack, TransformTrack } from "@huma/path-creator/core";
import { evaluateTransform as evalTransform, transformKeyTimes as keyTimes, transformSpan as span } from "@huma/path-creator/core";
import type { BlockSeriesData } from "@huma/path-creator/timeline-ui";

export {
  evaluateActivation,
  evaluateAnimation,
  evaluateAudio,
  evaluateTransform,
  insertTransformKey,
  snapSeconds,
  transformKeyTimes,
  transformSpan,
  upsertTransformKey,
  type ActivationClip,
  type ActivationTrack,
  type AnimationClip,
  type AnimationTrack,
  type AudioClip,
  type AudioTrack,
  type DesiredAnimation,
  type DesiredAudio,
  type DesiredTransform,
  type PostPlaybackState,
  type TransformKey,
  type TransformTrack
} from "@huma/path-creator/core";

export interface ExtraTracks {
  activationTracks: ActivationTrack[];
  audioTracks: AudioTrack[];
  animationTracks: AnimationTrack[];
  transformTracks: TransformTrack[];
}

export const EMPTY_EXTRA_TRACKS: ExtraTracks = {
  activationTracks: [], audioTracks: [], animationTracks: [], transformTracks: []
};

export function normalizeExtraTracks(value: unknown): ExtraTracks {
  const v = (value ?? {}) as Partial<Record<keyof ExtraTracks, Array<Record<string, unknown>>>>;
  return {
    activationTracks: (v.activationTracks ?? []).map((track) => ({ ...track, type: "activation" })) as ActivationTrack[],
    audioTracks: (v.audioTracks ?? []).map((track) => ({ ...track, type: "audio" })) as AudioTrack[],
    animationTracks: (v.animationTracks ?? []).map((track) => ({ ...track, type: "animation" })) as AnimationTrack[],
    transformTracks: (v.transformTracks ?? []).map((track) => ({ ...track, type: "transform" })) as TransformTrack[]
  };
}

export const hasExtraTracks = (tracks: ExtraTracks): boolean =>
  tracks.activationTracks.length > 0 || tracks.audioTracks.length > 0 ||
  tracks.animationTracks.length > 0 || tracks.transformTracks.length > 0;

export function resizeAudioClip(clip: AudioClip, start: number, end: number): AudioClip {
  const duration = Math.max(0.25, end - start);
  const resized = Math.abs(duration - clip.duration) > 1e-6;
  const offset = resized ? Math.max(0, (clip.offset ?? 0) + start - clip.start) : clip.offset;
  return { ...clip, start, duration, ...(offset !== undefined && { offset }) };
}

export function maxClipEnd(tracks: ExtraTracks): number {
  return Math.max(0,
    ...tracks.activationTracks.flatMap((track) => track.clips.map((clip) => clip.end)),
    ...tracks.audioTracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)),
    ...tracks.animationTracks.flatMap((track) => track.clips.map((clip) => clip.end)),
    ...tracks.transformTracks.flatMap((track) => [
      ...(track.position ?? []), ...(track.rotation ?? []), ...(track.scale ?? [])
    ].map((key) => key.time))
  );
}

export const EMPTY_DESIRED: ReadonlyMap<string, import("@huma/path-creator/core").DesiredAudio> = new Map();

// --- Transform-track timeline block (one lane per track: markers + faint value lines) ---

type TransformChannel = "position" | "rotation" | "scale";
const TRANSFORM_CHANNELS: TransformChannel[] = ["position", "rotation", "scale"];
// Per-axis tints for the position value curves (x = red, y = green, z = blue),
// mirroring the axis colouring in DCC animation editors (e.g. Unity's curve view).
const AXIS_TINT = ["rgba(248,113,113,0.8)", "rgba(74,222,128,0.8)", "rgba(96,165,250,0.8)"];

export interface TransformBlock {
  start: number;
  end: number;
  keyTimes: number[];
  channels: TransformChannel[];
  series: BlockSeriesData[];
}

/**
 * Build the single timeline block for a transform track: its displayed range, the
 * union of key times, and a `series` array. The position channel draws x/y/z as three
 * colored curves sharing one value range (so relative axis motion reads at a glance,
 * like a DCC curve editor); rotation and scale keys contribute markers but no curve.
 * `minWidth` pads a short/zero-span track (e.g. all keys at t=0) to a grabbable size;
 * curves and markers are sampled/placed against that displayed range so they stay
 * aligned and each diamond lands on its key's real time. Sampled through the real
 * evaluator so the curves reflect the keys' easing. Returns null for a keyless track
 * (the host draws a placeholder instead).
 */
export function transformBlock(track: TransformTrack, minWidth = 0, sampleCount = 48): TransformBlock | null {
  const range = span(track);
  if (!range) return null;
  const start = range.start;
  const end = Math.max(range.end, start + minWidth);
  const width = end - start;
  const times = [...new Set(keyTimes(track))].sort((a, b) => a - b);
  const channels = TRANSFORM_CHANNELS.filter((channel) => (track[channel]?.length ?? 0) > 0);
  const series: BlockSeriesData[] = [];
  if (track.position?.length) {
    const axes: [number[], number[], number[]] = [[], [], []];
    for (let i = 0; i < sampleCount; i += 1) {
      // Sample across the DISPLAYED range; past the last key the evaluator holds, so
      // any min-width padding reads as a flat tail rather than a stretched motion.
      const t = width > 0 ? start + (width * i) / (sampleCount - 1) : start;
      const p = evalTransform([track], t).get(track.objectId)?.position ?? [0, 0, 0];
      axes[0].push(p[0]); axes[1].push(p[1]); axes[2].push(p[2]);
    }
    // Share one value range across x/y/z so a still axis stays flat while a moving one
    // rises — the three curves are comparable, not each stretched to fill the height.
    const flat = [...axes[0], ...axes[1], ...axes[2]];
    const min = Math.min(...flat), spanV = Math.max(...flat) - min;
    for (let a = 0; a < 3; a += 1) {
      const raw = axes[a]!;
      const points = spanV < 1e-9 ? raw.map(() => 0.5) : raw.map((v) => (v - min) / spanV);
      series.push({ kind: "line", points, color: AXIS_TINT[a]! });
    }
  }
  series.push({ kind: "markers", points: width > 0 ? times.map((t) => (t - start) / width) : [0], color: "rgba(255,255,255,0.85)" });
  return { start, end, keyTimes: times, channels, series };
}
