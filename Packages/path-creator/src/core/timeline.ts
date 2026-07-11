// Timeline schema: the versioned, persistable description of a show —
// camera blocks (which vcam is live, with blend-in windows and per-block
// definition overrides such as retargets), cart distance keyframes, and
// opaque host events. Pure data with no engine dependency; the evaluator
// and player live in the timeline entry point.
import { evaluateEasing, normalizeEasing, sampleEasingCurve } from "./easing";
import type { Easing, EasingCurve } from "./easing";
import type { VirtualCameraBlendCurve, VirtualCameraDefinition, VirtualCameraLens } from "./virtual-camera";

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// v2: CartKey.easing / TimelineBlendIn.curve accept a custom cubic-bezier object
// (in addition to the named presets); legacy string easing stays valid.
// v4: portable activation/audio/animation/transform tracks.
export const TIMELINE_SCHEMA_VERSION = 4;

export interface TimelineBlendIn {
  durationSeconds: number;
  curve?: VirtualCameraBlendCurve;
}

/**
 * A single lens field eased from `from`→`to` across a block's window (block-local
 * t, normalized 0..1). `easing` defaults to easeInOut. The resolved value replaces
 * that field on the block's snapshot before blend/apply — so it composes with
 * block-to-block blends automatically.
 */
export interface LensFieldAnimation {
  from: number;
  to: number;
  easing?: Easing;
}

/** Per-field lens automation over a CameraBlock (any numeric lens field). */
export type CameraBlockLensAnimation = Partial<Record<keyof VirtualCameraLens, LensFieldAnimation>>;

export interface CameraBlock {
  id: string;
  vcamId: string;
  start: number;
  end: number;
  /** Blend from the previous block's shot over this window; omit to cut. */
  blendIn?: TimelineBlendIn;
  /**
   * Shallow per-field patch of the vcam definition while this block is live
   * (e.g. { aim: { type: "track", target: { targetId } } } retargets the
   * shot). A patched field replaces the definition's field entirely.
   */
  overrides?: Partial<Omit<VirtualCameraDefinition, "id">>;
  /**
   * Lens fields that animate across this block (e.g. a FOV push). Sampled at
   * block-local t and folded into the resolved lens; blends with neighbours.
   */
  lensAnimation?: CameraBlockLensAnimation;
}

export interface CameraTrack {
  type: "camera";
  id: string;
  name?: string;
  blocks: CameraBlock[];
}

export interface CartKey {
  time: number;
  distance: number;
  /** Interpolation from this key to the next (default linear). */
  easing?: VirtualCameraBlendCurve;
}

export interface CartTrack {
  type: "cart";
  id: string;
  name?: string;
  cartId: string;
  keys: CartKey[];
}

export interface TimelineEvent {
  id: string;
  time: number;
  kind: string;
  payload?: unknown;
}

export interface EventTrack {
  type: "event";
  id: string;
  name?: string;
  events: TimelineEvent[];
}

export type PostPlaybackState = "revert" | "active" | "inactive" | "leaveAsIs";
export interface ActivationClip { id: string; start: number; end: number; }
export interface ActivationTrack {
  type: "activation"; id: string; name?: string; objectId: string;
  clips: ActivationClip[]; postPlaybackState: PostPlaybackState;
}
export interface AudioClip {
  id: string; src: string; start: number; duration: number; offset?: number;
  gain?: number; gainCurve?: EasingCurve; loop?: boolean; peaks?: number[];
}
export interface AudioTrack {
  type: "audio"; id: string; name?: string; clips: AudioClip[]; gain?: number; mute?: boolean;
}
export interface AnimationClip {
  id: string; clipName: string; start: number; end: number;
  clipStart?: number; clipEnd?: number; loop?: "loop" | "once";
}
export interface AnimationTrack {
  type: "animation"; id: string; name?: string; objectId: string; clips: AnimationClip[];
}
export interface TransformKey { time: number; value: [number, number, number]; easing?: Easing; }
export interface TransformTrack {
  type: "transform"; id: string; name?: string; objectId: string;
  position?: TransformKey[]; rotation?: TransformKey[]; scale?: TransformKey[];
}

export type TimelineTrack = CameraTrack | CartTrack | EventTrack | ActivationTrack | AudioTrack | AnimationTrack | TransformTrack;

