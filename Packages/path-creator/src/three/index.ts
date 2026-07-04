import { Matrix4, Quaternion, Vector3, type Camera, type Object3D } from "three";
import {
  PathSpace,
  type CartFrame,
  type QuaternionLike,
  type TargetRegistry,
  type Vec3,
  type VertexPath,
  type VirtualCameraBlendCurve,
  type VirtualCameraDefinition,
  type VirtualCameraLens,
  type VirtualCameraNoiseSettings,
  type VirtualCameraResolveContext,
  type VirtualCameraSnapshot,
  vec3
} from "../core";

export type {
  QuaternionLike,
  VirtualCameraAimDefinition,
  VirtualCameraBlendCurve,
  VirtualCameraBodyDefinition,
  VirtualCameraDefinition,
  VirtualCameraLens,
  VirtualCameraNoiseSettings,
  VirtualCameraResolveContext,
  VirtualCameraSnapshot
} from "../core";

export interface MeshBuffers {
  positions: number[];
  indices: number[];
  normals?: number[];
  uvs?: number[];
}

export interface RoadMeshOptions {
  roadWidth?: number;
  thickness?: number;
  flattenSurface?: boolean;
}

export interface TubeMeshOptions {
  radius?: number;
  radialSegments?: number;
  segmentsPerUnit?: number;
}

export interface VirtualCameraBlendOptions {
  curve?: VirtualCameraBlendCurve;
}

export interface VirtualCameraTransition {
  durationSeconds?: number;
  elapsedSeconds?: number;
  curve?: VirtualCameraBlendCurve;
}

export interface VirtualCameraBrainState {
  live?: VirtualCameraSnapshot;
  previous?: VirtualCameraSnapshot;
  target?: VirtualCameraSnapshot;
  elapsedSeconds: number;
  durationSeconds: number;
  curve: VirtualCameraBlendCurve;
  isBlending: boolean;
}

interface LensCamera extends Camera {
  fov?: number;
  zoom?: number;
  near?: number;
  far?: number;
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  updateProjectionMatrix?: () => void;
}

export interface ObjectTargetsOptions {
  /** Only register descendants whose name is in this list. */
  names?: string[];
  /** Only register descendants whose name matches. */
  pattern?: RegExp;
  /** Arbitrary predicate; combined with names/pattern when both given. */
  filter?: (object: Object3D) => boolean;
  /** Prefix for generated target ids (default: the root object's name). */
  idPrefix?: string;
  /** Include the root object itself when it matches (default true). */
  includeRoot?: boolean;
}

const _targetWorldPosition = new Vector3();

/**
 * Registers a single Object3D as a tracking target; the registry pulls its
 * live world position at resolve time. Returns an unregister function.
 */
export function registerObjectTarget(
  registry: TargetRegistry,
  id: string,
  object: Object3D,
  name?: string
): () => void {
  return registry.register(
    id,
    () => {
      object.getWorldPosition(_targetWorldPosition);
      return {
        x: _targetWorldPosition.x,
        y: _targetWorldPosition.y,
        z: _targetWorldPosition.z
      };
    },
    name ?? (object.name || id)
  );
}

/**
 * Walks an object hierarchy (typically a loaded GLTF scene) and registers
 * every matching named node as a tracking target. Ids are
 * `<idPrefix>/<node.name>`; unnamed nodes are skipped. Returns one dispose
 * function that unregisters everything it added.
 */
export function registerObjectTargets(
  registry: TargetRegistry,
  root: Object3D,
  options: ObjectTargetsOptions = {}
): () => void {
  const idPrefix = options.idPrefix ?? root.name ?? "";
  const includeRoot = options.includeRoot ?? true;
  const disposers: Array<() => void> = [];

  const matches = (object: Object3D): boolean => {
    if (!object.name) return false;
    if (options.names && !options.names.includes(object.name)) return false;
    if (options.pattern && !options.pattern.test(object.name)) return false;
    if (options.filter && !options.filter(object)) return false;
    return true;
  };

  root.traverse((object) => {
    if (object === root && !includeRoot) return;
    if (!matches(object)) return;
    const id = idPrefix ? `${idPrefix}/${object.name}` : object.name;
    disposers.push(registerObjectTarget(registry, id, object, object.name));
  });

  return () => {
    for (const dispose of disposers) dispose();
  };
}

