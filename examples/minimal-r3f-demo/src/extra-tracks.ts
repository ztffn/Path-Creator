// Demo working-set helpers around the portable package timeline track types.
// Runtime math and schemas live in @huma/path-creator/core; this file only groups
// the four kinds for the editor's existing per-section state shape.
import type { ActivationTrack, AnimationTrack, AudioClip, AudioTrack, TransformTrack } from "@huma/path-creator/core";

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