export interface Timeline {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  duration: number;
  /**
   * Camera behavior in gaps between blocks: "hold" keeps the last shot
   * (editing-software semantics, default); "release" returns null so the
   * host's live camera takes over (Cinemachine semantics).
   */
  gapMode?: "hold" | "release";
  tracks: TimelineTrack[];
}

export function createTimeline(init: Partial<Omit<Timeline, "schemaVersion">> = {}): Timeline {
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    duration: init.duration ?? 0,
    ...(init.gapMode && { gapMode: init.gapMode }),
    tracks: sortTimelineTracks(init.tracks ?? [])
  };
}

/** Coerce each animated lens field's easing through normalizeEasing (deserialize boundary). */
function normalizeLensAnimationEasing(anim: CameraBlockLensAnimation): CameraBlockLensAnimation {
  const out: CameraBlockLensAnimation = {};
  for (const [key, field] of Object.entries(anim) as [keyof VirtualCameraLens, LensFieldAnimation][]) {
    out[key] = field.easing === undefined ? field : { ...field, easing: normalizeEasing(field.easing) };
  }
  return out;
}

/**
 * Coerce every easing value in a timeline (cart-key easing, camera blend curves,
 * lens-animation curves) through normalizeEasing, so a malformed/foreign persisted
 * easing degrades to a valid preset rather than reaching the evaluator as NaN.
 * Applied at the deserialization boundary.
 */
export function normalizeTimelineEasing<T extends Timeline>(timeline: T): T {
  const tracks = timeline.tracks.map((track): TimelineTrack => {
    if (track.type === "cart") {
      return { ...track, keys: track.keys.map((k) => (k.easing === undefined ? k : { ...k, easing: normalizeEasing(k.easing) })) };
    }
    if (track.type === "camera") {
      return {
        ...track,
        blocks: track.blocks.map((b) => ({
          ...b,
          ...(b.blendIn?.curve !== undefined && { blendIn: { ...b.blendIn, curve: normalizeEasing(b.blendIn.curve) } }),
          ...(b.lensAnimation && { lensAnimation: normalizeLensAnimationEasing(b.lensAnimation) })
        }))
      };
    }
    if (track.type === "audio") {
      return {
        ...track,
        clips: track.clips.map((clip) => {
          if (!clip.gainCurve) return clip;
          const normalized = normalizeEasing(clip.gainCurve);
          if (typeof normalized === "object") return { ...clip, gainCurve: normalized };
          const { gainCurve: _invalid, ...withoutCurve } = clip;
          return withoutCurve;
        })
      };
    }
    if (track.type === "transform") {
      const normalizeKeys = (keys?: TransformKey[]) => keys?.map((key) => key.easing === undefined ? key : { ...key, easing: normalizeEasing(key.easing) });
      return { ...track, ...(track.position && { position: normalizeKeys(track.position)! }), ...(track.rotation && { rotation: normalizeKeys(track.rotation)! }), ...(track.scale && { scale: normalizeKeys(track.scale)! }) };
    }
    return track;
  });
  return { ...timeline, tracks };
}

/**
 * Returns tracks with blocks/keys/events sorted by time. Evaluation relies on
 * this order as an invariant so the per-frame hot path never sorts; construct
 * timelines via createTimeline (or run documents through buildRigRuntime),
 * and re-sort after editing block times.
 */
export function sortTimelineTracks(tracks: TimelineTrack[]): TimelineTrack[] {
  return tracks.map((track) => {
    if (track.type === "camera") {
      return { ...track, blocks: [...track.blocks].sort((a, b) => a.start - b.start) };
    }
    if (track.type === "cart") {
      return { ...track, keys: [...track.keys].sort((a, b) => a.time - b.time) };
    }
    if (track.type === "event") return { ...track, events: [...track.events].sort((a, b) => a.time - b.time) };
    if (track.type === "transform") {
      const sorted = (keys?: TransformKey[]) => keys ? [...keys].sort((a, b) => a.time - b.time) : undefined;
      return { ...track, ...(track.position && { position: sorted(track.position)! }), ...(track.rotation && { rotation: sorted(track.rotation)! }), ...(track.scale && { scale: sorted(track.scale)! }) };
    }
    if (track.type === "activation") return { ...track, clips: [...track.clips].sort((a, b) => a.start - b.start) };
    if (track.type === "audio") return { ...track, clips: [...track.clips].sort((a, b) => a.start - b.start) };
    return { ...track, clips: [...track.clips].sort((a, b) => a.start - b.start) };
  });
}

