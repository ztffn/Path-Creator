// Reading a timeline out of the scene document and writing edits back into it. This is the
// persistence seam: Pascal owns the document and its undo, `@huma/path-creator` owns evaluation,
// and neither knows about the other. Every write goes through `updateNode` with a NEW array,
// because Pascal's undo snapshot holds the nodes map by reference and an in-place edit silently
// corrupts the past state. Scope: document <-> Timeline, plus the clone remap.
import { useScene } from "@pascal-app/core";
import {
  BezierPath,
  createTimeline,
  deserializePathCart,
  VertexPath,
  type CameraBlockLensAnimation,
  type Easing,
  type PathCart,
  type Timeline,
  type VirtualCameraDefinition
} from "@huma/path-creator/core";
import { CART_KIND, SHOT_KIND, TIMELINE_KIND } from "./kinds";
import {
  migrateTrackPayload,
  remapTracksForClone,
  removeTrack,
  removeTracksForObject,
  TRACK_PAYLOAD_VERSION,
  upsertTrack,
  type PersistedTrack
} from "./tracks";
import {
  readCarts,
  readPaths,
  readPluginNode,
  readShots,
  updatePluginNodes,
  type Matrix4Like
} from "./scene-ops";

export interface StoredTimeline {
  id: string;
  name: string;
  durationSeconds: number;
  loop: boolean;
  autoplay: boolean;
  tracks: PersistedTrack[];
  /** The version the document actually carried, before migration. 0 means unversioned. */
  storedVersion: number;
}

/** The timeline node's own fields, migrated, without building a path-creator Timeline. */
export function readStoredTimeline(timelineId: string): StoredTimeline | null {
  const node = readPluginNode(timelineId);
  if (!node || node.type !== TIMELINE_KIND) return null;

  const { tracks, migratedFrom } = migrateTrackPayload(
    node.tracks,
    node.trackPayloadVersion as number | undefined
  );

  return {
    id: timelineId,
    name: (node.name as string | undefined) ?? timelineId,
    durationSeconds: (node.durationSeconds as number | undefined) ?? 0,
    loop: (node.loop as boolean | undefined) ?? false,
    autoplay: (node.autoplay as boolean | undefined) ?? false,
    tracks,
    storedVersion: migratedFrom
  };
}

/**
 * The scene's shot definitions, keyed by node id — which is what a camera block's `vcamId`
 * names, so the map and the blocks address shots the same way everything else in this system
 * addresses anything.
 */
export function readShotDefinitions(timelineId: string): Map<string, VirtualCameraDefinition> {
  return new Map(readShots(timelineId).map((shot) => [shot.id, shot.definition]));
}

/**
 * The shots of one timeline as resolved BLOCKS: sorted, each with the span it owns and the blend
 * it inherits from overlapping its predecessor.
 *
 * This is the one place the span rule lives, so nothing else has to know it:
 *
 * - An authored `endSeconds` past the start is the block's end. Where that end reaches past the
 *   NEXT shot's start, the excess is the crossover — the overlap *is* the blend, which is how
 *   `@huma/path-creator`'s own demo authors it and why the thing you drag is the thing that
 *   shapes the hand-off.
 * - `end <= start` reads as unset, and the legacy layout is reconstructed: blocks abut, and the
 *   NEXT shot's old `blendSeconds` becomes the overlap that produces the same crossover it used
 *   to describe. So a document written before spans existed plays back identically, and loading
 *   it does not rewrite it.
 * - The last shot runs to the timeline's duration unless it says otherwise. `gapMode` defaults to
 *   `hold`, so an end short of the next shot is a visual statement rather than a release.
 */
export interface ShotBlock {
  id: string;
  name: string;
  start: number;
  end: number;
  /** Seconds of overlap with the previous block — the blend's duration. 0 is a cut. */
  blendSeconds: number;
  blendCurve: Easing;
  lensAnimation?: CameraBlockLensAnimation;
}

export function readShotBlocks(timelineId: string, duration: number): ShotBlock[] {
  const shots = [...readShots(timelineId)].sort((a, b) => a.time - b.time);

  const ends = shots.map((shot, index) => {
    if (shot.end > shot.time) return shot.end;
    // Legacy: abut the next shot, extended by ITS old blend so the crossover survives as overlap.
    const next = shots[index + 1];
    if (!next) return Math.max(duration, shot.time);
    return next.time + next.legacyBlendSeconds;
  });

  return shots.map((shot, index) => {
    const previousEnd = index > 0 ? ends[index - 1]! : shot.time;
    const overlap = Math.max(0, Math.min(previousEnd - shot.time, ends[index]! - shot.time));
    return {
      id: shot.id,
      name: shot.name,
      start: shot.time,
      end: ends[index]!,
      blendSeconds: overlap,
      blendCurve: shot.blendCurve,
      ...(shot.lensAnimation ? { lensAnimation: shot.lensAnimation } : {})
    };
  });
}

