// Timeline schema: the versioned, persistable description of a show —
// camera blocks (which vcam is live, with blend-in windows and per-block
// definition overrides such as retargets), cart distance keyframes, and
// opaque host events. Pure data with no engine dependency; the evaluator
// and player live in the timeline entry point.
import { evaluateEasing, normalizeEasing, sampleEasingCurve, solveCubicBezierSegment } from "./easing";
import type { Easing, EasingCurve } from "./easing";
import { clamp } from "./vec3";
import type { VirtualCameraBlendCurve, VirtualCameraDefinition, VirtualCameraLens } from "./virtual-camera";

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

// v2: CartKey.easing / TimelineBlendIn.curve accept a custom cubic-bezier object
// (in addition to the named presets); legacy string easing stays valid.
// v4: portable activation/audio/animation/transform tracks.
// v5: per-axis easing (TransformKey.easingAxes) for independent position/scale tangents.
// v6: position/scale interpolate as a real cubic bezier in (time, value) space via
//     per-axis tangent handles (TransformKey.tangentsAxes); easingAxes retired for them.
// v7: scene tracks — clips that embed another Story scene into a master-time window
//     (deterministic master-embed; evaluation maps master t to scene-local t).
// v8: SceneClip.blendSeconds — eased camera blend at the embed window's edges.
export const TIMELINE_SCHEMA_VERSION = 8;

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
/**
 * One side of a per-axis cubic-bezier tangent handle, as an offset (Δtime, Δvalue)
 * from the key point. `out` shapes the segment to the next key, `in` the segment from
 * the previous key. Absent => the straight 1/3-chord tangent (a linear segment).
 */
export interface AxisTangent { in?: [number, number]; out?: [number, number]; }

export interface TransformKey {
  time: number;
  value: [number, number, number];
  /** Easing into this key. Used for rotation's slerp timing; position/scale use `tangentsAxes`. */
  easing?: Easing;
  /**
   * Per-axis cubic-bezier tangent handles (x, y, z) in real (time, value) space, giving
   * position/scale a true 2D bezier between keys — curves can bulge and stay C1-smooth
   * through keys, independent of the endpoint value delta. Absent handles fall back to a
   * straight tangent. Rotation ignores this (it slerps with the shared `easing`). Added in v6.
   */
  tangentsAxes?: [AxisTangent, AxisTangent, AxisTangent];
}
export interface TransformTrack {
  type: "transform"; id: string; name?: string; objectId: string;
  position?: TransformKey[]; rotation?: TransformKey[]; scale?: TransformKey[];
}

/**
 * Embeds another Story scene into a fixed master-time window: while
 * `start <= t < end`, the referenced scene evaluates at local time
 * `t - start + offset`. Purely deterministic (scrub-safe) — the live-branch
 * counterpart is the playScene runtime. Nesting is depth-1: an embedded
 * scene's own scene tracks are inert.
 */
export interface SceneClip {
  id: string;
  sceneId: string;
  start: number;
  end: number;
  /** Scene-local time at the window's start (default 0). */
  offset?: number;
  /** Eased camera blend into/out of the window over this many seconds at each
   *  edge (default 0 = hard cut). */
  blendSeconds?: number;
}
export interface SceneTrack {
  type: "scene"; id: string; name?: string; clips: SceneClip[];
}

export type TimelineTrack = CameraTrack | CartTrack | EventTrack | ActivationTrack | AudioTrack | AnimationTrack | TransformTrack | SceneTrack;

/** One embedded scene active at a master time: evaluate `timeline` at `time`.
 *  `clip` carries the window (start/end/blendSeconds) for boundary blending. */
export interface SceneLayer { sceneId: string; timeline: Timeline; time: number; clip: SceneClip; }

/**
 * The embedded-scene layers active at master time t, in override order (later
 * tracks/clips win). Pure; `getScene` resolves a Story scene by id (unknown ids
 * are skipped). Depth-1 by contract — callers evaluate the returned layers'
 * NON-scene tracks only (their own scene tracks are ignored).
 */
export function evaluateSceneLayers(
  tracks: readonly TimelineTrack[],
  getScene: (sceneId: string) => Timeline | null,
  t: number
): SceneLayer[] {
  const layers: SceneLayer[] = [];
  for (const track of tracks) {
    if (track.type !== "scene") continue;
    for (const clip of track.clips) {
      if (!covers(clip.start, clip.end, t)) continue;
      const timeline = getScene(clip.sceneId);
      if (timeline) layers.push({ sceneId: clip.sceneId, timeline, time: t - clip.start + (clip.offset ?? 0), clip });
    }
  }
  return layers;
}

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
      const normalizeKeys = (keys?: TransformKey[]) => keys?.map((key) => ({
        ...key,
        ...(key.easing !== undefined && { easing: normalizeEasing(key.easing) })
      }));
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
    if (track.type === "animation") return { ...track, clips: [...track.clips].sort((a, b) => a.start - b.start) };
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
// Returns the bracketing keys and the RAW (un-eased) segment fraction; callers apply
// easing (rotation's shared slerp) or the per-axis bezier (position/scale).
function segment(keys: readonly TransformKey[], t: number): { a: TransformKey; b?: TransformKey; localT: number } {
  if (t <= keys[0]!.time) return { a: keys[0]!, localT: 0 };
  for (let i=0;i<keys.length-1;i+=1) { const a=keys[i]!, b=keys[i+1]!; if (t<=b.time) { const span=b.time-a.time; return { a,b,localT:span>0?(t-a.time)/span:1}; } }
  return { a: keys.at(-1)!, localT: 0 };
}

