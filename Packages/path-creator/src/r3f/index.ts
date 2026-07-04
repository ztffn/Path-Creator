import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import { Matrix4, Quaternion, Vector3, type Camera, type Object3D } from "three";
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
  composer?: ScreenComposerOptions & { target: Vec3 };
}

export interface ScreenComposerOptions {
  screenPosition?: { x: number; y: number };
  deadZone?: { width: number; height: number };
  softZone?: { width: number; height: number };
  hardLimits?: { width: number; height: number };
  damping?: { x: number; y: number };
  targetOffset?: Vec3;
  lookaheadTime?: number;
  lookaheadSmoothing?: number;
  lookaheadIgnoreY?: boolean;
  centerOnActivate?: boolean;
}

export interface ScreenComposerState {
  previousTarget?: Vec3;
  smoothedVelocity?: Vec3;
  initialized: boolean;
}

const _tmpVec = new Vector3();
const _tmpUp = new Vector3();
const _tmpLook = new Vector3();
const _tmpQuat = new Quaternion();
const _tmpMatrix = new Matrix4();
const _tmpRight = new Vector3();
const _tmpForward = new Vector3();
const _tmpZAxis = new Vector3();
const _tmpLocalTarget = new Vector3();

const DEFAULT_SCREEN_COMPOSER = {
  screenPosition: { x: 0, y: 0 },
  deadZone: { width: 0.15, height: 0.12 },
  softZone: { width: 0.55, height: 0.45 },
  hardLimits: { width: 0.9, height: 0.85 },
  damping: { x: 6, y: 6 }
};

const WORLD_UP = new Vector3(0, 1, 0);
const WORLD_RIGHT = new Vector3(1, 0, 0);
const EPSILON = 1e-6;

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

export function createScreenComposerState(): ScreenComposerState {
  return {
    initialized: false
  };
}

