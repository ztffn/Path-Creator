// The per-frame drive: one call that applies a timeline's transform and activation tracks to
// the Pascal nodes they name. Everything it writes goes to the live `Object3D` and nothing to
// Pascal's node data — that is the property that keeps 60 frames a second of playback out of
// the undo history, and it is asserted, not assumed (see test/driving.spec.ts).
// Scope: transform + activation over a Pascal scene. Camera work is M1.4; audio is not ours here.
import {
  ActivationTrackDirector,
  TransformTrackDirector,
  type ObjectBindingResolver,
  type TrackLayer
} from "@huma/path-creator/three";
import type { ActivationTrack, Timeline, TransformTrack } from "@huma/path-creator/core";

/** Where the clock is, and whether the timeline currently owns the scene. */
export interface PascalDriveClock {
  /** Timeline seconds. Evaluation is a pure function of this. */
  time: number;
  /**
   * Whether the timeline is running, as opposed to parked or being scrubbed. Activation
   * needs the distinction: a track's post-playback state applies when playback *stops at the
   * end*, and a scrub that lands on the same time must not be mistaken for that.
   */
  playing: boolean;
  /**
   * Whether the timeline owns the scene at all. Going false is not "pause" — it is "give the
   * objects back", and every object this driver touched is restored to its pre-drive pose.
   */
  driving: boolean;
}

const isTransform = (track: Timeline["tracks"][number]): track is TransformTrack =>
  track.type === "transform";
const isActivation = (track: Timeline["tracks"][number]): track is ActivationTrack =>
  track.type === "activation";

/**
 * Drives Pascal nodes from a timeline.
 *
 * Restoration is the part worth reading twice. `driving: false` hands every touched object
 * back in the pose it had before the drive started; without that, scrubbing a timeline would
 * silently rewrite where things sit and the author's scene would drift under them. The
 * directors own that state, which is why this class holds them across frames rather than
 * constructing them per call.
 *
 * One driver instance per timeline that can be live at once. Two drivers over the same objects
 * would each believe they hold the pre-drive pose, and whichever released last would win.
 */
export class PascalNodeDriver {
  private readonly activationDirector = new ActivationTrackDirector();
  private readonly transformDirector = new TransformTrackDirector();
  /** Partition cache, keyed on timeline identity so a steady timeline costs no per-frame work. */
  private partitionOf: Timeline | null = null;
  private transformTracks: readonly TransformTrack[] = [];
  private activationTracks: readonly ActivationTrack[] = [];
  /** The last timeline and time synced, so `release` can restore without the caller
   *  re-supplying them — and without inventing a clock position that was never true. */
  private lastTimeline: Timeline | null = null;
  private lastTime = 0;

  constructor(private readonly binding: ObjectBindingResolver) {}

  sync(timeline: Timeline, clock: PascalDriveClock): void {
    this.partition(timeline);
    this.lastTimeline = timeline;
    this.lastTime = clock.time;

    const transformLayers: TrackLayer<TransformTrack>[] = [
      { tracks: this.transformTracks, time: clock.time }
    ];
    const activationLayers: TrackLayer<ActivationTrack>[] = [
      { tracks: this.activationTracks, time: clock.time }
    ];

    this.activationDirector.sync(
      this.binding,
      activationLayers,
      clock.driving,
      timeline.duration,
      clock.time,
      clock.playing
    );
    this.transformDirector.sync(this.binding, transformLayers, clock.driving);
  }

  /**
   * Stop driving and give every touched object back. Safe to call when nothing was ever
   * driven, and safe to call twice — the directors no-op once they have released.
   */
  release(): void {
    if (!this.lastTimeline) return;
    this.sync(this.lastTimeline, {
      time: this.lastTime,
      playing: false,
      driving: false
    });
  }

  private partition(timeline: Timeline): void {
    if (this.partitionOf === timeline) return;
    this.partitionOf = timeline;
    this.transformTracks = timeline.tracks.filter(isTransform);
    this.activationTracks = timeline.tracks.filter(isActivation);
  }
}