export interface DesiredAudio { src: string; offset: number; gain: number; loop: boolean; }
export interface DesiredAnimation { clipName: string; localTime: number; weight: number; loop: boolean; }
export interface DesiredTransform {
  position?: [number, number, number]; rotation?: [number, number, number, number]; scale?: [number, number, number];
}

const covers = (start: number, end: number, t: number): boolean => t >= start && t < end;
export const snapSeconds = (t: number, step = 0.25): number => Math.max(0, Math.round(t / step) * step);

export function evaluateActivation(tracks: readonly ActivationTrack[], t: number): Map<string, boolean> {
  const result = new Map<string, boolean>();
  for (const track of tracks) result.set(track.objectId, track.clips.some((clip) => covers(clip.start, clip.end, t)));
  return result;
}

export function evaluateAudio(tracks: readonly AudioTrack[], t: number): Map<string, DesiredAudio> {
  const result = new Map<string, DesiredAudio>();
  for (const track of tracks) {
    if (track.mute) continue;
    const ordered = [...track.clips].sort((a, b) => a.start - b.start);
    for (let i = 0; i < ordered.length; i += 1) {
      const clip = ordered[i]!;
      if (!covers(clip.start, clip.start + clip.duration, t)) continue;
      const localT = clip.duration > 0 ? (t - clip.start) / clip.duration : 0;
      const envelope = clip.gainCurve ? Math.min(1, Math.max(0, sampleEasingCurve(clip.gainCurve, localT))) : 1;
      let crossfade = 1;
      const previous = ordered[i - 1];
      const previousEnd = previous ? previous.start + previous.duration : 0;
      if (previous && clip.start < previousEnd) crossfade *= Math.min(1, Math.max(0, (t - clip.start) / (previousEnd - clip.start)));
      const next = ordered[i + 1];
      const end = clip.start + clip.duration;
      if (next && next.start < end && t >= next.start) crossfade *= 1 - Math.min(1, Math.max(0, (t - next.start) / (end - next.start)));
      result.set(clip.id, { src: clip.src, offset: (clip.offset ?? 0) + t - clip.start, gain: (clip.gain ?? 1) * (track.gain ?? 1) * envelope * crossfade, loop: clip.loop ?? false });
    }
  }
  return result;
}

function sampleAnimationClip(clip: AnimationClip, t: number, weight: number): DesiredAnimation {
  const span = clip.end - clip.start;
  const start = clip.clipStart ?? 0;
  const progress = Math.min(1, Math.max(0, span > 0 ? (t - clip.start) / span : 1));
  return { clipName: clip.clipName, localTime: clip.clipEnd === undefined ? start + Math.min(Math.max(0, t - clip.start), span) : start + (clip.clipEnd - start) * progress, weight, loop: clip.loop !== "once" };
}

export function evaluateAnimation(tracks: readonly AnimationTrack[], t: number): Map<string, DesiredAnimation[]> {
  const result = new Map<string, DesiredAnimation[]>();
  for (const track of tracks) {
    const started = track.clips.filter((clip) => clip.start <= t).sort((a, b) => a.start - b.start);
    const active = started.at(-1);
    if (!active) continue;
    const outgoing = started.at(-2);
    if (outgoing && t < outgoing.end && active.start < outgoing.end && outgoing.clipName !== active.clipName) {
      const incoming = Math.min(1, Math.max(0, (t - active.start) / (outgoing.end - active.start)));
      result.set(track.objectId, [sampleAnimationClip(outgoing, t, 1 - incoming), sampleAnimationClip(active, t, incoming)]);
    } else result.set(track.objectId, [sampleAnimationClip(active, t, 1)]);
  }
  return result;
}