export function applyScreenComposerAim(
  camera: Camera,
  target: Vec3,
  railUp: Vec3,
  state: ScreenComposerState,
  options: ScreenComposerOptions = {},
  deltaSeconds = 0
): void {
  if (!isFiniteVec3(target)) {
    state.initialized = false;
    delete state.previousTarget;
    delete state.smoothedVelocity;
    return;
  }

  const screenPosition = options.screenPosition ?? DEFAULT_SCREEN_COMPOSER.screenPosition;
  const deadZone = options.deadZone ?? DEFAULT_SCREEN_COMPOSER.deadZone;
  const hardLimits = options.hardLimits ?? DEFAULT_SCREEN_COMPOSER.hardLimits;
  const damping = options.damping ?? DEFAULT_SCREEN_COMPOSER.damping;
  const delta = Math.max(0, deltaSeconds);

  const targetOffset = options.targetOffset ?? vec3.create();
  const composedTarget = vec3.add(target, targetOffset);
  const predictedTarget = applyLookahead(composedTarget, state, options, delta);

  const fov = getCameraFov(camera);
  if (!fov) return;

  _tmpLocalTarget
    .set(
      predictedTarget.x - camera.position.x,
      predictedTarget.y - camera.position.y,
      predictedTarget.z - camera.position.z
    )
    .applyQuaternion(_tmpQuat.copy(camera.quaternion).invert());

  if (_tmpLocalTarget.z >= -EPSILON) return;

  const horizontalFov = fov.horizontal;
  const verticalFov = fov.vertical;
  const screenX = Math.atan2(_tmpLocalTarget.x, -_tmpLocalTarget.z) / horizontalFov;
  const screenY =
    Math.atan2(_tmpLocalTarget.y, Math.hypot(_tmpLocalTarget.x, -_tmpLocalTarget.z)) /
    verticalFov;

  const offsetX = screenX - screenPosition.x;
  const offsetY = screenY - screenPosition.y;
  const deadHalfX = clampHalfSize(deadZone.width);
  const deadHalfY = clampHalfSize(deadZone.height);
  const hardHalfX = Math.max(deadHalfX, clampHalfSize(hardLimits.width));
  const hardHalfY = Math.max(deadHalfY, clampHalfSize(hardLimits.height));

  const firstFrame = !state.initialized;
  state.initialized = true;

  const correctionX = getScreenCorrection(
    offsetX,
    deadHalfX,
    hardHalfX,
    damping.x,
    delta,
    firstFrame && options.centerOnActivate === true
  );
  const correctionY = getScreenCorrection(
    offsetY,
    deadHalfY,
    hardHalfY,
    damping.y,
    delta,
    firstFrame && options.centerOnActivate === true
  );

  if (Math.abs(correctionX) < EPSILON && Math.abs(correctionY) < EPSILON) return;

  camera.getWorldDirection(_tmpForward).normalize();
  _tmpUp.set(railUp.x, railUp.y, railUp.z);
  if (_tmpUp.lengthSq() < EPSILON) {
    _tmpUp.copy(WORLD_UP);
  }
  _tmpUp.normalize();

  _tmpZAxis.copy(_tmpForward).multiplyScalar(-1);
  _tmpRight.crossVectors(_tmpUp, _tmpZAxis);
  if (_tmpRight.lengthSq() < EPSILON) {
    _tmpRight.copy(WORLD_RIGHT).applyQuaternion(camera.quaternion);
  }
  _tmpRight.normalize();

  _tmpForward.applyAxisAngle(_tmpUp, -correctionX * horizontalFov);
  _tmpForward.applyAxisAngle(_tmpRight, correctionY * verticalFov);
  _tmpForward.normalize();

  composeCameraQuaternion(camera, _tmpForward, _tmpUp);
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

export function vec3Distance(a: Vec3, b: Vec3): number {
  return vec3.distance(a, b);
}

function applyDollyCameraPosition(
  camera: Camera,
  sample: PathSample,
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
}

function applyLookahead(
  target: Vec3,
  state: ScreenComposerState,
  options: ScreenComposerOptions,
  deltaSeconds: number
): Vec3 {
  const previous = state.previousTarget;
  state.previousTarget = vec3.clone(target);

  if (!previous || !state.initialized || deltaSeconds <= 0) {
    state.smoothedVelocity = vec3.create();
    return target;
  }

  const movement = vec3.sub(target, previous);
  const distance = vec3.magnitude(movement);
  if (!Number.isFinite(distance) || distance > 25) {
    state.smoothedVelocity = vec3.create();
    return target;
  }

  const velocity = vec3.scale(movement, 1 / deltaSeconds);
  if (options.lookaheadIgnoreY) velocity.y = 0;

  const smoothing = Math.max(0, options.lookaheadSmoothing ?? 6);
  const alpha = smoothing > 0 ? 1 - Math.exp(-(12 / smoothing) * deltaSeconds) : 1;
  state.smoothedVelocity = state.smoothedVelocity
    ? vec3.lerp(state.smoothedVelocity, velocity, alpha)
    : velocity;

  const lookaheadTime = Math.max(0, options.lookaheadTime ?? 0);
  if (lookaheadTime <= 0) return target;

  return vec3.add(target, vec3.scale(state.smoothedVelocity, lookaheadTime));
}

function getScreenCorrection(
  offset: number,
  deadHalf: number,
  hardHalf: number,
  damping: number,
  deltaSeconds: number,
  centerImmediately: boolean
): number {
  if (centerImmediately) return offset;

  const sign = Math.sign(offset);
  const magnitude = Math.abs(offset);
  if (magnitude <= deadHalf) return 0;

  const hardCorrection = Math.max(0, magnitude - hardHalf);
  const afterHard = magnitude - hardCorrection;
  const dampedCorrection = Math.max(0, afterHard - deadHalf);
  const alpha = damping > 0 ? 1 - Math.exp(-damping * deltaSeconds) : 1;

  return sign * (hardCorrection + dampedCorrection * alpha);
}

function getCameraFov(camera: Camera): { horizontal: number; vertical: number } | null {
  if (!("fov" in camera) || !("aspect" in camera)) return null;

  const fovDegrees = Number(camera.fov);
  const aspect = Number(camera.aspect);
  if (!Number.isFinite(fovDegrees) || !Number.isFinite(aspect) || aspect <= 0) return null;

  const vertical = (fovDegrees * Math.PI) / 180;
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * aspect);
  return { horizontal, vertical };
}

function composeCameraQuaternion(camera: Camera, forward: Vector3, up: Vector3): void {
  _tmpZAxis.copy(forward).multiplyScalar(-1).normalize();
  _tmpRight.crossVectors(up, _tmpZAxis);

  if (_tmpRight.lengthSq() < EPSILON) {
    _tmpRight.copy(WORLD_RIGHT).applyQuaternion(camera.quaternion);
    if (_tmpRight.lengthSq() < EPSILON) _tmpRight.copy(WORLD_RIGHT);
  }
  _tmpRight.normalize();

  _tmpUp.crossVectors(_tmpZAxis, _tmpRight).normalize();
  _tmpMatrix.makeBasis(_tmpRight, _tmpUp, _tmpZAxis);
  camera.quaternion.setFromRotationMatrix(_tmpMatrix);
  camera.up.copy(_tmpUp);
}

function clampHalfSize(size: number): number {
  if (!Number.isFinite(size)) return 0;
  return Math.max(0, Math.min(1, size)) * 0.5;
}

function isFiniteVec3(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}
