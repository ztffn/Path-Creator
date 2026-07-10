// Demo-side timeline track types + pure evaluators for the Unity Timeline track
// kinds the core package doesn't model yet: an Activation track (visibility over
// clip windows), an Audio track (2D clips), an Animation track (a GLB's baked clips
// by time), and a Transform track (keyframed position/rotation/scale for any object,
// no baked clip needed). Evaluation is a pure function of time t (scrub-safe,
// matching evaluateTimeline's determinism); statefulness lives in the appliers.
import { evaluateEasing, lerp, sampleEasingCurve, type Easing, type EasingCurve } from "@huma/path-creator/core";

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

/** One keyframe on a transform channel: a vec3 value at a time, eased in from the previous key. */
export interface TransformKey {
  time: number;
  value: [number, number, number];
  /** Easing applied over the segment ending at this key (default linear). */
  easing?: Easing;
}

/**
 * Keyframed local transform for any bound object (primitive or GLB) — no baked clip
 * needed. Each channel is an independent, time-sorted key list; an absent channel is
 * left untouched. Rotation values are Euler degrees (XYZ); scale is per-axis.
 */
export interface TransformTrack {
  id: string;
  name?: string;
  objectId: string;
  position?: TransformKey[];
  rotation?: TransformKey[];
  scale?: TransformKey[];
}

/** Local transform to write at time t; only the channels the track keys are present. */
export interface DesiredTransform {
  position?: [number, number, number];
  /** Quaternion (x,y,z,w) — slerped from the Euler-degree keys along the shortest arc. */
  rotation?: [number, number, number, number];
  scale?: [number, number, number];
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
  transformTracks: TransformTrack[];
}

export const EMPTY_EXTRA_TRACKS: ExtraTracks = { activationTracks: [], audioTracks: [], animationTracks: [], transformTracks: [] };

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
    ...tracks.animationTracks.flatMap((track) => track.clips.map((clip) => clip.end)),
    ...tracks.transformTracks.flatMap((track) => transformKeyTimes(track))
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

type Quat = [number, number, number, number];

/** Quaternion (x,y,z,w) from Euler degrees in three.js 'XYZ' order (matches Object3D.rotation). */
function eulerDegToQuat(e: readonly [number, number, number]): Quat {
  const h = Math.PI / 360; // deg -> rad, halved
  const c1 = Math.cos(e[0] * h), s1 = Math.sin(e[0] * h);
  const c2 = Math.cos(e[1] * h), s2 = Math.sin(e[1] * h);
  const c3 = Math.cos(e[2] * h), s3 = Math.sin(e[2] * h);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 + s1 * s2 * c3,
    c1 * c2 * c3 - s1 * s2 * s3
  ];
}

/** Shortest-arc slerp between two unit quaternions (falls back to normalized lerp when near-parallel). */
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let [bx, by, bz, bw] = b;
  if (dot < 0) { dot = -dot; bx = -bx; by = -by; bz = -bz; bw = -bw; } // pick the short way round
  if (dot > 0.9995) {
    const x = a[0] + (bx - a[0]) * t, y = a[1] + (by - a[1]) * t, z = a[2] + (bz - a[2]) * t, w = a[3] + (bw - a[3]) * t;
    const l = Math.hypot(x, y, z, w) || 1;
    return [x / l, y / l, z / l, w / l];
  }
  const theta0 = Math.acos(dot), sin0 = Math.sin(theta0);
  const s0 = Math.sin((1 - t) * theta0) / sin0, s1 = Math.sin(t * theta0) / sin0;
  return [a[0] * s0 + bx * s1, a[1] * s0 + by * s1, a[2] * s0 + bz * s1, a[3] * s0 + bw * s1];
}

/**
 * Locate where t falls on a keyframe channel: `hold` at an end (before the first /
 * after the last key), else the bracketing pair `a`,`b` with the eased blend factor
 * `e`. Assumes keys are non-empty and time-sorted. Shared by the vec3 + rotation samplers.
 */
