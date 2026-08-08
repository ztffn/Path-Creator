import { LoopRepeat, Quaternion, type AnimationAction, type AnimationMixer, type Object3D } from "three";
import {
  evaluateActivation,
  evaluateAnimation,
  evaluateTransform,
  type ActivationTrack,
  type AnimationTrack,
  type DesiredAnimation,
  type DesiredTransform,
  type TransformTrack
} from "../core";

export interface ObjectAnimationBinding {
  mixer: AnimationMixer;
  actions: Map<string, AnimationAction>;
  clips: string[];
  resetToRest: () => void;
}

export interface ObjectBindingResolver {
  resolve(id: string): Object3D | null;
  resolveAnimation(id: string): ObjectAnimationBinding | null;
}

export class ObjectBindingRegistry implements ObjectBindingResolver {
  private entries = new Map<string, { object: Object3D; animation?: ObjectAnimationBinding }>();
  register(id: string, object: Object3D, animation?: ObjectAnimationBinding): () => void {
    this.entries.set(id, { object, ...(animation && { animation }) });
    return () => { if (this.entries.get(id)?.object === object) this.entries.delete(id); };
  }
  resolve(id: string): Object3D | null { return this.entries.get(id)?.object ?? null; }
  resolveAnimation(id: string): ObjectAnimationBinding | null { return this.entries.get(id)?.animation ?? null; }
}

/** One evaluation layer for a director: these tracks, at this (local) time.
 *  Hosts pass the master's tracks plus any embedded scenes' as later layers —
 *  later layers override earlier ones per object. */
export interface TrackLayer<T> { tracks: readonly T[]; time: number; }

export class ActivationTrackDirector {
  private original = new Map<string, boolean>();
  private wasDriving = false;
  private held = false;
  private lastPlaying = false;
  private lastTime = 0;

  sync(registry: ObjectBindingResolver, layers: readonly TrackLayer<ActivationTrack>[], driving: boolean, duration: number, time: number, playing: boolean): void {
    if (driving) {
      if (!this.wasDriving) {
        this.original.clear();
        this.held = false;
        this.wasDriving = true;
      }
      // Capture originals lazily every frame: an embed layer can introduce a
      // track mid-drive (its window opens), and its object still needs a
      // revert baseline from before the FIRST time this drive touched it.
      for (const layer of layers) for (const track of layer.tracks) {
        const object = registry.resolve(track.objectId);
        if (object && !this.original.has(track.objectId)) this.original.set(track.objectId, object.visible);
      }
      const atEnd = duration > 0 && time >= duration - 1e-3;
      if (playing || time !== this.lastTime) this.held = false;
      if (this.lastPlaying && !playing && atEnd) this.held = true;
      if (this.held) this.applyPostPlayback(registry, layers);
      else {
        const merged = new Map<string, boolean>();
        for (const layer of layers) for (const [id, visible] of evaluateActivation(layer.tracks, layer.time)) merged.set(id, visible);
        for (const [id, visible] of merged) {
          const object = registry.resolve(id); if (object) object.visible = visible;
        }
      }
    } else if (this.wasDriving) {
      this.applyPostPlayback(registry, layers);
      this.wasDriving = false;
      this.held = false;
    }
    this.lastPlaying = playing;
    this.lastTime = time;
  }

  private applyPostPlayback(registry: ObjectBindingResolver, layers: readonly TrackLayer<ActivationTrack>[]): void {
    for (const layer of layers) for (const track of layer.tracks) {
      const object = registry.resolve(track.objectId); if (!object) continue;
      if (track.postPlaybackState === "active") object.visible = true;
      else if (track.postPlaybackState === "inactive") object.visible = false;
      else if (track.postPlaybackState === "revert") object.visible = this.original.get(track.objectId) ?? true;
    }
  }
}

interface BaseTransform { position: [number,number,number]; quaternion: [number,number,number,number]; scale: [number,number,number]; }
const snapshot = (object: Object3D): BaseTransform => ({
  position: [object.position.x, object.position.y, object.position.z],
  quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
  scale: [object.scale.x, object.scale.y, object.scale.z]
});
/** Scratch for the additive rotation delta — this runs per object per frame. */
const deltaQuaternion = new Quaternion();
const restore = (object: Object3D, pose: BaseTransform): void => {
  object.position.fromArray(pose.position);
  object.quaternion.fromArray(pose.quaternion);
  object.scale.fromArray(pose.scale);
};

/**
 * Applies transform tracks to bound objects. Absolute tracks (the default) write the
 * pose outright and restore the object's pre-drive pose when the timeline is left.
 * Additive tracks (`TransformTrack.additive`) instead offset whatever pose is already
 * there — so pointed at a bone an AnimationMixer just wrote, they correct the animation
 * rather than erasing it. Hosts must sync the AnimationTrackDirector FIRST for that to
 * mean anything; the mixer has to have written before the offset is layered on.
 */
export class TransformTrackDirector {
  private base = new Map<string, BaseTransform>();
  private additiveBase = new Map<string, BaseTransform>();
  private wasDriving = false;