const _cartRight = new Vector3();
const _cartUp = new Vector3();
const _cartForward = new Vector3();
const _cartMatrix = new Matrix4();

/**
 * Places an object at a cart frame: position with rail offset applied,
 * orientation from the frame basis with the object's +Z as forward
 * (same convention as applySampleToObject).
 */
export function applyCartFrameToObject(object: Object3D, frame: CartFrame): void {
  object.position.set(frame.position.x, frame.position.y, frame.position.z);

  _cartRight.set(frame.right.x, frame.right.y, frame.right.z);
  _cartUp.set(frame.up.x, frame.up.y, frame.up.z);
  _cartForward.set(frame.forward.x, frame.forward.y, frame.forward.z);
  _cartMatrix.makeBasis(_cartRight, _cartUp, _cartForward);
  object.quaternion.setFromRotationMatrix(_cartMatrix);
  object.up.copy(_cartUp);
}

const ROAD_TRIANGLE_MAP = [0, 8, 1, 1, 8, 9] as const;
const ROAD_SIDE_TRIANGLE_MAP = [4, 6, 14, 12, 4, 14, 5, 15, 7, 13, 15, 5] as const;
const _virtualCameraPositionA = new Vector3();
const _virtualCameraPositionB = new Vector3();
const _virtualCameraQuaternionA = new Quaternion();
const _virtualCameraQuaternionB = new Quaternion();

export function buildPolylineBuffers(points: Vec3[]): MeshBuffers {
  const positions: number[] = [];
  for (const p of points) {
    positions.push(p.x, p.y, p.z);
  }

  const indices: number[] = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    indices.push(i, i + 1);
  }

  return { positions, indices };
}

export function buildRoadMeshBuffers(path: VertexPath, options: RoadMeshOptions = {}): MeshBuffers {
  const roadWidth = Math.abs(options.roadWidth ?? 0.4);
  const thickness = Math.max(0, options.thickness ?? 0.15);
  const flattenSurface = options.flattenSurface ?? false;

  const vertCount = path.numPoints * 8;
  const positions = new Array<number>(vertCount * 3).fill(0);
  const normals = new Array<number>(vertCount * 3).fill(0);
  const uvs = new Array<number>(vertCount * 2).fill(0);

  const numTris = 2 * (path.numPoints - 1) + (path.isClosedLoop ? 2 : 0);
  const roadTriangles = new Array<number>(numTris * 3).fill(0);
  const underRoadTriangles = new Array<number>(numTris * 3).fill(0);
  const sideTriangles = new Array<number>(numTris * 2 * 3).fill(0);

  let vertIndex = 0;
  let triIndex = 0;

  const usePathNormals = !(path.space === PathSpace.XYZ && flattenSurface);

  for (let i = 0; i < path.numPoints; i += 1) {
    const tangent = path.getTangent(i);
    const normal = path.getNormal(i);

    const localUp = usePathNormals ? vec3.cross(tangent, normal) : path.up;
    const localRight = usePathNormals ? normal : vec3.cross(localUp, tangent);

    const p = path.getPoint(i);
    const sideA = vec3.sub(p, vec3.scale(localRight, roadWidth));
    const sideB = vec3.add(p, vec3.scale(localRight, roadWidth));

    const v = [
      sideA,
      sideB,
      vec3.sub(sideA, vec3.scale(localUp, thickness)),
      vec3.sub(sideB, vec3.scale(localUp, thickness))
    ] as const;

    setVertex(positions, vertIndex + 0, v[0]);
    setVertex(positions, vertIndex + 1, v[1]);
    setVertex(positions, vertIndex + 2, v[2]);
    setVertex(positions, vertIndex + 3, v[3]);
    setVertex(positions, vertIndex + 4, v[0]);
    setVertex(positions, vertIndex + 5, v[1]);
    setVertex(positions, vertIndex + 6, v[2]);
    setVertex(positions, vertIndex + 7, v[3]);

    setUv(uvs, vertIndex + 0, 0, path.times[i]);
    setUv(uvs, vertIndex + 1, 1, path.times[i]);

    setVertex(normals, vertIndex + 0, localUp);
    setVertex(normals, vertIndex + 1, localUp);
    setVertex(normals, vertIndex + 2, vec3.scale(localUp, -1));
    setVertex(normals, vertIndex + 3, vec3.scale(localUp, -1));
    setVertex(normals, vertIndex + 4, vec3.scale(localRight, -1));
    setVertex(normals, vertIndex + 5, localRight);
    setVertex(normals, vertIndex + 6, vec3.scale(localRight, -1));
    setVertex(normals, vertIndex + 7, localRight);

    if (i < path.numPoints - 1 || path.isClosedLoop) {
      for (let j = 0; j < ROAD_TRIANGLE_MAP.length; j += 1) {
        roadTriangles[triIndex + j] = (vertIndex + ROAD_TRIANGLE_MAP[j]) % vertCount;
        underRoadTriangles[triIndex + j] =
          (vertIndex + ROAD_TRIANGLE_MAP[ROAD_TRIANGLE_MAP.length - 1 - j] + 2) % vertCount;
      }

      for (let j = 0; j < ROAD_SIDE_TRIANGLE_MAP.length; j += 1) {
        sideTriangles[triIndex * 2 + j] = (vertIndex + ROAD_SIDE_TRIANGLE_MAP[j]) % vertCount;
      }
    }

    vertIndex += 8;
    triIndex += 6;
  }

  return {
    positions,
    normals,
    uvs,
    indices: [...roadTriangles, ...underRoadTriangles, ...sideTriangles]
  };
}

