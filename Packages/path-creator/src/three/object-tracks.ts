import { LoopRepeat, type AnimationAction, type AnimationMixer, type Object3D } from "three";
import {
  evaluateActivation,
  evaluateAnimation,
  evaluateTransform,
  type ActivationTrack,
  type AnimationTrack,
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

export class ActivationTrackDirector {
  private original = new Map<string, boolean>();
  private wasDriving = false;
  private held = false;
  private lastPlaying = false;
  private lastTime = 0;

  sync(registry: ObjectBindingResolver, tracks: readonly ActivationTrack[], driving: boolean, duration: number, time: number, playing: boolean): void {
    if (driving) {
      if (!this.wasDriving) {
        this.original.clear();
        for (const track of tracks) {
          const object = registry.resolve(track.objectId);
          if (object && !this.original.has(track.objectId)) this.original.set(track.objectId, object.visible);
        }
        this.held = false;
        this.wasDriving = true;
      }
      const atEnd = duration > 0 && time >= duration - 1e-3;
      if (playing || time !== this.lastTime) this.held = false;
      if (this.lastPlaying && !playing && atEnd) this.held = true;
      if (this.held) this.applyPostPlayback(registry, tracks);
      else for (const [id, visible] of evaluateActivation(tracks, time)) {
        const object = registry.resolve(id); if (object) object.visible = visible;
      }
    } else if (this.wasDriving) {
      this.applyPostPlayback(registry, tracks);
      this.wasDriving = false;
      this.held = false;
    }
    this.lastPlaying = playing;
    this.lastTime = time;
  }

  private applyPostPlayback(registry: ObjectBindingResolver, tracks: readonly ActivationTrack[]): void {
    for (const track of tracks) {
      const object = registry.resolve(track.objectId); if (!object) continue;
      if (track.postPlaybackState === "active") object.visible = true;
      else if (track.postPlaybackState === "inactive") object.visible = false;
      else if (track.postPlaybackState === "revert") object.visible = this.original.get(track.objectId) ?? true;
    }
  }
}

interface BaseTransform { position: [number,number,number]; quaternion: [number,number,number,number]; scale: [number,number,number]; }
export class TransformTrackDirector {
  private base = new Map<string, BaseTransform>();
  private wasDriving = false;
  sync(registry: ObjectBindingResolver, tracks: readonly TransformTrack[], driving: boolean, time: number): void {
    if (driving) {
      this.wasDriving = true;
      for (const track of tracks) {
        if (this.base.has(track.objectId)) continue;
        const object=registry.resolve(track.objectId); if(!object)continue;
        this.base.set(track.objectId,{position:[object.position.x,object.position.y,object.position.z],quaternion:[object.quaternion.x,object.quaternion.y,object.quaternion.z,object.quaternion.w],scale:[object.scale.x,object.scale.y,object.scale.z]});
      }
      for(const[id,value]of evaluateTransform(tracks,time)){const object=registry.resolve(id);if(!object)continue;if(value.position)object.position.fromArray(value.position);if(value.rotation)object.quaternion.fromArray(value.rotation);if(value.scale)object.scale.fromArray(value.scale);}
    } else if(this.wasDriving){for(const[id,base]of this.base){const object=registry.resolve(id);if(object){object.position.fromArray(base.position);object.quaternion.fromArray(base.quaternion);object.scale.fromArray(base.scale);}}this.base.clear();this.wasDriving=false;}
  }
}

const CLAMP_EPSILON=1e-4;
export class AnimationTrackDirector {
  private active = new Map<AnimationMixer, ObjectAnimationBinding>();
  private wasDriving = false;

  sync(registry: ObjectBindingResolver, tracks: readonly AnimationTrack[], driving: boolean, time: number): void {
    if (!driving) {
      if (this.wasDriving) this.stopBindings(this.active.values());
      this.active.clear();
      this.wasDriving = false;
      return;
    }

    this.wasDriving = true;
    const desired = evaluateAnimation(tracks, time);
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
          ? (duration > 0 ? want.localTime % duration : 0)
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