  sync(registry: ObjectBindingResolver, layers: readonly TrackLayer<TransformTrack>[], driving: boolean): void {
    if (!driving) {
      if (this.wasDriving) this.release(registry);
      return;
    }
    this.wasDriving = true;

    const absolute = new Map<string, DesiredTransform>();
    const additive = new Map<string, DesiredTransform>();
    for (const layer of layers) {
      // Most rigs have no additive track at all; skip the partition when so.
      const hasAdditive = layer.tracks.some((track) => track.additive);
      const absoluteTracks = hasAdditive ? layer.tracks.filter((track) => !track.additive) : layer.tracks;
      for (const track of absoluteTracks) {
        if (this.base.has(track.objectId)) continue;
        const object = registry.resolve(track.objectId);
        if (object) this.base.set(track.objectId, snapshot(object));
      }
      for (const [id, value] of evaluateTransform(absoluteTracks, layer.time)) absolute.set(id, value);
      if (hasAdditive) {
        const additiveTracks = layer.tracks.filter((track) => track.additive);
        for (const [id, value] of evaluateTransform(additiveTracks, layer.time)) additive.set(id, value);
      }
    }

    for (const [id, value] of absolute) {
      const object = registry.resolve(id);
      if (!object) continue;
      if (value.position) object.position.fromArray(value.position);
      if (value.rotation) object.quaternion.fromArray(value.rotation);
      if (value.scale) object.scale.fromArray(value.scale);
    }

    for (const [id, value] of additive) {
      const object = registry.resolve(id);
      if (!object) continue;
      // Snapshot every frame, not once: the pose being offset is the mixer's output and
      // changes under us, so a first-drive snapshot would restore an arbitrary frame.
      this.additiveBase.set(id, snapshot(object));
      if (value.position) object.position.set(object.position.x + value.position[0], object.position.y + value.position[1], object.position.z + value.position[2]);
      // Post-multiply: the offset is expressed in the object's own space, so a bone
      // correction reads as "bend this joint a further N degrees", not as a world twist.
      if (value.rotation) object.quaternion.multiply(deltaQuaternion.fromArray(value.rotation));
      if (value.scale) object.scale.set(object.scale.x * value.scale[0], object.scale.y * value.scale[1], object.scale.z * value.scale[2]);
    }
  }

  private release(registry: ObjectBindingResolver): void {
    for (const [id, pose] of this.base) {
      const object = registry.resolve(id);
      if (object) restore(object, pose);
    }
    for (const [id, pose] of this.additiveBase) {
      // An animated object's mixer has already reset it to rest by the time this runs;
      // writing a remembered pose over that would freeze it at an arbitrary frame. For
      // an object nothing else drives, the remembered pose IS the correct resting state.
      if (registry.resolveAnimation(id)) continue;
      const object = registry.resolve(id);
      if (object) restore(object, pose);
    }
    this.base.clear();
    this.additiveBase.clear();
    this.wasDriving = false;
  }
}

const CLAMP_EPSILON=1e-4;
export class AnimationTrackDirector {
  private active = new Map<AnimationMixer, ObjectAnimationBinding>();
  private wasDriving = false;

  sync(registry: ObjectBindingResolver, layers: readonly TrackLayer<AnimationTrack>[], driving: boolean): void {
    if (!driving) {
      if (this.wasDriving) this.stopBindings(this.active.values());
      this.active.clear();
      this.wasDriving = false;
      return;
    }

    this.wasDriving = true;
    const desired = new Map<string, DesiredAnimation[]>();
    for (const layer of layers) for (const [id, wants] of evaluateAnimation(layer.tracks, layer.time)) desired.set(id, wants);
    const desiredBindings = new Map<AnimationMixer, ObjectAnimationBinding>();
    for (const objectId of desired.keys()) {
      const binding = registry.resolveAnimation(objectId);
      if (binding) desiredBindings.set(binding.mixer, binding);
    }

    // Bindings remain reachable here even if their source track was deleted.
    for (const [mixer, binding] of this.active) {
      if (desiredBindings.has(mixer)) continue;
      this.stopBindings([binding]);
      this.active.delete(mixer);
    }

    for (const [objectId, wants] of desired) {
      const binding = registry.resolveAnimation(objectId);
      if (!binding) continue;
      const names = new Set(wants.map((want) => want.clipName));
      for (const [name, action] of binding.actions) {
        if (!names.has(name)) action.stop();
      }
      for (const want of wants) {
        const action = binding.actions.get(want.clipName);
        if (!action) continue;
        if (!action.isRunning()) {
          action.reset();
          action.setLoop(LoopRepeat, Infinity);
          action.play();
        }
        action.setEffectiveWeight(want.weight);
        const duration = action.getClip().duration;
        // This drive scrubs with mixer.update(0); three.js skips loop wrapping on a
        // zero delta (AnimationAction._updateTime early-returns), so a looping clip
        // whose local time runs past its duration would clamp to the final keyframe
        // and freeze after one cycle. Wrap into [0, duration) here instead.
        action.time = want.loop
          ? (duration > 0 ? ((want.localTime % duration) + duration) % duration : 0)
          : Math.min(want.localTime, Math.max(0, duration - CLAMP_EPSILON));
      }
      binding.mixer.update(0);
      this.active.set(binding.mixer, binding);
    }
  }

  private stopBindings(bindings: Iterable<ObjectAnimationBinding>): void {
    for (const binding of bindings) {
      for (const action of binding.actions.values()) action.stop();
      binding.resetToRest();
    }
  }
}