export function buildTubeMeshBuffers(path: VertexPath, options: TubeMeshOptions = {}): MeshBuffers {
  const radius = Math.max(0.0001, options.radius ?? 0.15);
  const radialSegments = Math.max(3, Math.floor(options.radialSegments ?? 10));
  const segmentsPerUnit = Math.max(0.1, options.segmentsPerUnit ?? 20);

  const rings = Math.max(2, Math.round(path.length * segmentsPerUnit) + 1);
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let s = 0; s < rings; s += 1) {
    const t = rings === 1 ? 0 : s / (rings - 1);
    const center = path.getPointAtTime(t);
    const n = vec3.normalize(path.getNormalAtTime(t));
    const f = vec3.normalize(path.getDirection(t));
    const b = vec3.normalize(vec3.cross(n, f));

    for (let r = 0; r < radialSegments; r += 1) {
      const angle = (r / radialSegments) * Math.PI * 2;
      const offset = vec3.add(vec3.scale(n, Math.sin(angle) * radius), vec3.scale(b, Math.cos(angle) * radius));
      const p = vec3.add(center, offset);
      positions.push(p.x, p.y, p.z);

      const normal = vec3.normalize(offset);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(r / radialSegments, t);

      if (s < rings - 1) {
        const start = s * radialSegments;
        const next = (r + 1) % radialSegments;
        indices.push(start + r, start + next, start + r + radialSegments);
        indices.push(start + next, start + next + radialSegments, start + r + radialSegments);
      }
    }
  }

  return { positions, normals, uvs, indices };
}

const _bodyForward = new Vector3();
const _bodyUp = new Vector3();
const _bodyRight = new Vector3();
const _bodyBack = new Vector3();
const _bodyMatrix = new Matrix4();
const _bodyQuaternion = new Quaternion();

/**
 * Camera-convention orientation: the camera looks along `forward` (local -Z)
 * with `up` as the up hint. Counterpart of applyCartFrameToObject's +Z prop
 * convention.
 */
export function cameraQuaternionFromFrame(forward: Vec3, up: Vec3): QuaternionLike {
  _bodyBack.set(-forward.x, -forward.y, -forward.z).normalize();
  _bodyUp.set(up.x, up.y, up.z);
  _bodyRight.crossVectors(_bodyUp, _bodyBack);
  if (_bodyRight.lengthSq() < 1e-12) {
    _bodyUp.set(Math.abs(_bodyBack.y) < 0.99 ? 0 : 1, Math.abs(_bodyBack.y) < 0.99 ? 1 : 0, 0);
    _bodyRight.crossVectors(_bodyUp, _bodyBack);
  }
  _bodyRight.normalize();
  _bodyUp.crossVectors(_bodyBack, _bodyRight).normalize();
  _bodyMatrix.makeBasis(_bodyRight, _bodyUp, _bodyBack);
  _bodyQuaternion.setFromRotationMatrix(_bodyMatrix);
  return {
    x: _bodyQuaternion.x,
    y: _bodyQuaternion.y,
    z: _bodyQuaternion.z,
    w: _bodyQuaternion.w
  };
}