/**
 * A camera track built from the shot nodes' own spans.
 *
 * This is the compatibility path for a document with no authored camera track, and it runs at
 * READ time rather than rewriting the document. That is deliberate: a load should not mutate what
 * it loaded, and a synthesised track costs nothing to recompute. An explicit camera track in the
 * payload always wins.
 */
export function synthesiseCameraTrack(timelineId: string, duration: number): PersistedTrack | null {
  const blocks = readShotBlocks(timelineId, duration);
  if (blocks.length === 0) return null;

  return {
    type: "camera",
    id: `camera_${timelineId}`,
    blocks: blocks.map((block, index) => ({
      id: `block_${block.id}`,
      vcamId: block.id,
      start: block.start,
      end: block.end,
      // The first shot has nothing to blend FROM, so it never carries one however it overlaps.
      ...(block.blendSeconds > 0 && index > 0
        ? { blendIn: { durationSeconds: block.blendSeconds, curve: block.blendCurve } }
        : {}),
      // A FOV push is block-local (the evaluator samples it on the block's own window), which is
      // why it belongs here rather than on the resolved definition: two blocks naming the same
      // shot can push differently, and the blend between them interpolates both lenses.
      ...(block.lensAnimation ? { lensAnimation: block.lensAnimation } : {})
    }))
  };
}

/**
 * The scene's timeline, as the thing `@huma/path-creator` evaluates.
 *
 * `createTimeline` stamps the library's own schema version, so the returned object is a genuine
 * Timeline rather than a lookalike — which matters because the driver, the evaluators and the
 * migration path all key off that version.
 */
export function readTimeline(timelineId: string): Timeline | null {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return null;

  // An authored camera track wins; otherwise synthesise one from the shot nodes so a document
  // written before camera tracks existed still plays back its shots.
  const tracks = [...stored.tracks];
  if (!tracks.some((track) => track.type === "camera")) {
    const synthesised = synthesiseCameraTrack(timelineId, stored.durationSeconds);
    if (synthesised) tracks.push(synthesised);
  }

  return createTimeline({
    duration: stored.durationSeconds,
    tracks: tracks as Timeline["tracks"]
  });
}

/**
 * Persist a track list. One `updateNode` call, so one undo entry — Pascal's history is granular
 * over operations, not over nodes or fields, so batching is the only lever on undo shape.
 *
 * Writing the version alongside is what makes a document self-describing. Without it the next
 * schema change has to guess what it is reading, which is exactly the position elastiq's decks
 * are in today.
 */
export function writeTracks(timelineId: string, tracks: readonly PersistedTrack[]): void {
  useScene.getState().updateNode(timelineId as never, {
    tracks: [...tracks],
    trackPayloadVersion: TRACK_PAYLOAD_VERSION
  } as never);
}

/** Add or replace one track. Reads, edits purely, writes once. */
export function putTrack(timelineId: string, track: PersistedTrack): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  writeTracks(timelineId, upsertTrack(stored.tracks, track));
}

/** Delete one track by id. */
export function deleteTrack(timelineId: string, trackId: string): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  writeTracks(timelineId, removeTrack(stored.tracks, trackId));
}

/**
 * Drop every track bound to a node. A host calls this when a node is deleted for good — NOT on
 * an ordinary delete, because Pascal's undo restores the node and the tracks should come back
 * with it. The time layer tolerates a track pointing at a missing node (it skips), so leaving
 * them is safe; this exists for a deliberate purge.
 */
export function dropTracksForObject(timelineId: string, objectId: string): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  writeTracks(timelineId, removeTracksForObject(stored.tracks, objectId));
}

/**
 * The clone remap, decided 2026-08-17. Pascal's `cloneNodesInto` mints fresh ids by design;
 * a timeline reference cannot survive that, so duplicating an animated object would otherwise
 * produce an inert copy. Every track bound to a node inside the cloned subtree is duplicated
 * and rebound to the copy.
 *
 * `idMap` is original id -> clone id, which is what a clone reports. Call this immediately after
 * the clone, in the same gesture, so the two land as one undo entry from the author's side.
 */