type Quat = [number, number, number, number];
function eulerDegToQuat(e: readonly [number, number, number]): Quat {
  const h = Math.PI / 360, c1 = Math.cos(e[0] * h), s1 = Math.sin(e[0] * h), c2 = Math.cos(e[1] * h), s2 = Math.sin(e[1] * h), c3 = Math.cos(e[2] * h), s3 = Math.sin(e[2] * h);
  return [s1*c2*c3+c1*s2*s3, c1*s2*c3-s1*c2*s3, c1*c2*s3+s1*s2*c3, c1*c2*c3-s1*s2*s3];
}
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  let dot = a[0]*b[0]+a[1]*b[1]+a[2]*b[2]+a[3]*b[3], [x,y,z,w] = b;
  if (dot < 0) { dot=-dot; x=-x; y=-y; z=-z; w=-w; }
  if (dot > .9995) { const q: Quat=[a[0]+(x-a[0])*t,a[1]+(y-a[1])*t,a[2]+(z-a[2])*t,a[3]+(w-a[3])*t], l=Math.hypot(...q)||1; return q.map((v)=>v/l) as Quat; }
  const angle=Math.acos(dot), sin=Math.sin(angle), aWeight=Math.sin((1-t)*angle)/sin, bWeight=Math.sin(t*angle)/sin;
  return [a[0]*aWeight+x*bWeight,a[1]*aWeight+y*bWeight,a[2]*aWeight+z*bWeight,a[3]*aWeight+w*bWeight];
}
function segment(keys: readonly TransformKey[], t: number): { a: TransformKey; b?: TransformKey; amount: number } {
  if (t <= keys[0]!.time) return { a: keys[0]!, amount: 0 };
  for (let i=0;i<keys.length-1;i+=1) { const a=keys[i]!, b=keys[i+1]!; if (t<=b.time) { const span=b.time-a.time; return { a,b,amount:span>0?evaluateEasing((t-a.time)/span,b.easing??"linear"):1}; } }
  return { a: keys.at(-1)!, amount: 0 };
}
function sampleVec(keys: readonly TransformKey[], t: number): [number,number,number] { const s=segment(keys,t); return s.b ? [lerp(s.a.value[0],s.b.value[0],s.amount),lerp(s.a.value[1],s.b.value[1],s.amount),lerp(s.a.value[2],s.b.value[2],s.amount)] : [...s.a.value]; }
export function evaluateTransform(tracks: readonly TransformTrack[], t: number): Map<string, DesiredTransform> {
  const result=new Map<string,DesiredTransform>();
  for (const track of tracks) { const value=result.get(track.objectId)??{}; if(track.position?.length)value.position=sampleVec(track.position,t); if(track.scale?.length)value.scale=sampleVec(track.scale,t); if(track.rotation?.length){const s=segment(track.rotation,t);value.rotation=s.b?slerpQuat(eulerDegToQuat(s.a.value),eulerDegToQuat(s.b.value),s.amount):eulerDegToQuat(s.a.value);} if(value.position||value.rotation||value.scale)result.set(track.objectId,value); }
  return result;
}
export const transformKeyTimes = (track: TransformTrack): number[] => [...(track.position??[]),...(track.rotation??[]),...(track.scale??[])].map((key)=>key.time);
export function insertTransformKey(keys: TransformKey[]|undefined,time:number,fallback:[number,number,number]):TransformKey[]{const list=keys??[];if(list.some((key)=>Math.abs(key.time-time)<1e-6))return list;const prior=list.filter((key)=>key.time<=time).at(-1)??list[0],source=prior?.value??fallback;const value:[number,number,number]=[source[0],source[1],source[2]];return [...list,{time,value}].sort((a,b)=>a.time-b.time);}
export function upsertTransformKey(keys:TransformKey[]|undefined,time:number,value:[number,number,number]):TransformKey[]{const list=keys??[],existing=list.find((key)=>Math.abs(key.time-time)<1e-6),copy:[number,number,number]=[value[0],value[1],value[2]];return [...list.filter((key)=>Math.abs(key.time-time)>=1e-6),{time,value:copy,...(existing?.easing&&{easing:existing.easing})}].sort((a,b)=>a.time-b.time);}
export function transformSpan(track:TransformTrack):{start:number;end:number}|null{const times=transformKeyTimes(track);return times.length?{start:Math.min(...times),end:Math.max(...times)}:null;}