/**
 * Resolves a virtual camera definition to a snapshot: body pose (static or
 * cart frame), then aim, then lens/settings. Pure per-frame — a cart-bodied
 * vcam resolves to a new snapshot as its cart moves. Returns null when a
 * referenced cart is unavailable.
 */
export function resolveVirtualCameraDefinition(
  definition: VirtualCameraDefinition,
  context: VirtualCameraResolveContext = {}
): VirtualCameraSnapshot | null {
  let position: Vec3;
  let quaternion: QuaternionLike;
  let bodyUp: Vec3;

  if (definition.body.type === "static") {
    position = { ...definition.body.position };
    quaternion = { ...definition.body.quaternion };
    _bodyUp.set(0, 1, 0).applyQuaternion(
      _bodyQuaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w)
    );
    bodyUp = { x: _bodyUp.x, y: _bodyUp.y, z: _bodyUp.z };
  } else {
    const frame = context.getCartFrame?.(definition.body.cartId) ?? null;
    if (!frame) return null;

    const offset = definition.body.positionOffset ?? vec3.create();
    position = vec3.add(
      frame.position,
      vec3.add(
        vec3.add(vec3.scale(frame.right, offset.x), vec3.scale(frame.up, offset.y)),
        vec3.scale(frame.forward, offset.z)
      )
    );
    quaternion = cameraQuaternionFromFrame(frame.forward, frame.up);
    bodyUp = frame.up;
  }

  if (definition.aim?.type === "look-at") {
    const aimTarget =
      "targetId" in definition.aim.target
        ? context.getTargetPosition?.(definition.aim.target.targetId) ?? null
        : definition.aim.target;
    if (aimTarget) {
      _bodyForward.set(
        aimTarget.x - position.x,
        aimTarget.y - position.y,
        aimTarget.z - position.z
      );
      if (_bodyForward.lengthSq() > 1e-12) {
        quaternion = cameraQuaternionFromFrame(
          { x: _bodyForward.x, y: _bodyForward.y, z: _bodyForward.z },
          bodyUp
        );
      }
    }
  }

  let snapshot: VirtualCameraSnapshot = { position, quaternion };
  if (definition.name !== undefined) snapshot.name = definition.name;
  if (definition.lens) snapshot.lens = { ...definition.lens };
  if (definition.settings) snapshot.settings = { ...definition.settings };
  if (definition.noise) {
    snapshot = applyVirtualCameraNoise(snapshot, definition.noise, context.elapsedSeconds ?? 0);
  }
  return snapshot;
}

const _noisePosition = new Vector3();
const _noiseQuaternion = new Quaternion();
const _noiseEuler = new Vector3();
const _noiseRotation = new Quaternion();
const DEG_TO_RAD = Math.PI / 180;

function noiseHash(seed: number, index: number): number {
  let h = Math.imul(index ^ seed, 0x9e3779b1);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca77);
  h ^= h >>> 13;
  return ((h >>> 0) / 0xffffffff) * 2 - 1;
}

/** Seeded 1D value noise in [-1, 1]; two octaves for a handheld feel. */
function valueNoise1D(seed: number, t: number): number {
  let sum = 0;
  let amplitude = 0.75;
  let frequency = 1;
  for (let octave = 0; octave < 2; octave += 1) {
    const x = t * frequency;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    const seedO = seed + octave * 7919;
    sum += (noiseHash(seedO, i) * (1 - s) + noiseHash(seedO, i + 1) * s) * amplitude;
    amplitude *= 0.35;
    frequency *= 2.7;
  }
  return sum;
}

function noiseAxis(value: number | Vec3 | undefined, axis: "x" | "y" | "z", fallback = 0): number {
  if (value === undefined) return fallback;
  return typeof value === "number" ? value : value[axis];
}