/**
 * Rebind rail references inside a cloned subtree — R8's clone problem again, this time for node
 * DATA rather than for tracks.
 *
 * A duplicated cart must ride the duplicated rail, and a duplicated cart-bodied shot must ride
 * the duplicated cart. But only when the referenced node was cloned TOO: duplicating a cart alone
 * means a second cart on the same rail, which is a reasonable thing to author and must not be
 * rewritten. So the rule is exactly "if the target is in the id map, follow it".
 *
 * One `updateNodes` call, so the clone and the rebind land as a single Ctrl+Z step from the
 * author's side. Returns the number of nodes rebound, which is what a test asserts on.
 */
export function remapRailsAfterClone(idMap: ReadonlyMap<string, string>): number {
  const nodes = useScene.getState().nodes as Record<string, Record<string, unknown>>;
  const updates: { id: string; data: Record<string, unknown> }[] = [];

  for (const cloneId of idMap.values()) {
    const node = nodes[cloneId];
    if (!node) continue;

    if (node.type === CART_KIND) {
      const clonedPath = idMap.get((node.pathId as string | undefined) ?? "");
      if (clonedPath) updates.push({ id: cloneId, data: { pathId: clonedPath } });
      continue;
    }
    if (node.type === SHOT_KIND && node.body === "cart") {
      const clonedCart = idMap.get((node.cartId as string | undefined) ?? "");
      if (clonedCart) updates.push({ id: cloneId, data: { cartId: clonedCart } });
    }
  }

  if (updates.length > 0) updatePluginNodes(updates);
  return updates.length;
}

export function remapTracksAfterClone(
  timelineId: string,
  idMap: ReadonlyMap<string, string>
): void {
  const stored = readStoredTimeline(timelineId);
  if (!stored) return;
  const next = remapTracksForClone(
    stored.tracks,
    idMap,
    (trackId, cloneObjectId) => `${trackId}__${cloneObjectId}`
  );
  if (next.length !== stored.tracks.length) writeTracks(timelineId, next);
}

// ---------------------------------------------------------------- the rig (M1.7)

/**
 * The rig half of the library's evaluation context: the vertex paths distance is measured along,
 * the carts that ride them, and which path each cart is on. Exactly
 * `Pick<RigRuntime, "paths" | "carts" | "cartPaths">`, so it drops straight into
 * `TimelineRigContext` — the plugin builds the library's own runtime shape rather than a
 * lookalike, which is what lets `evaluateTimeline` position carts with no adapter.
 */
export interface PascalRig {
  paths: Map<string, VertexPath>;
  carts: Map<string, PathCart>;
  cartPaths: Map<string, string>;
}

/** An empty rig — what a scene with no rails evaluates against. */
export function emptyRig(): PascalRig {
  return { paths: new Map(), carts: new Map(), cartPaths: new Map() };
}

/**
 * Build the rig from the scene document's path and cart nodes.
 *
 * Deliberately TOLERANT where `buildRigRuntime` throws. The library's builder rejects a cart
 * naming an unknown path, which is right for a finished rig document loaded whole — but here the
 * document is being authored, and a cart exists for a moment before its path is chosen, and a
 * path can be deleted while a cart still names it. Throwing would take the whole viewer down
 * mid-edit. Such a cart is skipped instead: the library then resolves no frame for it, and a
 * cart-bodied shot resolves to nothing, which is already a state the director handles by writing
 * nothing at all.
 *
 * A path with fewer than two anchors is skipped for the same reason — `BezierPath` needs a
 * segment before it can be sampled, and an author's first click has only one point.
 */
export function readRig(resolveWorldMatrix?: (id: string) => Matrix4Like | null): PascalRig {
  const rig = emptyRig();

  for (const path of readPaths(resolveWorldMatrix)) {
    // 4 points is one cubic segment; anything less has no curve to sample.
    if (path.definition.bezier.points.length < 4) continue;
    try {
      const bezier = BezierPath.fromJSON(path.definition.bezier);
      rig.paths.set(path.id, new VertexPath(bezier, path.definition.sampling));
    } catch {
      // A malformed path is one the author is mid-way through drawing, not an error to report.
      continue;
    }
  }

  for (const cart of readCarts()) {
    if (!rig.paths.has(cart.definition.pathId)) continue;
    rig.carts.set(cart.id, deserializePathCart(cart.definition));
    rig.cartPaths.set(cart.id, cart.definition.pathId);
  }

  return rig;
}
