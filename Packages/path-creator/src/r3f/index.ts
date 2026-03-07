import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { Quaternion, Vector3, type Camera, type Object3D } from "three";
import { EndOfPathInstruction, type Vec3, type VertexPath, vec3 } from "../core";

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
  path: VertexPath;
  speed: number;
  mode?: EndOfPathInstruction;
  initialDistance?: number;
}

export interface UseDollyCameraOptions extends UsePathFollowerOptions {
  lookAhead?: number;
  damping?: number;
}

const _tmpVec = new Vector3();
const _tmpUp = new Vector3();
const _tmpLook = new Vector3();
const _tmpQuat = new Quaternion();

export function updateFollowerState(
  state: FollowerState,
  speed: number,
  deltaSeconds: number,
  path: VertexPath,
  mode: EndOfPathInstruction
): FollowerState {
  const nextDistance = state.distance + speed * deltaSeconds;
  return {
    distance: path.resolveDistance(nextDistance, mode)
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
  const alpha = damping > 0 ? 1 - Math.exp(-damping * deltaSeconds) : 1;

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

export function useDollyCamera(options: UseDollyCameraOptions): {
  state: MutableRefObject<FollowerState>;
  step: (camera: Camera, deltaSeconds: number, target?: Vec3) => PathSample;
  reset: (distance?: number) => void;
} {
  const mode = options.mode ?? EndOfPathInstruction.Loop;
  const lookAhead = options.lookAhead ?? 0.5;
  const damping = Math.max(0, options.damping ?? 0);

  const state = useRef<FollowerState>({ distance: options.initialDistance ?? 0 });

  const step = useCallback(
    (camera: Camera, deltaSeconds: number, target?: Vec3) => {
      state.current = updateFollowerState(state.current, options.speed, deltaSeconds, options.path, mode);

      const current = samplePathAtDistance(options.path, state.current.distance, mode);
      const lookSample = samplePathAtDistance(options.path, state.current.distance + lookAhead, mode);
      const lookTarget = target ?? lookSample.position;

      applyDollyCamera(camera, current, lookTarget, damping, deltaSeconds);
      return current;
    },
    [damping, lookAhead, mode, options.path, options.speed]
  );

  const reset = useCallback((distance = options.initialDistance ?? 0) => {
    state.current = { distance };
  }, [options.initialDistance]);

  return { state, step, reset };
}

export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3.distance(a, b);
}
