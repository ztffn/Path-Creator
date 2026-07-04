// Rig document: the versioned, persistable description of a motion rig —
// named bezier paths plus the carts that ride them, referenced by id. This is
// the serialization contract shared by editors (demo, twin authoring, elastiq)
// and runtimes (timeline playback); virtual camera definitions attach to carts
// by id in a later schema revision. Purely data; no engine dependencies.
import { BezierPath, type SerializedBezierPath } from "./bezier-path";
import { deserializePathCart, serializePathCart, type PathCart, type SerializedPathCart } from "./cart";
import { VertexPath, type VertexPathFromBezierOptions } from "./vertex-path";

export const RIG_SCHEMA_VERSION = 1;

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

export interface RigDocument {
  schemaVersion: typeof RIG_SCHEMA_VERSION;
  paths: RigPathDefinition[];
  carts: RigCartDefinition[];
}

/** Runtime instances built from a rig document, keyed by id. */
export interface RigRuntime {
  paths: Map<string, VertexPath>;
  carts: Map<string, PathCart>;
  /** Cart id -> path id, for resolving which path a cart samples. */
  cartPaths: Map<string, string>;
}

export function createRigDocument(
  init: Partial<Omit<RigDocument, "schemaVersion">> = {}
): RigDocument {
  return {
    schemaVersion: RIG_SCHEMA_VERSION,
    paths: init.paths ?? [],
    carts: init.carts ?? []
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
 * Instantiates VertexPaths and PathCarts from a document. Throws on unknown
 * schema versions and on carts referencing missing paths — a rig document
 * with dangling references is authored-data corruption, not a runtime state.
 */
export function buildRigRuntime(document: RigDocument): RigRuntime {
  if (document.schemaVersion !== RIG_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported rig schema version ${String(document.schemaVersion)}; expected ${RIG_SCHEMA_VERSION}`
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

  return { paths, carts, cartPaths };
}