type KeySegment = { hold: TransformKey } | { a: TransformKey; b: TransformKey; e: number };
function findKeySegment(keys: readonly TransformKey[], t: number): KeySegment {
  const first = keys[0]!;
  if (t <= first.time) return { hold: first };
  const last = keys[keys.length - 1]!;
  if (t >= last.time) return { hold: last };
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t > b.time) continue;
    const span = b.time - a.time;
    return { a, b, e: span > 0 ? evaluateEasing((t - a.time) / span, b.easing ?? "linear") : 1 };
  }
  return { hold: last };
}

/** Sample a keyframed rotation channel at t as a quaternion (shortest-arc slerp between keys). */
function sampleRotationChannel(keys: readonly TransformKey[], t: number): Quat {
  const seg = findKeySegment(keys, t);
  return "hold" in seg ? eulerDegToQuat(seg.hold.value) : slerpQuat(eulerDegToQuat(seg.a.value), eulerDegToQuat(seg.b.value), seg.e);
}

/** Sample a keyframed vec3 channel at t (eased per-axis lerp between keys). */
function sampleTransformChannel(keys: readonly TransformKey[], t: number): [number, number, number] {
  const seg = findKeySegment(keys, t);
  if ("hold" in seg) return seg.hold.value;
  const { a, b, e } = seg;
  return [lerp(a.value[0], b.value[0], e), lerp(a.value[1], b.value[1], e), lerp(a.value[2], b.value[2], e)];
}

/**
 * Desired local transform per bound object id at t. Each present, non-empty channel
 * is sampled independently (rotation as a shortest-arc-slerped quaternion). Later
 * tracks binding the same object merge channel-wise (a later track overrides only the
 * channels it keys) — the entry is reused/mutated in place, no per-frame copy.
 */
export function evaluateTransform(tracks: readonly TransformTrack[], t: number): Map<string, DesiredTransform> {
  const desired = new Map<string, DesiredTransform>();
  for (const track of tracks) {
    const entry: DesiredTransform = desired.get(track.objectId) ?? {};
    if (track.position?.length) entry.position = sampleTransformChannel(track.position, t);
    if (track.rotation?.length) entry.rotation = sampleRotationChannel(track.rotation, t);
    if (track.scale?.length) entry.scale = sampleTransformChannel(track.scale, t);
    if (entry.position || entry.rotation || entry.scale) desired.set(track.objectId, entry);
  }
  return desired;
}

/** Every keyframe time across a transform track's channels (unsorted) — for spans/bounds. */
export function transformKeyTimes(track: TransformTrack): number[] {
  return [...(track.position ?? []), ...(track.rotation ?? []), ...(track.scale ?? [])].map((k) => k.time);
}

/**
 * Insert a keyframe at `time` holding the value active there (the prior key's value,
 * or the first key's, or `fallback`) so inserting doesn't jump the pose. No-op if a
 * key already sits at that time. Returns a new time-sorted list.
 */
export function insertTransformKey(keys: TransformKey[] | undefined, time: number, fallback: [number, number, number]): TransformKey[] {
  const list = keys ?? [];
  if (list.some((k) => Math.abs(k.time - time) < 1e-6)) return list;
  const prior = list.filter((k) => k.time <= time).sort((a, b) => a.time - b.time).pop();
  const value = (prior ?? list[0])?.value ?? fallback;
  const copy: [number, number, number] = [value[0], value[1], value[2]];
  return [...list, { time, value: copy }].sort((a, b) => a.time - b.time);
}

/** Set the keyframe at `time` to `value` (replacing an existing one there, keeping its easing), else insert it. Time-sorted. */
export function upsertTransformKey(keys: TransformKey[] | undefined, time: number, value: [number, number, number]): TransformKey[] {
  const list = keys ?? [];
  const existing = list.find((k) => Math.abs(k.time - time) < 1e-6);
  const rest = list.filter((k) => Math.abs(k.time - time) >= 1e-6);
  const key: TransformKey = { time, value: [value[0], value[1], value[2]], ...(existing?.easing && { easing: existing.easing }) };
  return [...rest, key].sort((a, b) => a.time - b.time);
}

/** The [first, last] keyed time across all channels, or null when the track has no keys. */
export function transformSpan(track: TransformTrack): { start: number; end: number } | null {
  const times = transformKeyTimes(track);
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}