/**
 * Post-aim noise stage: seeded procedural wobble applied in camera-local
 * space. A pure function of (settings, timeSeconds) — scrubbing a timeline
 * to the same time reproduces the identical shake.
 */
export function applyVirtualCameraNoise(
  snapshot: VirtualCameraSnapshot,
  noise: VirtualCameraNoiseSettings,
  timeSeconds: number
): VirtualCameraSnapshot {
  const seed = noise.seed ?? 1;
  _noiseQuaternion.set(
    snapshot.quaternion.x,
    snapshot.quaternion.y,
    snapshot.quaternion.z,
    snapshot.quaternion.w
  );

  _noisePosition.set(0, 0, 0);
  for (const axis of ["x", "y", "z"] as const) {
    const amplitude = noiseAxis(noise.positionAmplitude, axis);
    if (amplitude === 0) continue;
    const frequency = noiseAxis(noise.positionFrequency, axis, 1);
    const axisSeed = seed + (axis === "x" ? 11 : axis === "y" ? 211 : 3011);
    _noisePosition[axis] = valueNoise1D(axisSeed, timeSeconds * frequency) * amplitude;
  }
  _noisePosition.applyQuaternion(_noiseQuaternion);

  _noiseEuler.set(0, 0, 0);
  for (const axis of ["x", "y", "z"] as const) {
    const amplitude = noiseAxis(noise.rotationAmplitudeDeg, axis);
    if (amplitude === 0) continue;
    const frequency = noiseAxis(noise.rotationFrequencyDeg, axis, 1);
    const axisSeed = seed + (axis === "x" ? 51_31 : axis === "y" ? 71_23 : 91_11);
    _noiseEuler[axis] = valueNoise1D(axisSeed, timeSeconds * frequency) * amplitude * DEG_TO_RAD;
  }
  _noiseRotation.set(
    Math.sin(_noiseEuler.x / 2),
    0,
    0,
    Math.cos(_noiseEuler.x / 2)
  );
  _noiseQuaternion.multiply(_noiseRotation);
  _noiseRotation.set(0, Math.sin(_noiseEuler.y / 2), 0, Math.cos(_noiseEuler.y / 2));
  _noiseQuaternion.multiply(_noiseRotation);
  _noiseRotation.set(0, 0, Math.sin(_noiseEuler.z / 2), Math.cos(_noiseEuler.z / 2));
  _noiseQuaternion.multiply(_noiseRotation);

  return {
    ...snapshot,
    position: {
      x: snapshot.position.x + _noisePosition.x,
      y: snapshot.position.y + _noisePosition.y,
      z: snapshot.position.z + _noisePosition.z
    },
    quaternion: {
      x: _noiseQuaternion.x,
      y: _noiseQuaternion.y,
      z: _noiseQuaternion.z,
      w: _noiseQuaternion.w
    }
  };
}

/**
 * Replaces the brain's blend endpoints without restarting the blend, so a
 * moving vcam (cart body) keeps its blend chasing the live pose — matching
 * Cinemachine, where both cameras stay live during a blend.
 */
export function retargetVirtualCameraBrain(
  state: VirtualCameraBrainState,
  sources: { previous?: VirtualCameraSnapshot; target?: VirtualCameraSnapshot }
): void {
  if (sources.previous && state.previous) {
    state.previous = cloneVirtualCameraSnapshot(sources.previous);
  }
  if (sources.target && state.target) {
    state.target = cloneVirtualCameraSnapshot(sources.target);
  }
}

export function captureVirtualCameraSnapshot(
  camera: Camera,
  options: { name?: string; settings?: Record<string, number> } = {}
): VirtualCameraSnapshot {
  const snapshot: VirtualCameraSnapshot = {
    position: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z
    },
    quaternion: {
      x: camera.quaternion.x,
      y: camera.quaternion.y,
      z: camera.quaternion.z,
      w: camera.quaternion.w
    }
  };

  if (options.name !== undefined) snapshot.name = options.name;
  const lens = captureVirtualCameraLens(camera);
  if (lens) snapshot.lens = lens;
  if (options.settings) snapshot.settings = { ...options.settings };

  return snapshot;
}

