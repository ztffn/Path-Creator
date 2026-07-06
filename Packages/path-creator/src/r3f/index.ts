import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { Quaternion, Vector3, type Camera, type Object3D } from "three";
import {
  EndOfPathInstruction,
  advanceCartDistance,
  createPathCart,
  sampleCartFrame,
  type CartFrame,
  type CartOrientationMode,
  type ComposerSettings,
  type PathCart,
  type Vec3,
  type VertexPath,
  vec3
} from "../core";
import {
  applyScreenComposerAim,
  createScreenComposerState,
  type ScreenComposerState
} from "../three";

// The screen composer moved to /three (pure three, no r3f); re-exported here so
// existing /r3f consumers keep importing it from the adapter they already use.
export { applyScreenComposerAim, createScreenComposerState } from "../three";
export type { ScreenComposerState } from "../three";

export interface FollowerState {
  distance: number;
}

export interface PathSample {
  distance: number;
  position: Vec3;
  direction: Vec3;
  normal: Vec3;
}

export interface UsePathFollowerOptions {
  /** Null yields a stationary follower (zero sample); lets hosts run the hook before a path is authored. */
  path: VertexPath | null;
  speed: number;
  mode?: EndOfPathInstruction;
  initialDistance?: number;
}

export interface UsePathCartOptions extends Omit<UsePathFollowerOptions, "path"> {
  path: VertexPath;
  orientationMode?: CartOrientationMode;
  positionOffset?: Vec3;
}

export interface UseDollyCameraOptions extends Omit<UsePathFollowerOptions, "path"> {
  path: VertexPath;
  lookAhead?: number;
  damping?: number;
  composer?: ComposerSettings & { target: Vec3 };
}

const _tmpVec = new Vector3();
const _tmpUp = new Vector3();
const _tmpLook = new Vector3();
const _tmpQuat = new Quaternion();

// Returned by a follower with no path: origin, +Z forward, +Y up. Frozen so
// the shared instance can never be mutated by a consumer.
const EMPTY_PATH_SAMPLE: PathSample = Object.freeze({
  distance: 0,
  position: Object.freeze({ x: 0, y: 0, z: 0 }),
  direction: Object.freeze({ x: 0, y: 0, z: 1 }),
  normal: Object.freeze({ x: 0, y: 1, z: 0 })
}) as PathSample;

export function updateFollowerState(
  state: FollowerState,
  speed: number,
  deltaSeconds: number,
  path: VertexPath,
  mode: EndOfPathInstruction
): FollowerState {
  return {
    distance: path.resolveDistance(state.distance + speed * deltaSeconds, mode)
  };
}

export function samplePathAtDistance(
  path: VertexPath,
  distance: number,
  mode: EndOfPathInstruction = EndOfPathInstruction.Loop
): PathSample {
  return {
    distance,
    position: path.getPointAtDistance(distance, mode),
    direction: path.getDirectionAtDistance(distance, mode),
    normal: path.getNormalAtDistance(distance, mode)
  };
}

export function applySampleToObject(object: Object3D, sample: PathSample): void {
  object.position.set(sample.position.x, sample.position.y, sample.position.z);

  _tmpVec.set(sample.direction.x, sample.direction.y, sample.direction.z).normalize();
  _tmpUp.set(sample.normal.x, sample.normal.y, sample.normal.z).normalize();

  _tmpQuat.setFromUnitVectors(new Vector3(0, 0, 1), _tmpVec);
  object.quaternion.copy(_tmpQuat);
  object.up.copy(_tmpUp);
}

export function applyDollyCamera(
  camera: Camera,
  sample: PathSample,
  lookTarget: Vec3,
  damping = 0,
  deltaSeconds = 0
): void {
  const alpha = damping > 0 ? 1 - Math.exp(-(12 / damping) * deltaSeconds) : 1;

  _tmpVec.set(sample.position.x, sample.position.y, sample.position.z);
  if (alpha < 1) {
    camera.position.lerp(_tmpVec, alpha);
  } else {
    camera.position.copy(_tmpVec);
  }

  _tmpLook.set(lookTarget.x, lookTarget.y, lookTarget.z);
  camera.lookAt(_tmpLook);

  _tmpUp.set(sample.normal.x, sample.normal.y, sample.normal.z).normalize();
  camera.up.lerp(_tmpUp, alpha).normalize();
}

export function usePathSample(
  path: VertexPath,
  distance: number,
  mode: EndOfPathInstruction = EndOfPathInstruction.Loop
): PathSample {
  return useMemo(() => samplePathAtDistance(path, distance, mode), [path, distance, mode]);
}

