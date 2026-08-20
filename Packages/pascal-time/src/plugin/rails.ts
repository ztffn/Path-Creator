// Authoring operations for rails: starting a path, extending it, and starting a dolly run on a
// cart. The point-list arithmetic is PURE and exported separately from the writes, because a
// bezier point list is an array inside node data and Pascal's undo snapshot aliases it — an
// in-place push would corrupt the past state and undo could not restore it. Every write here is
// one store operation, so every gesture is one undo entry.
import { bezierAnchorCount } from "@huma/path-creator/core";
import type { PersistedTrack } from "./tracks";

type CartTrack = Extract<PersistedTrack, { type: "cart" }>;

export interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** How many points a bezier's interleaved list holds per added anchor. */
const POINTS_PER_ANCHOR = 3;

/**
 * A two-anchor starter rail centred on `origin` and laid out along `forward`, with its control
 * points already placed at the thirds so the segment is straight.
 *
 * A starter with a real segment matters: a one-point path has no curve, cannot be sampled, and is
 * skipped by the rig builder — so an author who created a path and saw nothing would have no way
 * to tell "not drawn yet" from "broken".
 */
export function starterRailPoints(origin: Point3, forward: Point3, length = 8): Point3[] {
  const magnitude = Math.hypot(forward.x, forward.y, forward.z);
  const unit =
    magnitude > 1e-6
      ? { x: forward.x / magnitude, y: forward.y / magnitude, z: forward.z / magnitude }
      : { x: 1, y: 0, z: 0 };
  const half = length / 2;
  const at = (t: number): Point3 => ({
    x: origin.x + unit.x * t,
    y: origin.y + unit.y * t,
    z: origin.z + unit.z * t
  });
  return [at(-half), at(-half / 3), at(half / 3), at(half)];
}

/**
 * The point list with one anchor appended, its two control points placed to continue the rail's
 * existing direction. Returns a NEW array.
 *
 * The incoming control of the new anchor mirrors the outgoing control of the last one, which is
 * what keeps the join smooth — the same thing `BezierPath.addSegmentToEnd` does, reproduced here
 * because this operates on plain node data rather than on a live path object.
 */
export function withAppendedAnchor(points: readonly Point3[], target: Point3): Point3[] {
  if (points.length < 4) return [...points];
  const lastAnchor = points[points.length - 1]!;
  const lastControl = points[points.length - 2]!;
  // Reflect the previous outgoing control through the anchor: a C1-continuous join.
  const mirrored: Point3 = {
    x: lastAnchor.x * 2 - lastControl.x,
    y: lastAnchor.y * 2 - lastControl.y,
    z: lastAnchor.z * 2 - lastControl.z
  };
  const incoming: Point3 = {
    x: (mirrored.x + target.x) / 2,
    y: (mirrored.y + target.y) / 2,
    z: (mirrored.z + target.z) / 2
  };
  return [...points, mirrored, incoming, { ...target }];
}

/**
 * The point list with anchor `anchorIndex` removed, along with the two control points that belong
 * to it. Returns a NEW array; a rail already down to two anchors is returned unchanged, because
 * one anchor is not a rail.
 *
 * The list interleaves `a0 c0 c1 a1 c2 c3 a2 …`, so anchor `i` sits at `3i` and removing one
 * always drops three points — but WHICH three depends on where it is: the first anchor takes the
 * two controls after it, the last takes the two before it, and an interior one takes a control
 * from either side. Getting this wrong leaves a list whose length still parses and whose curve is
 * subtly re-associated, which is the kind of wrong that looks like a rendering bug.
 */
export function withoutAnchor(points: readonly Point3[], anchorIndex: number): Point3[] {
  const anchors = bezierAnchorCount(points.length, false);
  if (anchors <= 2 || anchorIndex < 0 || anchorIndex >= anchors) return [...points];

  const pointIndex = anchorIndex * POINTS_PER_ANCHOR;
  const from =
    anchorIndex === 0 ? 0 : anchorIndex === anchors - 1 ? pointIndex - 2 : pointIndex - 1;
  return [...points.slice(0, from), ...points.slice(from + POINTS_PER_ANCHOR)];
}

/** The world position of anchor `anchorIndex`, or null when there is no such anchor. */
export function anchorAt(points: readonly Point3[], anchorIndex: number): Point3 | null {
  return points[anchorIndex * POINTS_PER_ANCHOR] ?? null;
}

/** How many anchors a path node's point list holds. */
export const anchorCount = (points: readonly Point3[], isClosed = false): number =>
  bezierAnchorCount(points.length, isClosed);

/**
 * A fresh dolly run: the cart rides the whole rail, starting at `startSeconds` and taking
 * `durationSeconds`.
 *
 * The easing goes on the FIRST key, and that is not interchangeable. A cart key's easing shapes
 * the segment AFTER it (`CartKey.easing`: "interpolation from this key to the next"), which is the
 * opposite of `TransformKey.easing`, and putting a curve on the wrong key is not an error — it is
 * a run that quietly stays linear. Covered by a control in the spec.
 */
export function newDollyRun(
  cartId: string,
  railLength: number,
  startSeconds: number,
  durationSeconds = 4,
  easing: CartTrack["keys"][number]["easing"] = "easeInOut"
): CartTrack {
  const start = Math.max(0, startSeconds);
  return {
    type: "cart",
    id: `cart_${cartId}`,
    cartId,
    keys: [
      { time: start, distance: 0, ...(easing ? { easing } : {}) },
      { time: start + Math.max(0.1, durationSeconds), distance: railLength }
    ]
  };
}

/** The easing that shapes a run — the first key's, per the asymmetry above. */
export const dollyRunEasing = (track: CartTrack): CartTrack["keys"][number]["easing"] =>
  track.keys[0]?.easing ?? "linear";

/** The run with a new profile, written to the key that actually shapes it. Returns a new track. */
export function withDollyRunEasing(
  track: CartTrack,
  easing: NonNullable<CartTrack["keys"][number]["easing"]>
): CartTrack {
  if (track.keys.length === 0) return track;
  return {
    ...track,
    keys: track.keys.map((key, index) => (index === 0 ? { ...key, easing } : key))
  };
}