export function applyVirtualCameraSnapshot(camera: Camera, snapshot: VirtualCameraSnapshot): void {
  camera.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
  camera.quaternion.set(
    snapshot.quaternion.x,
    snapshot.quaternion.y,
    snapshot.quaternion.z,
    snapshot.quaternion.w
  );

  if (snapshot.lens) {
    if (snapshot.lens.dutchDeg) {
      const half = (-snapshot.lens.dutchDeg * DEG_TO_RAD) / 2;
      _noiseRotation.set(0, 0, Math.sin(half), Math.cos(half));
      camera.quaternion.multiply(_noiseRotation);
    }
    applyVirtualCameraLens(camera, snapshot.lens);
  }
}

export function blendVirtualCameraSnapshots(
  from: VirtualCameraSnapshot,
  to: VirtualCameraSnapshot,
  t: number,
  options: VirtualCameraBlendOptions = {}
): VirtualCameraSnapshot {
  const alpha = evaluateVirtualCameraBlendCurve(t, options.curve);

  _virtualCameraPositionA.set(from.position.x, from.position.y, from.position.z);
  _virtualCameraPositionB.set(to.position.x, to.position.y, to.position.z);
  _virtualCameraPositionA.lerp(_virtualCameraPositionB, alpha);

  _virtualCameraQuaternionA.set(
    from.quaternion.x,
    from.quaternion.y,
    from.quaternion.z,
    from.quaternion.w
  );
  _virtualCameraQuaternionB.set(to.quaternion.x, to.quaternion.y, to.quaternion.z, to.quaternion.w);
  _virtualCameraQuaternionA.slerp(_virtualCameraQuaternionB, alpha);

  const snapshot: VirtualCameraSnapshot = {
    position: {
      x: _virtualCameraPositionA.x,
      y: _virtualCameraPositionA.y,
      z: _virtualCameraPositionA.z
    },
    quaternion: {
      x: _virtualCameraQuaternionA.x,
      y: _virtualCameraQuaternionA.y,
      z: _virtualCameraQuaternionA.z,
      w: _virtualCameraQuaternionA.w
    }
  };

  const name = alpha >= 1 ? to.name : from.name;
  const lens = blendVirtualCameraLens(from.lens, to.lens, alpha);
  const settings = blendVirtualCameraSettings(from.settings, to.settings, alpha);

  if (name !== undefined) snapshot.name = name;
  if (lens) snapshot.lens = lens;
  if (settings) snapshot.settings = settings;

  return snapshot;
}

export function resolveVirtualCameraTransition(
  from: VirtualCameraSnapshot | undefined,
  to: VirtualCameraSnapshot,
  transition: VirtualCameraTransition = {}
): VirtualCameraSnapshot {
  const duration = Math.max(0, transition.durationSeconds ?? 0);
  if (!from || duration === 0 || transition.curve === "cut") {
    return cloneVirtualCameraSnapshot(to);
  }

  const elapsed = Math.max(0, transition.elapsedSeconds ?? 0);
  return blendVirtualCameraSnapshots(from, to, elapsed / duration, {
    curve: transition.curve ?? "easeInOut"
  });
}

export function applyVirtualCameraTransition(
  camera: Camera,
  from: VirtualCameraSnapshot | undefined,
  to: VirtualCameraSnapshot,
  transition: VirtualCameraTransition = {}
): VirtualCameraSnapshot {
  const snapshot = resolveVirtualCameraTransition(from, to, transition);
  applyVirtualCameraSnapshot(camera, snapshot);
  return snapshot;
}

export function createVirtualCameraBrainState(
  initial?: VirtualCameraSnapshot
): VirtualCameraBrainState {
  const state: VirtualCameraBrainState = {
    elapsedSeconds: 0,
    durationSeconds: 0,
    curve: "cut",
    isBlending: false
  };

  if (initial) {
    const live = cloneVirtualCameraSnapshot(initial);
    state.live = live;
    state.target = cloneVirtualCameraSnapshot(live);
  }

  return state;
}