export function usePathFollower(options: UsePathFollowerOptions): {
  state: MutableRefObject<FollowerState>;
  step: (deltaSeconds: number) => PathSample;
  reset: (distance?: number) => void;
} {
  const mode = options.mode ?? EndOfPathInstruction.Loop;
  const state = useRef<FollowerState>({ distance: options.initialDistance ?? 0 });

  const step = useCallback(
    (deltaSeconds: number) => {
      if (!options.path) return EMPTY_PATH_SAMPLE;
      state.current = updateFollowerState(state.current, options.speed, deltaSeconds, options.path, mode);
      return samplePathAtDistance(options.path, state.current.distance, mode);
    },
    [mode, options.path, options.speed]
  );

  const reset = useCallback((distance = options.initialDistance ?? 0) => {
    state.current = { distance };
  }, [options.initialDistance]);

  return { state, step, reset };
}

/**
 * A cart riding the path: the generic motion primitive for anything that
 * follows a rail — props, vehicles, and (in later phases) virtual camera
 * bodies. step() advances live; sampleAt() is pure random access for
 * scrubbing. Apply frames with applyCartFrameToObject from the three entry.
 */
export function usePathCart(options: UsePathCartOptions): {
  cart: MutableRefObject<PathCart>;
  step: (deltaSeconds: number) => CartFrame;
  sampleAt: (distance?: number) => CartFrame;
  reset: (distance?: number) => void;
} {
  const cart = useRef<PathCart>(
    createPathCart({
      distance: options.initialDistance ?? 0,
      speed: options.speed,
      endOfPathInstruction: options.mode ?? EndOfPathInstruction.Loop,
      orientationMode: options.orientationMode ?? "path-frame",
      ...(options.positionOffset !== undefined && { positionOffset: options.positionOffset })
    })
  );

  const syncOptions = useCallback(() => {
    const current = cart.current;
    current.speed = options.speed;
    current.endOfPathInstruction = options.mode ?? EndOfPathInstruction.Loop;
    current.orientationMode = options.orientationMode ?? "path-frame";
    if (options.positionOffset !== undefined) {
      current.positionOffset = options.positionOffset;
    }
  }, [options.mode, options.orientationMode, options.positionOffset, options.speed]);

  const step = useCallback(
    (deltaSeconds: number) => {
      syncOptions();
      cart.current.distance = advanceCartDistance(options.path, cart.current, deltaSeconds);
      return sampleCartFrame(options.path, cart.current);
    },
    [options.path, syncOptions]
  );

  const sampleAt = useCallback(
    (distance?: number) => {
      syncOptions();
      return sampleCartFrame(options.path, cart.current, distance);
    },
    [options.path, syncOptions]
  );

  const reset = useCallback((distance = options.initialDistance ?? 0) => {
    cart.current.distance = distance;
  }, [options.initialDistance]);

  return { cart, step, sampleAt, reset };
}

export function useDollyCamera(options: UseDollyCameraOptions): {
  state: MutableRefObject<FollowerState>;
  step: (camera: Camera, deltaSeconds: number, target?: Vec3) => PathSample;
  reset: (distance?: number) => void;
} {
  const mode = options.mode ?? EndOfPathInstruction.Loop;
  const lookAhead = options.lookAhead ?? 0.5;
  const damping = Math.max(0, options.damping ?? 0);

  const state = useRef<FollowerState>({ distance: options.initialDistance ?? 0 });
  const composerState = useRef<ScreenComposerState>(createScreenComposerState());

  const step = useCallback(
    (camera: Camera, deltaSeconds: number, target?: Vec3) => {
      state.current = updateFollowerState(state.current, options.speed, deltaSeconds, options.path, mode);

      const current = samplePathAtDistance(options.path, state.current.distance, mode);
      const lookSample = samplePathAtDistance(options.path, state.current.distance + lookAhead, mode);
      const lookTarget = target ?? lookSample.position;

      if (options.composer) {
        applyDollyCameraPosition(camera, current, damping, deltaSeconds);
        applyScreenComposerAim(
          camera,
          options.composer.target,
          current.normal,
          composerState.current,
          options.composer,
          deltaSeconds
        );
      } else {
        applyDollyCamera(camera, current, lookTarget, damping, deltaSeconds);
      }
      return current;
    },
    [damping, lookAhead, mode, options.composer, options.path, options.speed]
  );

  const reset = useCallback((distance = options.initialDistance ?? 0) => {
    state.current = { distance };
    composerState.current = createScreenComposerState();
  }, [options.initialDistance]);

  return { state, step, reset };
}

export * from "./targets";
export * from "./editor";
export * from "./rig-line";
export * from "./rig-label";
export * from "./path-visual";
export * from "./path-editor";
export * from "./point-targets";
export * from "./cart-gizmo";
export * from "./rig-gizmo";
export * from "./vcam-glyph";
export * from "./rig-drive";

export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3.distance(a, b);
}

function applyDollyCameraPosition(
  camera: Camera,
  sample: PathSample,
  damping = 0,
  deltaSeconds = 0
): void {
  const alpha = damping > 0 ? 1 - Math.exp(-(12 / damping) * deltaSeconds) : 1;
  _tmpVec.set(sample.position.x, sample.position.y, sample.position.z);

  if (alpha < 1) {
    camera.position.lerp(_tmpVec, alpha);
  } else {
    camera.position.copy(_tmpVec);
  }
}

