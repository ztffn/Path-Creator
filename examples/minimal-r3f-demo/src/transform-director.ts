// Stateful applier for the demo's Transform tracks — writes a bound object's local
// position/rotation/scale from the pure keyframe evaluation (evaluateTransform) each
// frame. Scrub-safe by construction (the pose is a pure function of t; nothing
// accumulates). Lazily captures each bound object's base transform and restores it on
// leave, so parking the timeline returns objects to their editor pose. Demo scaffolding.
import { evaluateTransform, type TransformTrack } from "./extra-tracks";
import type { ActivatablesRegistry } from "./activatables";

interface BaseTransform {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
}

export class TransformDirector {
  private base = new Map<string, BaseTransform>();
  private wasDriving = false;

  sync(registry: ActivatablesRegistry, tracks: readonly TransformTrack[], driving: boolean, time: number): void {
    if (driving) {
      this.wasDriving = true;
      // Capture the base transform of any object not yet seen — handles tracks bound
      // after driving already started, so it still restores cleanly on leave.
      for (const track of tracks) {
        if (this.base.has(track.objectId)) continue;
        const object = registry.resolve(track.objectId);
        if (!object) continue;
        this.base.set(track.objectId, {
          position: [object.position.x, object.position.y, object.position.z],
          quaternion: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
          scale: [object.scale.x, object.scale.y, object.scale.z]
        });
      }
      for (const [id, want] of evaluateTransform(tracks, time)) {
        const object = registry.resolve(id);
        if (!object) continue;
        if (want.position) object.position.set(want.position[0], want.position[1], want.position[2]);
        if (want.rotation) object.quaternion.set(want.rotation[0], want.rotation[1], want.rotation[2], want.rotation[3]);
        if (want.scale) object.scale.set(want.scale[0], want.scale[1], want.scale[2]);
      }
    } else if (this.wasDriving) {
      this.restore(registry);
      this.wasDriving = false;
    }
  }

  private restore(registry: ActivatablesRegistry): void {
    for (const [id, base] of this.base) {
      const object = registry.resolve(id);
      if (!object) continue;
      object.position.set(base.position[0], base.position[1], base.position[2]);
      object.quaternion.set(base.quaternion[0], base.quaternion[1], base.quaternion[2], base.quaternion[3]);
      object.scale.set(base.scale[0], base.scale[1], base.scale[2]);
    }
    this.base.clear();
  }
}