export function activateVirtualCameraBrain(
  state: VirtualCameraBrainState,
  target: VirtualCameraSnapshot,
  transition: Omit<VirtualCameraTransition, "elapsedSeconds"> = {}
): void {
  const previous = state.live ? cloneVirtualCameraSnapshot(state.live) : undefined;
  const durationSeconds = Math.max(0, transition.durationSeconds ?? 0);
  const curve = transition.curve ?? "easeInOut";

  state.target = cloneVirtualCameraSnapshot(target);
  state.elapsedSeconds = 0;
  state.durationSeconds = durationSeconds;
  state.curve = curve;

  if (!previous || durationSeconds === 0 || curve === "cut") {
    delete state.previous;
    state.live = cloneVirtualCameraSnapshot(target);
    state.isBlending = false;
    return;
  }

  state.previous = previous;
  state.live = resolveVirtualCameraTransition(previous, target, {
    durationSeconds,
    elapsedSeconds: 0,
    curve
  });
  state.isBlending = true;
}

export function updateVirtualCameraBrain(
  state: VirtualCameraBrainState,
  deltaSeconds: number
): VirtualCameraSnapshot | undefined {
  if (!state.target) {
    return state.live ? cloneVirtualCameraSnapshot(state.live) : undefined;
  }

  if (!state.isBlending || !state.previous) {
    state.live = cloneVirtualCameraSnapshot(state.target);
    return cloneVirtualCameraSnapshot(state.live);
  }

  state.elapsedSeconds = Math.min(
    state.durationSeconds,
    state.elapsedSeconds + Math.max(0, deltaSeconds)
  );
  state.live = resolveVirtualCameraTransition(state.previous, state.target, {
    durationSeconds: state.durationSeconds,
    elapsedSeconds: state.elapsedSeconds,
    curve: state.curve
  });

  if (state.elapsedSeconds >= state.durationSeconds) {
    state.live = cloneVirtualCameraSnapshot(state.target);
    state.isBlending = false;
  }

  return cloneVirtualCameraSnapshot(state.live);
}

export function applyVirtualCameraBrain(
  camera: Camera,
  state: VirtualCameraBrainState,
  deltaSeconds: number
): VirtualCameraSnapshot | undefined {
  const snapshot = updateVirtualCameraBrain(state, deltaSeconds);
  if (snapshot) {
    applyVirtualCameraSnapshot(camera, snapshot);
  }
  return snapshot;
}

export function getVirtualCameraBrainProgress(state: VirtualCameraBrainState): number {
  if (!state.isBlending || state.durationSeconds <= 0) return 1;
  return Math.min(1, Math.max(0, state.elapsedSeconds / state.durationSeconds));
}

export function evaluateVirtualCameraBlendCurve(
  t: number,
  curve: VirtualCameraBlendCurve = "easeInOut"
): number {
  const alpha = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));

  switch (curve) {
    case "cut":
      return 1;
    case "linear":
      return alpha;
    case "easeIn":
      return alpha * alpha;
    case "easeOut":
      return 1 - (1 - alpha) * (1 - alpha);
    case "hardIn":
      return alpha * alpha * alpha;
    case "hardOut":
      return 1 - (1 - alpha) * (1 - alpha) * (1 - alpha);
    case "easeInOut":
    default:
      return alpha * alpha * (3 - 2 * alpha);
  }
}

function setVertex(buffer: number[], index: number, v: Vec3): void {
  const offset = index * 3;
  buffer[offset] = v.x;
  buffer[offset + 1] = v.y;
  buffer[offset + 2] = v.z;
}

function setUv(buffer: number[], index: number, u: number, v: number): void {
  const offset = index * 2;
  buffer[offset] = u;
  buffer[offset + 1] = v;
}

function cloneVirtualCameraSnapshot(snapshot: VirtualCameraSnapshot): VirtualCameraSnapshot {
  const clone: VirtualCameraSnapshot = {
    position: { ...snapshot.position },
    quaternion: { ...snapshot.quaternion }
  };

  if (snapshot.name !== undefined) clone.name = snapshot.name;
  if (snapshot.lens) clone.lens = { ...snapshot.lens };
  if (snapshot.settings) clone.settings = { ...snapshot.settings };

  return clone;
}

