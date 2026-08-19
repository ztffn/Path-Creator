// Applying a timeline's camera to the viewport, under the one rule the spike measured: the
// camera has exactly one owner per frame. Resolution — which shot is live at t, and how it
// blends into the next — belongs to `@huma/path-creator`, which already does it and does it
// better (blend curves, per-block overrides, an animated lens). This file owns two halves the
// library cannot: obeying R9 against the host's controller, and running the damped composer.
import { PerspectiveCamera, Vector3, type Camera, type Object3D } from "three";
import {
  applyVirtualCameraSnapshot,
  createRigComposerState,
  stepComposerAim,
  type RigComposerState
} from "@huma/path-creator/three";
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
  /**
   * Frame time, and whether the clock is running. Both exist for the composer alone — it is the
   * one stage in this system that damps from the previous frame, so it is the one stage that
   * needs to know how much time passed and whether time is passing at all. Defaults (0, false)
   * make every other caller behave exactly as before.
   */
  deltaSeconds?: number;
  playing?: boolean;
}

export interface CameraFrame {
  snapshot: VirtualCameraSnapshot;
  /** The shot id in force, or null in a gap. */
  vcamId: string | null;
  /** 1 outside a blend window. */
  blendProgress: number;
  /** The world point the composer framed this frame, or null when no composer ran. */
  composedTarget: Vec3 | null;
}

/** Pascal has no dolly rails, so the rig half of the evaluation context is empty by design. */
const EMPTY_RIG = { paths: new Map(), carts: new Map(), cartPaths: new Map() };

const forward = new Vector3();
const lookTarget = new Vector3();
const worldPosition = new Vector3();
const aimPoint = new Vector3();

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
  /** The composer's carried state (composed orientation + reframe state + the shot it frames). */
  private readonly composer: RigComposerState = createRigComposerState();
  /**
   * A camera the composer can be run against without touching the viewport's. The composer
   * stage is written against a `Camera` (it reads position/quaternion/fov/aspect and writes the
   * quaternion), and the viewport camera is the controller's during playback — so it gets its
   * own, seeded from the resolved snapshot each frame.
   */
  private readonly composerCamera = new PerspectiveCamera();

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

    if (!sample.camera) {
      // No shot in force: forget the composed orientation, so the next shot that takes over
      // reseeds from its own body pose instead of damping out of a stale frame.
      this.composer.vcamId = null;
      return null;
    }

    const vcamId = sample.activeBlock?.block.vcamId ?? null;
    const definition = vcamId ? input.vcams.get(vcamId) : undefined;
    const composedTarget = definition
      ? this.stepComposer(camera, sample.camera, definition, input)
      : null;

    this.apply(camera, sample.camera, definition, input.controls ?? null, composedTarget);
    return { snapshot: sample.camera, vcamId, blendProgress: sample.blendProgress, composedTarget };
  }

  /**
   * The damped composer, run in place on `snapshot.quaternion`.
   *
   * The library owns the stage itself (`stepComposerAim`); what belongs here is the two decisions
   * a host has to make about it.
   *
   * **Scrub determinism.** This is the only stage in the system that is not a pure function of
   * `t` — it damps from the previous frame. So when the clock is NOT running, the carried state
   * is dropped and delta is 0, which reduces the correction to the soft-edge clamp with no
   * damping term: a pure function of this frame alone. Scrubbing to a time therefore always
   * yields the same pose, and only playback damps. The alternative — damping through a scrub —
   * would make the frame depend on how the author got there.
   *
   * **During a blend** the snapshot is already a mix of two shots, and the incoming shot's
   * composer is applied to that mix rather than to each shot separately. Resolving per shot
   * would mean re-running the library's block resolution twice per frame to undo work it just
   * did; the approximation converges the moment the blend completes.
   */
  private stepComposer(
    camera: Camera,
    snapshot: VirtualCameraSnapshot,
    definition: VirtualCameraDefinition,
    input: CameraDriveInput
  ): Vec3 | null {
    const playing = input.playing === true;
    if (!playing) this.composer.vcamId = null;

    const scratch = this.composerCamera;
    scratch.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    scratch.quaternion.set(
      snapshot.quaternion.x,
      snapshot.quaternion.y,
      snapshot.quaternion.z,
      snapshot.quaternion.w
    );
    // The composer's screen maths is in the RESOLVED lens, not the viewport's: a FOV push
    // changes what "inside the dead zone" means, and reading the live camera would lag it by a
    // frame or miss it entirely.
    const live = camera as Camera & { fov?: number; aspect?: number };
    scratch.fov = snapshot.lens?.fov ?? live.fov ?? 50;
    scratch.aspect = live.aspect && live.aspect > 0 ? live.aspect : 16 / 9;
    scratch.updateProjectionMatrix();
    // `getWorldDirection` reads matrixWorld, which for a camera outside any scene graph only
    // exists once composed from the local matrix.
    scratch.updateMatrixWorld(true);

    const target = stepComposerAim(
      scratch,
      definition,
      this.composer,
      (targetId) => input.getTargetPosition?.(targetId) ?? null,
      playing ? Math.max(0, input.deltaSeconds ?? 0) : 0
    );
    if (!target) return null;

    snapshot.quaternion = {
      x: scratch.quaternion.x,
      y: scratch.quaternion.y,
      z: scratch.quaternion.z,
      w: scratch.quaternion.w
    };
    return target;
  }

  private apply(
    camera: Camera,
    snapshot: VirtualCameraSnapshot,
    definition: VirtualCameraDefinition | undefined,
    controls: CameraControlsLike | null,
    composedTarget: Vec3 | null
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

    // `setLookAt` wants a pivot, not an orientation. Project one along the shot's forward axis,
    // so the controller's pivot lands on what the shot is framing and a viewer's own orbit turns
    // around the subject rather than around a point behind it. The distance comes from whatever
    // the shot actually frames: a composed/aimed target, else the orbit radius, else a default.
    const { position, quaternion } = snapshot;
    forward.set(0, 0, -1).applyQuaternion(quaternion as never);
    lookTarget.set(position.x, position.y, position.z);
    const distance = composedTarget
      ? Math.max(0.01, lookTarget.distanceTo(aimPoint.set(composedTarget.x, composedTarget.y, composedTarget.z)))
      : definition?.body.type === "orbit"
        ? Math.max(0.01, definition.body.radius)
        : 10;
    lookTarget.addScaledVector(forward, distance);

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