/** A key shape the per-component bezier sampler accepts (TransformKey and the editor's key both satisfy it). */
export interface TransformKeyLike { time: number; value: readonly number[]; tangentsAxes?: readonly (AxisTangent | undefined)[]; }

// One component's value along the cubic bezier between keys `a` and `b`, in real
// (time, value) space: control points are the keys' tangent handles (default 1/3-chord
// = straight). Handle time is clamped inside the segment so x stays monotonic for the solver.
function bezierComponent(a: TransformKeyLike, b: TransformKeyLike, comp: number, t: number): number {
  const dt = b.time - a.time;
  const av = a.value[comp] ?? 0;
  const bv = b.value[comp] ?? 0;
  if (dt <= 0) return bv;
  const out = a.tangentsAxes?.[comp]?.out;
  const inn = b.tangentsAxes?.[comp]?.in;
  // No authored handles => straight 1/3-chord bezier == a linear lerp; take the cheap
  // path (no allocations, no solver) for the common untouched-key case on the hot path.
  if (!out && !inn) return av + (bv - av) * ((t - a.time) / dt);
  const c1 = { x: clamp(a.time + (out ? out[0] : dt / 3), a.time, b.time), y: av + (out ? out[1] : (bv - av) / 3) };
  const c2 = { x: clamp(b.time + (inn ? inn[0] : -dt / 3), a.time, b.time), y: bv + (inn ? inn[1] : -(bv - av) / 3) };
  return solveCubicBezierSegment({ x: a.time, y: av }, c1, c2, { x: b.time, y: bv }, t);
}

/**
 * Value of `keys` component `comp` at time `t`: held before first / after last, cubic
 * bezier between (the same math the transform evaluator plays). Exported so the curve
 * editor and evaluator share ONE sampler and can never diverge.
 */
export function transformComponentAt(keys: readonly TransformKeyLike[], comp: number, t: number): number {
  if (keys.length === 0) return 0;
  if (t <= keys[0]!.time) return keys[0]!.value[comp] ?? 0;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const a = keys[i]!;
    const b = keys[i + 1]!;
    if (t <= b.time) return bezierComponent(a, b, comp, t);
  }
  return keys[keys.length - 1]!.value[comp] ?? 0;
}

// Position/scale interpolate each component as an independent 2D cubic bezier, so a
// curve can bulge between equal-value keys and stay smooth — unlike an eased lerp.
function sampleVec(keys: readonly TransformKey[], t: number): [number,number,number] {
  const s = segment(keys, t);
  if (!s.b) return [...s.a.value];
  const a = s.a, b = s.b;
  return [bezierComponent(a, b, 0, t), bezierComponent(a, b, 1, t), bezierComponent(a, b, 2, t)];
}
export function evaluateTransform(tracks: readonly TransformTrack[], t: number): Map<string, DesiredTransform> {
  const result=new Map<string,DesiredTransform>();
  for (const track of tracks) { const value=result.get(track.objectId)??{}; if(track.position?.length)value.position=sampleVec(track.position,t); if(track.scale?.length)value.scale=sampleVec(track.scale,t); if(track.rotation?.length){const s=segment(track.rotation,t);value.rotation=s.b?slerpQuat(eulerDegToQuat(s.a.value),eulerDegToQuat(s.b.value),evaluateEasing(s.localT,s.b.easing??"linear")):eulerDegToQuat(s.a.value);} if(value.position||value.rotation||value.scale)result.set(track.objectId,value); }
  return result;
}
export const transformKeyTimes = (track: TransformTrack): number[] => [...(track.position??[]),...(track.rotation??[]),...(track.scale??[])].map((key)=>key.time);
export function insertTransformKey(keys: TransformKey[]|undefined,time:number,fallback:[number,number,number]):TransformKey[]{const list=keys??[];if(list.some((key)=>Math.abs(key.time-time)<1e-6))return list;const prior=list.filter((key)=>key.time<=time).at(-1)??list[0],source=prior?.value??fallback;const value:[number,number,number]=[source[0],source[1],source[2]];return [...list,{time,value}].sort((a,b)=>a.time-b.time);}
export function upsertTransformKey(keys:TransformKey[]|undefined,time:number,value:[number,number,number]):TransformKey[]{const list=keys??[],existing=list.find((key)=>Math.abs(key.time-time)<1e-6),copy:[number,number,number]=[value[0],value[1],value[2]];return [...list.filter((key)=>Math.abs(key.time-time)>=1e-6),{time,value:copy,...(existing?.easing&&{easing:existing.easing})}].sort((a,b)=>a.time-b.time);}
export function transformSpan(track:TransformTrack):{start:number;end:number}|null{const times=transformKeyTimes(track);return times.length?{start:Math.min(...times),end:Math.max(...times)}:null;}
