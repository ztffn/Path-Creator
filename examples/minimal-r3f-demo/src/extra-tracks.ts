// Demo-side timeline track types + pure evaluators for the Unity Timeline track
// kinds the core package doesn't model yet: an Activation track (toggles a bound
// scene object's visibility over clip windows), an Audio track (2D clips), and an
// Animation track (drives a bound GLB model's baked clips by time). Evaluation is
// a pure function of time t (scrub-safe, matching evaluateTimeline's determinism
// contract); statefulness lives in the appliers (directors/players).
import { sampleEasingCurve, type EasingCurve } from "@huma/path-creator/core";

/** Unity Activation Track "Post-playback state": what to do when the director stops. */
export type PostPlaybackState = "revert" | "active" | "inactive" | "leaveAsIs";

export interface ActivationClip {
  id: string;
  start: number;
  end: number;
}

/** Binds one scene object (by activatable id); the object is active while a clip covers t. */
export interface ActivationTrack {
  id: string;
  name?: string;
  objectId: string;
  clips: ActivationClip[];
  postPlaybackState: PostPlaybackState;
}

export interface AudioClip {
  id: string;
  /** Clip source URL, or `tone:<freq>` for a synthesized fallback (no asset needed). */
  src: string;
  start: number;
  duration: number;
  /** Clip-local playback start offset in seconds (default 0). */
  offset?: number;
  /** 0..1 (default 1) — master level; multiplied by the gainCurve envelope. */
  gain?: number;
  /** Optional volume envelope over clip-local normalized time (0..1 value). Flat 1 when unset. */
  gainCurve?: EasingCurve;
  loop?: boolean;
  /** Precomputed waveform envelope (flat [min,max,…], -1..1). Set at import; else derived lazily. */
  peaks?: number[];
}

export interface AudioTrack {
  id: string;
  name?: string;
  clips: AudioClip[];
  /** Track master gain 0..1 (default 1). */
  gain?: number;
  mute?: boolean;
}

/**
 * A window on the timeline that maps to one baked GLB clip. `clipStart`/`clipEnd`
 * are source-clip-local seconds: omit `clipEnd` for native-speed playback (the
 * clip advances 1:1 with t, held at its window-end frame in a following gap, and
 * loops if the window outlasts the clip); set `clipEnd` to retime — stretch to
 * slow-mo, equal to hold on a frame, or `clipEnd < clipStart` to play in reverse.
 */
export interface AnimationClip {
  id: string;
  clipName: string;
  start: number;
  end: number;
  /** Source-clip-local start in seconds (default 0). */
  clipStart?: number;
  /** Source-clip-local end in seconds; when set the window retimes to fit it. */
  clipEnd?: number;
  /**
   * What happens when the local time runs past the source clip's end (window/retime
   * outlasts the clip): "loop" (default) repeats the clip; "once" plays it a single
   * time and holds the final frame. Scrub-safe either way — a pure function of t.
   */
  loop?: "loop" | "once";
}

/** Binds one GLB model (by activatable id); its baked clips are driven over clip windows. */
export interface AnimationTrack {
  id: string;
  name?: string;
  objectId: string;
  clips: AnimationClip[];
}

/** What a bound model's mixer should show at time t: a clip at a clip-local time. */
export interface DesiredAnimation {
  clipName: string;
  /** Clip-local time in seconds to apply (via mixer.setTime). */
  localTime: number;
  /** 0..1 blend weight (1 for now). */
  weight: number;
  /** true repeats the clip when localTime exceeds its duration; false holds the last frame. */
  loop: boolean;
}

/**
 * Apply a timeline resize/move to an audio clip. A left-trim (right edge fixed, so the
 * duration changes) advances the source offset by how far the start moved, cutting the
 * head; a move (duration unchanged) or right-trim leaves the offset alone. Pure.
 */
export function resizeAudioClip(clip: AudioClip, start: number, end: number): AudioClip {
  const duration = Math.max(0.25, end - start);
  const isResize = Math.abs(duration - clip.duration) > 1e-6;
  const offset = isResize ? Math.max(0, (clip.offset ?? 0) + (start - clip.start)) : clip.offset;
  return { ...clip, start, duration, ...(offset !== undefined && { offset }) };
}

/** What the audio player should be doing with a clip at time t. */
export interface DesiredAudio {
  src: string;
  /** Absolute position within the source buffer, in seconds. */
  offset: number;
  gain: number;
  loop: boolean;
}

