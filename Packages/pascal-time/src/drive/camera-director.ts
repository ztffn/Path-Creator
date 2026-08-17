// Driving the viewport camera from a scene's shots, under the one rule the spike measured: the
// camera has exactly one owner per frame. With no controller mounted the time layer writes the
// camera; with one mounted the CONTROLLER writes it and the time layer feeds it a pose. Writing
// past a mounted `camera-controls` is not degraded, it is broken — 1229 of 1230 frames lost, and
// the camera parked on a different shot entirely. Scope: shot resolution and R9-safe application.
import { Vector3, type Camera, type Object3D } from "three";
import {
  applyVirtualCameraSnapshot,
  blendVirtualCameraSnapshots,
  resolveVirtualCameraDefinition
} from "@huma/path-creator/three";
import type { Vec3, VirtualCameraResolveContext, VirtualCameraSnapshot } from "@huma/path-creator/core";
import type { Shot } from "../plugin/scene-ops";

/**
 * The slice of drei's `CameraControls` this needs. Declared structurally so nothing here
 * depends on drei, and so a host with a different controller can satisfy it.
 *
 * `update(0)` after `setLookAt` is not optional: `camera-controls` re-derives the camera pose
 * from its own position/target state on every update, so a pose handed to it without an update
 * is a pose it has not applied yet.
 */
export interface CameraControlsLike {
  setLookAt(
    positionX: number,
    positionY: number,
    positionZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    enableTransition?: boolean
  ): unknown;
  update(deltaSeconds: number): unknown;
}

export interface ShotResolution {
  /** The shot in force. */
  shot: Shot;
  /** The shot being blended from, when a blend is in progress. */
  from: Shot | null;
  /** 0 to 1 through the blend; 1 when the shot is held outright. */
  alpha: number;
  snapshot: VirtualCameraSnapshot;
}

export interface CameraSyncOptions {
  /**
   * The mounted camera controller, when there is one. Its presence changes who writes the
   * camera — that is R9, and it is the whole reason this parameter exists.
   */
  controls?: CameraControlsLike | null;
  /** Extra resolve context (cart frames, target orientation) a host may have. */
  context?: VirtualCameraResolveContext;
}

const forward = new Vector3();
const lookTarget = new Vector3();
const worldPosition = new Vector3();

/**
 * A resolve context that answers "where is target X" from an id-to-object map — Pascal's scene
 * registry, normally. This is what lets an orbit shot name the node it frames: the shot stores
 * a node id, and moving that node re-frames the shot with no timeline edit.
 */
export function pascalTargetContext(registry: {
  nodes: { get(id: string): Object3D | undefined };
}): VirtualCameraResolveContext {
  return {
    getTargetPosition: (targetId: string): Vec3 | null => {
      const object = registry.nodes.get(targetId);
      if (!object) return null;
      object.getWorldPosition(worldPosition);
      return { x: worldPosition.x, y: worldPosition.y, z: worldPosition.z };
    }
  };
}

/** The shot in force at `time`, and the one before it, by time rather than document order. */
export function resolveShotAt(
  shots: readonly Shot[],
  time: number
): { active: Shot | null; previous: Shot | null } {
  const ordered = [...shots].sort((a, b) => a.time - b.time);
  let active: Shot | null = null;
  let previous: Shot | null = null;
  for (const shot of ordered) {
    if (shot.time > time) break;
    previous = active;
    active = shot;
  }
  return { active, previous };
}

/**
 * Drives a camera from a scene's shots.
 *
 * A shot holds until the next one takes over, and takes over across its own `blendSeconds` —
 * so a cut is `blendSeconds: 0` and there is one rule rather than a cut path and a blend path.
 * Resolution is a pure function of `time`, which is what keeps scrubbing and playback identical.
 */
export class PascalCameraDirector {
  /**
   * Returns what it resolved, or null when no shot is in force yet — in which case it writes
   * nothing at all and the host keeps its own camera, rather than snapping it somewhere.
   */
  sync(
    camera: Camera,
    shots: readonly Shot[],
    time: number,
    options: CameraSyncOptions = {}
  ): ShotResolution | null {
    const { active, previous } = resolveShotAt(shots, time);
    if (!active) return null;

    const context: VirtualCameraResolveContext = {
      ...options.context,
      elapsedSeconds: time
    };

    const target = resolveVirtualCameraDefinition(active.definition, context);
    if (!target) return null;

    const blending =
      previous !== null && active.blendSeconds > 0 && time - active.time < active.blendSeconds;
    let snapshot = target;
    let alpha = 1;

    if (blending && previous) {
      const source = resolveVirtualCameraDefinition(previous.definition, context);
      if (source) {
        alpha = (time - active.time) / active.blendSeconds;
        snapshot = blendVirtualCameraSnapshots(source, target, alpha);
      }
    }

    this.apply(camera, snapshot, active, options.controls ?? null);
    return { shot: active, from: blending ? previous : null, alpha, snapshot };
  }

  private apply(
    camera: Camera,
    snapshot: VirtualCameraSnapshot,
    shot: Shot,
    controls: CameraControlsLike | null
  ): void {
    if (!controls) {
      // No controller: the time layer owns the camera outright and writes pose and lens.
      applyVirtualCameraSnapshot(camera, snapshot);
      return;
    }

    // A controller is mounted, so it owns the camera. Hand it the same resolved pose instead of
    // writing past it — measured as indistinguishable from owning the camera, to the digit.
    // The controller has no opinion about the lens, so that is still ours to set.
    const lensCamera = camera as Camera & { fov?: number; updateProjectionMatrix?: () => void };
    const fov = snapshot.lens?.fov;
    if (fov !== undefined && lensCamera.fov !== undefined && lensCamera.fov !== fov) {
      lensCamera.fov = fov;
      lensCamera.updateProjectionMatrix?.();
    }

    // `setLookAt` wants a pivot, not an orientation. Project one along the shot's forward axis
    // at the orbit radius, so the controller's pivot lands on what the shot is framing and a
    // viewer's own orbit turns around the subject rather than around a point behind it.
    const { position, quaternion } = snapshot;
    forward.set(0, 0, -1).applyQuaternion(quaternion as never);
    const distance =
      shot.definition.body.type === "orbit" ? Math.max(0.01, shot.definition.body.radius) : 10;
    lookTarget
      .set(position.x, position.y, position.z)
      .addScaledVector(forward, distance);

    controls.setLookAt(
      position.x,
      position.y,
      position.z,
      lookTarget.x,
      lookTarget.y,
      lookTarget.z,
      false
    );
    controls.update(0);
  }
}
