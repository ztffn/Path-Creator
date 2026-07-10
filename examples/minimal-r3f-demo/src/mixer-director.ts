// Stateful applier for the demo's Animation tracks — the GLB analogue of
// AudioTrackPlayer/ActivationDirector. Each frame it reads the pure desired state
// (evaluateAnimation) and drives each bound model's mixer BY TIME via
// mixer.setTime(localTime) on a single playing action. setTime evaluates the clip
// from a clean base, so scrubbing/playing/replay at the same t all land the same
// pose (scrub-safe). NB: skinned meshes only apply via a playing action + setTime —
// paused actions + mixer.update(0) silently no-op, so sibling clips are stop()ed.
// Actions stay LoopRepeat always (never LoopOnce, which pauses on finish and then
// can't re-apply under scrub); "once" is instead a clamp on localTime below.
import { LoopRepeat, type AnimationMixer } from "three";
import { evaluateAnimation, type AnimationTrack } from "./extra-tracks";
import type { ActivatablesRegistry } from "./activatables";

/** Nudge below the clip end so a clamped "once" holds the last frame instead of wrapping to 0. */
const CLAMP_EPSILON = 1e-4;

export class MixerDirector {
  /** The clip currently playing on each mixer, so we only reset/play on a clip switch. */
  private current = new Map<AnimationMixer, string>();
  private wasDriving = false;

  /**
   * Reconcile every bound model to the timeline at `time`. On leave, stop the actions
   * and restore each model's bind pose — matching the TransformDirector, so parking
   * the timeline returns objects to their editor state rather than freezing mid-clip.
   */
  sync(registry: ActivatablesRegistry, tracks: readonly AnimationTrack[], driving: boolean, time: number): void {
    if (!driving) {
      if (this.wasDriving) {
        for (const track of tracks) {
          const facet = registry.resolveAnimation(track.objectId);
          if (!facet) continue;
          for (const action of facet.actions.values()) action.stop();
          facet.resetToRest();
        }
        this.current.clear();
        this.wasDriving = false;
      }
      return;
    }
    this.wasDriving = true;
    const desired = evaluateAnimation(tracks, time);
    // A bound model with no active clip at t (scrubbed back before its first clip) is
    // absent from `desired`; reset it to rest so it doesn't freeze at its last pose.
    for (const track of tracks) {
      if (desired.has(track.objectId)) continue;
      const facet = registry.resolveAnimation(track.objectId);
      if (!facet || !this.current.has(facet.mixer)) continue;
      for (const action of facet.actions.values()) action.stop();
      facet.resetToRest();
      this.current.delete(facet.mixer);
    }
    for (const [objectId, want] of desired) {
      const facet = registry.resolveAnimation(objectId);
      if (!facet) continue;
      const action = facet.actions.get(want.clipName);
      if (!action) continue;
      // On a clip switch, stop the siblings and (re)start this one from a clean base.
      // A stopped sibling is deactivated, so setTime below won't blend it back in.
      if (this.current.get(facet.mixer) !== want.clipName) {
        for (const [name, other] of facet.actions) if (name !== want.clipName) other.stop();
        action.reset();
        action.setLoop(LoopRepeat, Infinity);
        action.play();
        this.current.set(facet.mixer, want.clipName);
      }
      action.setEffectiveWeight(want.weight);
      // "once": clamp local time just shy of the clip end so LoopRepeat never wraps —
      // the pose holds the final frame past the clip, still a pure function of t.
      const duration = action.getClip().duration;
      const localTime = want.loop ? want.localTime : Math.min(want.localTime, Math.max(0, duration - CLAMP_EPSILON));
      facet.mixer.setTime(localTime); // evaluates + applies the pose at localTime
    }
  }
}