export interface ExtraTracks {
  activationTracks: ActivationTrack[];
  audioTracks: AudioTrack[];
  animationTracks: AnimationTrack[];
}

export const EMPTY_EXTRA_TRACKS: ExtraTracks = { activationTracks: [], audioTracks: [], animationTracks: [] };

/** Shared empty desired-audio map, to avoid a per-frame allocation when idle. */
export const EMPTY_DESIRED: ReadonlyMap<string, DesiredAudio> = new Map();

/** Snaps a time to the editing grid (quarter-second), clamped to >= 0. */
export const snapSeconds = (t: number, step = 0.25): number => Math.max(0, Math.round(t / step) * step);

/** Latest clip end across all tracks — the minimum show length that covers them. */
export function maxClipEnd(tracks: ExtraTracks): number {
  return Math.max(
    0,
    ...tracks.activationTracks.flatMap((track) => track.clips.map((clip) => clip.end)),
    ...tracks.audioTracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration)),
    ...tracks.animationTracks.flatMap((track) => track.clips.map((clip) => clip.end))
  );
}

/** Clip covers t on the half-open interval [start, end): active at start, not at end. */
function covers(start: number, end: number, t: number): boolean {
  return t >= start && t < end;
}

/**
 * Desired visibility per bound object id at time t. An object is visible iff a
 * clip on its track covers t (hidden in gaps and before the first clip). Later
 * tracks binding the same object win, mirroring camera-track layering.
 */
export function evaluateActivation(tracks: readonly ActivationTrack[], t: number): Map<string, boolean> {
  const visibility = new Map<string, boolean>();
  for (const track of tracks) {
    visibility.set(track.objectId, track.clips.some((clip) => covers(clip.start, clip.end, t)));
  }
  return visibility;
}

/**
 * Desired audio per clip id at time t: which clips should be sounding and at
 * what source offset/gain. A clip is desired iff [start, start+duration) covers
 * t; its offset advances with t so seeking mid-clip resumes at the right sample.
 */
export function evaluateAudio(tracks: readonly AudioTrack[], t: number): Map<string, DesiredAudio> {
  const desired = new Map<string, DesiredAudio>();
  for (const track of tracks) {
    if (track.mute) continue;
    const trackGain = track.gain ?? 1;
    for (const clip of track.clips) {
      if (covers(clip.start, clip.start + clip.duration, t)) {
        const localT = clip.duration > 0 ? (t - clip.start) / clip.duration : 0;
        // Volume envelope over clip-local time; raw curve value (not renormalized), clamped
        // so overshooting handles can't produce negative/>1 gain.
        const env = clip.gainCurve ? Math.min(1, Math.max(0, sampleEasingCurve(clip.gainCurve, localT))) : 1;
        desired.set(clip.id, {
          src: clip.src,
          offset: (clip.offset ?? 0) + (t - clip.start),
          gain: (clip.gain ?? 1) * trackGain * env,
          loop: clip.loop ?? false
        });
      }
    }
  }
  return desired;
}

/**
 * Desired clip + clip-local time per bound model id at time t. The active clip is
 * the last one that has started (start <= t), so a clip holds through a following
 * gap — mirroring the camera timeline's "hold" gapMode rather than Activation's
 * hide-in-gap. localTime follows the clip window's retime (see AnimationClip);
 * before a track's first clip the model is left un-driven (absent from the map).
 * Later tracks binding the same model win, mirroring evaluateActivation.
 */
export function evaluateAnimation(tracks: readonly AnimationTrack[], t: number): Map<string, DesiredAnimation> {
  const desired = new Map<string, DesiredAnimation>();
  for (const track of tracks) {
    let active: AnimationClip | null = null;
    for (const clip of track.clips) {
      if (clip.start <= t && (!active || clip.start >= active.start)) active = clip;
    }
    if (!active) continue;
    const span = active.end - active.start;
    const clipStart = active.clipStart ?? 0;
    const localTime =
      active.clipEnd !== undefined
        ? clipStart + (active.clipEnd - clipStart) * Math.min(1, Math.max(0, span > 0 ? (t - active.start) / span : 1))
        : clipStart + Math.min(Math.max(0, t - active.start), span);
    desired.set(track.objectId, { clipName: active.clipName, localTime, weight: 1, loop: active.loop !== "once" });
  }
  return desired;
}
