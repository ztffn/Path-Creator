// Applying a timeline's camera to the viewport, under the one rule the spike measured: the
// camera has exactly one owner per frame. Resolution — which shot is live at t, and how it
// blends into the next — belongs to `@huma/path-creator`, which already does it and does it
// better (blend curves, per-block overrides, an animated lens). This file owns only the half
// the library cannot: obeying R9 against whatever controller the host has mounted.
import { Vector3, type Camera, type Object3D } from "three";
import { applyVirtualCameraSnapshot } from "@huma/path-creator/three";
import type {
  QuaternionLike,
  Timeline,
  Vec3,
  VirtualCameraDefinition,
  VirtualCameraSnapshot
} from "@huma/path-creator/core";
import { evaluateTimeline } from "@huma/path-creator/timeline";

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

export interface CameraDriveInput {
  timeline: Timeline;
  /** Shot definitions by node id — what a camera block's `vcamId` names. */
  vcams: Map<string, VirtualCameraDefinition>;
  time: number;
  /**
   * The mounted camera controller, when there is one. Its presence changes who writes the
   * camera — that is R9, and it is the whole reason this parameter exists.
   */
  controls?: CameraControlsLike | null;
  /** Resolves an orbit shot's target by node id. See `pascalTargetContext`. */
  getTargetPosition?: (targetId: string) => Vec3 | null;
  getTargetOrientation?: (targetId: string) => QuaternionLike | null;
}

export interface CameraFrame {
  snapshot: VirtualCameraSnapshot;
  /** The shot id in force, or null in a gap. */
  vcamId: string | null;
  /** 1 outside a blend window. */
  blendProgress: number;
}

/** Pascal has no dolly rails, so the rig half of the evaluation context is empty by design. */
const EMPTY_RIG = { paths: new Map(), carts: new Map(), cartPaths: new Map() };

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
}): {
  getTargetPosition: (targetId: string) => Vec3 | null;
} {
  return {
    getTargetPosition: (targetId: string): Vec3 | null => {
      const object = registry.nodes.get(targetId);
      if (!object) return null;
      object.getWorldPosition(worldPosition);
      return { x: worldPosition.x, y: worldPosition.y, z: worldPosition.z };
    }
  };
}

/**
 * Drives a camera from a timeline's camera track.
 *
 * Returns what it applied, or null when the timeline resolves no camera at this time — in which
 * case it writes **nothing at all** and the host keeps its own camera, rather than snapping it
 * somewhere. A gap is a deliberate state, not an error.
 */
export class PascalCameraDirector {
  sync(camera: Camera, input: CameraDriveInput): CameraFrame | null {
    const sample = evaluateTimeline(
      input.timeline,
      {
        rig: EMPTY_RIG,
        vcams: input.vcams,
        ...(input.getTargetPosition && { getTargetPosition: input.getTargetPosition }),
        ...(input.getTargetOrientation && { getTargetOrientation: input.getTargetOrientation })
      } as never,
      input.time
    );

    if (!sample.camera) return null;

    const vcamId = sample.activeBlock?.block.vcamId ?? null;
    this.apply(camera, sample.camera, vcamId ? input.vcams.get(vcamId) : undefined, input.controls ?? null);
    return { snapshot: sample.camera, vcamId, blendProgress: sample.blendProgress };
  }

  private apply(
    camera: Camera,
    snapshot: VirtualCameraSnapshot,
    definition: VirtualCameraDefinition | undefined,
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
      definition?.body.type === "orbit" ? Math.max(0.01, definition.body.radius) : 10;
    lookTarget.set(position.x, position.y, position.z).addScaledVector(forward, distance);

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
