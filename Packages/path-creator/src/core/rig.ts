// Rig document: the versioned, persistable description of a motion rig —
// bezier paths, the carts that ride them, virtual camera definitions,
// declared tracking targets, and timelines, all referenced by id. This is
// the serialization contract shared by editors (demo, twin authoring,
// elastiq) and runtimes (timeline playback). Purely data; no engine deps.
import { BezierPath, type SerializedBezierPath } from "./bezier-path";
import { deserializePathCart, serializePathCart, type PathCart, type SerializedPathCart } from "./cart";
import type { TrackingTargetDefinition } from "./targets";
import type { Timeline } from "./timeline";
import { VertexPath, type VertexPathFromBezierOptions } from "./vertex-path";
import type { VirtualCameraDefinition } from "./virtual-camera";

export const RIG_SCHEMA_VERSION = 2;

export interface RigPathDefinition {
  id: string;
  name?: string;
  bezier: SerializedBezierPath;
  sampling?: VertexPathFromBezierOptions;
}

export interface RigCartDefinition extends SerializedPathCart {
  id: string;
  name?: string;
}

export interface RigTimelineDefinition extends Timeline {
  id: string;
  name?: string;
}

export interface RigDocument {
  schemaVersion: number;
  paths: RigPathDefinition[];
  carts: RigCartDefinition[];
  /** v2: virtual camera definitions referenced by timeline blocks. */
  vcams?: VirtualCameraDefinition[];
  /** v2: declared targets (points, carts, groups); object targets register at runtime. */
  targets?: TrackingTargetDefinition[];
  /** v2: timelines referencing vcams/carts/targets by id. */
  timelines?: RigTimelineDefinition[];
}

/** Runtime instances built from a rig document, keyed by id. */
export interface RigRuntime {
  paths: Map<string, VertexPath>;
  carts: Map<string, PathCart>;
  /** Cart id -> path id, for resolving which path a cart samples. */
  cartPaths: Map<string, string>;
  vcams: Map<string, VirtualCameraDefinition>;
  targets: Map<string, TrackingTargetDefinition>;
  timelines: Map<string, RigTimelineDefinition>;
}

export function createRigDocument(
  init: Partial<Omit<RigDocument, "schemaVersion">> = {}
): RigDocument {
  return {
    schemaVersion: RIG_SCHEMA_VERSION,
    paths: init.paths ?? [],
    carts: init.carts ?? [],
    ...(init.vcams && { vcams: init.vcams }),
    ...(init.targets && { targets: init.targets }),
    ...(init.timelines && { timelines: init.timelines })
  };
}

export function serializeRigPath(
  id: string,
  path: BezierPath,
  options: { name?: string; sampling?: VertexPathFromBezierOptions } = {}
): RigPathDefinition {
  const definition: RigPathDefinition = { id, bezier: path.toJSON() };
  if (options.name !== undefined) definition.name = options.name;
  if (options.sampling !== undefined) definition.sampling = options.sampling;
  return definition;
}

export function serializeRigCart(
  id: string,
  cart: PathCart,
  pathId: string,
  options: { name?: string } = {}
): RigCartDefinition {
  const definition: RigCartDefinition = { id, ...serializePathCart(cart, pathId) };
  if (options.name !== undefined) definition.name = options.name;
  return definition;
}

/**
 * Instantiates runtime instances from a document. Accepts v1 (paths + carts
 * only) and v2 documents; throws on newer versions and on dangling id
 * references — a corrupt authored document is not a recoverable state.
 */
export function buildRigRuntime(document: RigDocument): RigRuntime {
  if (document.schemaVersion < 1 || document.schemaVersion > RIG_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported rig schema version ${String(document.schemaVersion)}; expected 1..${RIG_SCHEMA_VERSION}`
    );
  }

  const paths = new Map<string, VertexPath>();
  for (const pathDef of document.paths) {
    const bezier = BezierPath.fromJSON(pathDef.bezier);
    paths.set(pathDef.id, new VertexPath(bezier, pathDef.sampling));
  }

  const carts = new Map<string, PathCart>();
  const cartPaths = new Map<string, string>();
  for (const cartDef of document.carts) {
    if (!paths.has(cartDef.pathId)) {
      throw new Error(`Rig cart "${cartDef.id}" references unknown path "${cartDef.pathId}"`);
    }
    carts.set(cartDef.id, deserializePathCart(cartDef));
    cartPaths.set(cartDef.id, cartDef.pathId);
  }

  const vcams = new Map<string, VirtualCameraDefinition>();
  for (const vcam of document.vcams ?? []) {
    if (vcam.body.type === "cart" && !carts.has(vcam.body.cartId)) {
      throw new Error(`Rig vcam "${vcam.id}" references unknown cart "${vcam.body.cartId}"`);
    }
    vcams.set(vcam.id, vcam);
  }

  const targets = new Map<string, TrackingTargetDefinition>();
  for (const target of document.targets ?? []) {
    if (target.type === "cart" && !carts.has(target.cartId)) {
      throw new Error(`Rig target "${target.id}" references unknown cart "${target.cartId}"`);
    }
    targets.set(target.id, target);
  }

  const timelines = new Map<string, RigTimelineDefinition>();
  for (const timeline of document.timelines ?? []) {
    for (const track of timeline.tracks) {
      if (track.type === "camera") {
        for (const block of track.blocks) {
          if (!vcams.has(block.vcamId)) {
            throw new Error(
              `Timeline "${timeline.id}" block "${block.id}" references unknown vcam "${block.vcamId}"`
            );
          }
        }
      } else if (track.type === "cart" && !carts.has(track.cartId)) {
        throw new Error(
          `Timeline "${timeline.id}" cart track "${track.id}" references unknown cart "${track.cartId}"`
        );
      }
    }
    timelines.set(timeline.id, timeline);
  }

  return { paths, carts, cartPaths, vcams, targets, timelines };
}