function captureVirtualCameraLens(camera: Camera): VirtualCameraLens | undefined {
  const lensCamera = camera as LensCamera;
  const lens: VirtualCameraLens = {};

  if (typeof lensCamera.fov === "number") lens.fov = lensCamera.fov;
  if (typeof lensCamera.zoom === "number") lens.zoom = lensCamera.zoom;
  if (typeof lensCamera.near === "number") lens.near = lensCamera.near;
  if (typeof lensCamera.far === "number") lens.far = lensCamera.far;
  if (typeof lensCamera.top === "number" && typeof lensCamera.bottom === "number") {
    lens.orthographicSize = Math.abs(lensCamera.top - lensCamera.bottom) / 2;
  }

  return Object.keys(lens).length > 0 ? lens : undefined;
}

function applyVirtualCameraLens(camera: Camera, lens: VirtualCameraLens): void {
  const lensCamera = camera as LensCamera;

  if (lens.fov !== undefined && typeof lensCamera.fov === "number") {
    lensCamera.fov = lens.fov;
  }
  if (lens.zoom !== undefined && typeof lensCamera.zoom === "number") {
    lensCamera.zoom = lens.zoom;
  }
  if (lens.near !== undefined && typeof lensCamera.near === "number") {
    lensCamera.near = lens.near;
  }
  if (lens.far !== undefined && typeof lensCamera.far === "number") {
    lensCamera.far = lens.far;
  }
  if (
    lens.orthographicSize !== undefined &&
    typeof lensCamera.left === "number" &&
    typeof lensCamera.right === "number" &&
    typeof lensCamera.top === "number" &&
    typeof lensCamera.bottom === "number"
  ) {
    const centerX = (lensCamera.left + lensCamera.right) / 2;
    const centerY = (lensCamera.top + lensCamera.bottom) / 2;
    const width = Math.abs(lensCamera.right - lensCamera.left);
    const height = Math.abs(lensCamera.top - lensCamera.bottom);
    const aspect = height > 0 ? width / height : 1;
    const halfHeight = Math.max(0.000001, lens.orthographicSize);
    const halfWidth = halfHeight * aspect;
    lensCamera.left = centerX - halfWidth;
    lensCamera.right = centerX + halfWidth;
    lensCamera.top = centerY + halfHeight;
    lensCamera.bottom = centerY - halfHeight;
  }

  lensCamera.updateProjectionMatrix?.();
}

function blendVirtualCameraLens(
  from: VirtualCameraLens | undefined,
  to: VirtualCameraLens | undefined,
  alpha: number
): VirtualCameraLens | undefined {
  if (!from && !to) return undefined;

  const lens: VirtualCameraLens = {};
  const fov = blendOptionalNumber(from?.fov, to?.fov, alpha);
  const zoom = blendOptionalNumber(from?.zoom, to?.zoom, alpha);
  const near = blendOptionalNumber(from?.near, to?.near, alpha);
  const far = blendOptionalNumber(from?.far, to?.far, alpha);
  const orthographicSize = blendOptionalNumber(from?.orthographicSize, to?.orthographicSize, alpha);
  const dutchDeg = blendOptionalNumber(from?.dutchDeg ?? 0, to?.dutchDeg ?? 0, alpha);

  if (fov !== undefined) lens.fov = fov;
  if (zoom !== undefined) lens.zoom = zoom;
  if (near !== undefined) lens.near = near;
  if (far !== undefined) lens.far = far;
  if (orthographicSize !== undefined) lens.orthographicSize = orthographicSize;
  if (dutchDeg !== undefined && dutchDeg !== 0) lens.dutchDeg = dutchDeg;

  return Object.keys(lens).length > 0 ? lens : undefined;
}

function blendVirtualCameraSettings(
  from: Record<string, number> | undefined,
  to: Record<string, number> | undefined,
  alpha: number
): Record<string, number> | undefined {
  if (!from && !to) return undefined;

  const result: Record<string, number> = {};
  const keys = new Set([...Object.keys(from ?? {}), ...Object.keys(to ?? {})]);
  for (const key of keys) {
    result[key] = blendOptionalNumber(from?.[key], to?.[key], alpha) ?? 0;
  }
  return result;
}

function blendOptionalNumber(
  from: number | undefined,
  to: number | undefined,
  alpha: number
): number | undefined {
  if (from === undefined && to === undefined) return undefined;
  if (from === undefined) return to;
  if (to === undefined) return from;
  return from + (to - from) * alpha;
}
