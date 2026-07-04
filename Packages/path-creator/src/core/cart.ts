// Path cart: a rig-agnostic frame (position + orientation basis) that travels
// along a VertexPath. Carts are the coupling seam between paths and the things
// that ride them (virtual camera bodies, props, vehicles): paths know nothing
// about riders, riders know nothing about paths. Supports live stepping and
// pure random-access sampling so timelines can scrub deterministically.
import { EndOfPathInstruction, type Vec3 } from "./types";
import { vec3 } from "./vec3";
import type { VertexPath } from "./vertex-path";

export type CartOrientationMode = "path-frame" | "path-yaw" | "fixed";

export interface PathCart {
  distance: number;
  speed: number;
  endOfPathInstruction: EndOfPathInstruction;
  orientationMode: CartOrientationMode;
  /** Rail-local offset: x along right, y along up, z along forward. */
  positionOffset: Vec3;
}

export interface CartFrame {
  /** Final position with the rail-local offset applied. */
  position: Vec3;
  /** On-rail position before the offset. */
  railPosition: Vec3;
  forward: Vec3;
  up: Vec3;
  right: Vec3;
  /** Resolved distance along the path (after end-of-path handling). */
  distance: number;
  /** Normalized position on the path (0..1). */
  time: number;
}

export interface SerializedPathCart extends PathCart {
  pathId: string;
}

const EPSILON = 1e-8;

export function createPathCart(init: Partial<PathCart> = {}): PathCart {
  return {
    distance: init.distance ?? 0,
    speed: init.speed ?? 0,
    endOfPathInstruction: init.endOfPathInstruction ?? EndOfPathInstruction.Loop,
    orientationMode: init.orientationMode ?? "path-frame",
    positionOffset: init.positionOffset ? vec3.clone(init.positionOffset) : vec3.create()
  };
}

/**
 * Pure step: returns the cart's next resolved distance after deltaSeconds.
 * Callers own state; assign the result back to cart.distance to advance.
 */
export function advanceCartDistance(
  path: VertexPath,
  cart: PathCart,
  deltaSeconds: number
): number {
  return path.resolveDistance(
    cart.distance + cart.speed * deltaSeconds,
    cart.endOfPathInstruction
  );
}

/**
 * Pure random-access sample: evaluates the cart's frame at an arbitrary
 * distance (defaults to cart.distance). Same inputs always yield the same
 * frame, which is what timeline scrubbing relies on.
 */
export function sampleCartFrame(
  path: VertexPath,
  cart: PathCart,
  atDistance?: number
): CartFrame {
  const distance = path.resolveDistance(atDistance ?? cart.distance, cart.endOfPathInstruction);
  const time = path.length > 0 ? distance / path.length : 0;

  const railPosition = path.getPointAtDistance(distance, cart.endOfPathInstruction);
  const basis = resolveOrientationBasis(path, cart, distance);

  const offset = cart.positionOffset;
  const position = vec3.add(
    railPosition,
    vec3.add(
      vec3.add(vec3.scale(basis.right, offset.x), vec3.scale(basis.up, offset.y)),
      vec3.scale(basis.forward, offset.z)
    )
  );

  return {
    position,
    railPosition,
    forward: basis.forward,
    up: basis.up,
    right: basis.right,
    distance,
    time
  };
}

/** Sample by normalized path time (0..1) instead of distance. */
export function sampleCartFrameAtTime(path: VertexPath, cart: PathCart, t: number): CartFrame {
  return sampleCartFrame(path, cart, t * path.length);
}

export function serializePathCart(cart: PathCart, pathId: string): SerializedPathCart {
  return {
    pathId,
    distance: cart.distance,
    speed: cart.speed,
    endOfPathInstruction: cart.endOfPathInstruction,
    orientationMode: cart.orientationMode,
    positionOffset: vec3.clone(cart.positionOffset)
  };
}

export function deserializePathCart(serialized: SerializedPathCart): PathCart {
  const { pathId: _pathId, ...cart } = serialized;
  return createPathCart(cart);
}

function resolveOrientationBasis(
  path: VertexPath,
  cart: PathCart,
  distance: number
): { forward: Vec3; up: Vec3; right: Vec3 } {
  if (cart.orientationMode === "fixed") {
    return {
      forward: vec3.create(0, 0, 1),
      up: vec3.create(0, 1, 0),
      right: vec3.create(1, 0, 0)
    };
  }

  const tangent = path.getDirectionAtDistance(distance, cart.endOfPathInstruction);

  if (cart.orientationMode === "path-yaw") {
    const worldUp = vec3.clone(path.up);
    const vertical = vec3.scale(worldUp, vec3.dot(tangent, worldUp));
    let flatForward = vec3.sub(tangent, vertical);
    if (vec3.sqrMagnitude(flatForward) < EPSILON) {
      flatForward = tangent;
    }
    return orthonormalBasis(flatForward, worldUp);
  }

  const normal = path.getNormalAtDistance(distance, cart.endOfPathInstruction);
  return orthonormalBasis(tangent, normal);
}

/**
 * Right-handed basis with forward as +Z, up as +Y, right as +X:
 * right = up x forward, up recomputed as forward x right.
 */
function orthonormalBasis(forwardRaw: Vec3, upRaw: Vec3): { forward: Vec3; up: Vec3; right: Vec3 } {
  const forward = vec3.normalize(forwardRaw);
  let right = vec3.cross(upRaw, forward);
  if (vec3.sqrMagnitude(right) < EPSILON) {
    const fallbackUp =
      Math.abs(forward.y) < 0.99 ? vec3.create(0, 1, 0) : vec3.create(0, 0, -1);
    right = vec3.cross(fallbackUp, forward);
  }
  right = vec3.normalize(right);
  const up = vec3.normalize(vec3.cross(forward, right));
  return { forward, up, right };
}
