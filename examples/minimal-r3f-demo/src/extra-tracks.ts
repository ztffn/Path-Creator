// Demo-side timeline track types + pure evaluators for the two Unity Timeline
// track kinds the core package doesn't model yet: an Activation track (toggles a
// bound scene object's visibility over clip windows) and an Audio track (2D
// clips). Evaluation is a pure function of time t (scrub-safe, matching
// evaluateTimeline's determinism contract); statefulness lives in the appliers.

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
  /** 0..1 (default 1). */
  gain?: number;
  loop?: boolean;
}

export interface AudioTrack {
  id: string;
  name?: string;
  clips: AudioClip[];
  /** Track master gain 0..1 (default 1). */
  gain?: number;
  mute?: boolean;
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
}

export const EMPTY_EXTRA_TRACKS: ExtraTracks = { activationTracks: [], audioTracks: [] };

/** Shared empty desired-audio map, to avoid a per-frame allocation when idle. */
export const EMPTY_DESIRED: ReadonlyMap<string, DesiredAudio> = new Map();

/** Snaps a time to the editing grid (quarter-second), clamped to >= 0. */
export const snapSeconds = (t: number, step = 0.25): number => Math.max(0, Math.round(t / step) * step);

/** Latest clip end across all tracks — the minimum show length that covers them. */
export function maxClipEnd(tracks: ExtraTracks): number {
  return Math.max(
    0,
    ...tracks.activationTracks.flatMap((track) => track.clips.map((clip) => clip.end)),
    ...tracks.audioTracks.flatMap((track) => track.clips.map((clip) => clip.start + clip.duration))
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
        desired.set(clip.id, {
          src: clip.src,
          offset: (clip.offset ?? 0) + (t - clip.start),
          gain: (clip.gain ?? 1) * trackGain,
          loop: clip.loop ?? false
        });
      }
    }
  }
  return desired;
}
