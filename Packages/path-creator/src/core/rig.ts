// Rig document: the versioned, persistable description of a motion rig —
// bezier paths, the carts that ride them, virtual camera definitions,
// declared tracking targets, and timelines, all referenced by id. This is
// the serialization contract shared by editors (demo, twin authoring,
// elastiq) and runtimes (timeline playback). Purely data; no engine deps.
import { BezierPath, type SerializedBezierPath } from "./bezier-path";
import { deserializePathCart, serializePathCart, type PathCart, type SerializedPathCart } from "./cart";
import type { TrackingTargetDefinition } from "./targets";
import type { ActionDefinition, TriggerBinding, TriggerDefinition } from "./triggers";
import { normalizeTimelineEasing, sortTimelineTracks, TIMELINE_SCHEMA_VERSION, type Timeline } from "./timeline";
import { VertexPath, type VertexPathFromBezierOptions } from "./vertex-path";
import type { VirtualCameraDefinition } from "./virtual-camera";

// v4: embedded timeline v4 adds portable activation/audio/animation/transform tracks.
// v5: embedded timeline v5 adds per-axis easing (TransformKey.easingAxes).
// v6: embedded timeline v6 adds per-axis bezier tangents (TransformKey.tangentsAxes).
// v7: `timelines` is a Story of Scenes — `entrySceneId` designates the entry/master
//     scene; legacy single-timeline documents migrate as scene[0] = entry.
// v8: embedded timeline v7 adds scene tracks (deterministic master-embed of scenes).
// v9: document-level triggers/actions/bindings (reactive interaction layer).
// v10: embedded timeline v8 adds SceneClip.blendSeconds (embed boundary blends).
// v11: embedded timeline v9 adds AudioClip.rate / AudioClip.stretch (per-clip source speed).
// v12: embedded timeline v10 adds TransformTrack.additive (offset over baked animation).
// Older documents migrate by version stamp because the new fields are additive/optional.
export const RIG_SCHEMA_VERSION = 12;

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
  /** v2: timelines referencing vcams/carts/targets by id. v7: each timeline is a
   *  Scene of the document's Story; order is the Story's authored order. */
  timelines?: RigTimelineDefinition[];
  /** v7: the Story's entry/master scene (an id in `timelines`). Omitted on
   *  pre-Story documents; resolution falls back to the first timeline. */
  entrySceneId?: string;
  /** v9: reactive interaction layer — triggers (source + arm policy), actions
   *  (verbs), and the bindings joining them. Present-mode only; the pure
   *  evaluators never see these. */
  triggers?: TriggerDefinition[];
  actions?: ActionDefinition[];
  triggerBindings?: TriggerBinding[];
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
    ...(init.timelines && { timelines: init.timelines }),
    ...(init.entrySceneId !== undefined && { entrySceneId: init.entrySceneId }),
    ...(init.triggers && { triggers: init.triggers }),
    ...(init.actions && { actions: init.actions }),
    ...(init.triggerBindings && { triggerBindings: init.triggerBindings })
  };
}

/** Serializes a rig document to JSON — the portable scene file. */
export function serializeRigDocument(document: RigDocument): string {
  return JSON.stringify(document);
}

/**
 * Parses a rig document from JSON, validating the schema version (and leaving a
 * hook for migrating older versions). Cross-reference validation — dangling
 * cart/vcam/target ids — happens in buildRigRuntime, not here.
 */
export function parseRigDocument(json: string): RigDocument {
  const parsed = JSON.parse(json) as RigDocument;
  if (typeof parsed?.schemaVersion !== "number") {
    throw new Error("Invalid rig document: missing schemaVersion");
  }
  if (parsed.schemaVersion < 1 || parsed.schemaVersion > RIG_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported rig schema version ${String(parsed.schemaVersion)}; expected 1..${RIG_SCHEMA_VERSION}`
    );
  }
  const migrated = migrateRigDocument(parsed);
  // Coerce persisted easing values to valid Easings at the boundary, so a malformed or
  // foreign document can't reach the evaluator with a bad easing (all versions, not just
  // migrated ones).
  return migrated.timelines
    ? { ...migrated, timelines: migrated.timelines.map(normalizeTimelineEasing) }
    : migrated;
}

/**
 * Upgrades an older document to the current schema. Future structural migrations
 * branch on `document.schemaVersion` here. The v1/v2 -> v3 step needs no per-field
 * transform: string easing is a valid subset of the v2 easing union, so we only
 * re-stamp the version numbers. v7 wraps the legacy timeline list as the Story:
 * the first timeline becomes the entry scene.
 */
function migrateRigDocument(document: RigDocument): RigDocument {
  if (document.schemaVersion >= RIG_SCHEMA_VERSION) return document;
  const entryId = document.entrySceneId ?? document.timelines?.[0]?.id;
  return {
    ...document,
    schemaVersion: RIG_SCHEMA_VERSION,
    ...(document.timelines && {
      timelines: document.timelines.map((timeline) => ({
        ...timeline,
        schemaVersion: TIMELINE_SCHEMA_VERSION
      }))
    }),
    ...(entryId !== undefined && { entrySceneId: entryId })
  };
}

/** All scenes of the document's Story, in authored order (empty when none). */
export function listScenes(document: RigDocument): RigTimelineDefinition[] {
  return document.timelines ?? [];
}

/** The scene with this id, or null. */
export function getScene(document: RigDocument, sceneId: string): RigTimelineDefinition | null {
  return document.timelines?.find((timeline) => timeline.id === sceneId) ?? null;
}

/** The Story's entry/master scene: `entrySceneId` when set, else the first scene. */
export function getEntryScene(document: RigDocument): RigTimelineDefinition | null {
  if (document.entrySceneId !== undefined) return getScene(document, document.entrySceneId);
  return document.timelines?.[0] ?? null;
}

/** A scene's playable length in seconds. */
export function sceneDuration(scene: Timeline): number {
  return scene.duration;
}

/**
 * Whether this scene takes the camera when invoked: it owns a camera iff it has
 * a camera track with at least one block — composition, not a flag. A scene
 * without one plays its other tracks while the host keeps the camera.
 */
export function sceneOwnsCamera(scene: Timeline): boolean {
  return scene.tracks.some((track) => track.type === "camera" && track.blocks.length > 0);
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
    // A track aim's target ref is resolved through the runtime target registry,
    // which may hold objects not declared in the document, so it is
    // intentionally not cross-checked here.
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
  const sceneIds = new Set((document.timelines ?? []).map((timeline) => timeline.id));
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
      } else if (track.type === "scene") {
        for (const clip of track.clips) {
          if (!sceneIds.has(clip.sceneId)) {
            throw new Error(
              `Timeline "${timeline.id}" scene clip "${clip.id}" references unknown scene "${clip.sceneId}"`
            );
          }
        }
      }
    }
    // Establishes the sorted-tracks invariant the evaluator relies on, since
    // documents arrive from JSON in author order.
    timelines.set(timeline.id, { ...timeline, tracks: sortTimelineTracks(timeline.tracks) });
  }

  return { paths, carts, cartPaths, vcams, targets, timelines };
}
