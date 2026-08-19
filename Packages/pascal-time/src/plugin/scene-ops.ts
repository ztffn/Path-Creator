// The scene-store boundary, cast once so nobody else has to. Pascal types its store against
// `AnyNode` — a closed union of its 46 built-in schemas — and `AnyNodeId`, a template-literal
// union of `${builtinKind}_${string}`. A third-party kind is in neither, so every store call
// from a plugin is a type error even though the runtime accepts it happily. These wrappers hold
// the cast, explain it, and mint ids in the shape Pascal's own kinds use.
import { generateId, nodeRegistry, useScene } from "@pascal-app/core";
import type { Cue } from "@huma/path-creator/timeline";
import type {
  CameraBlockLensAnimation,
  ComposerSettings,
  Easing,
  VirtualCameraAimDefinition,
  VirtualCameraDefinition,
  VirtualCameraNoiseSettings
} from "@huma/path-creator/core";
import { CUE_KIND, SHOT_KIND, TIMELINE_KIND } from "./kinds";

/**
 * `BaseNode.id` is a plain `z.string()` at runtime — Pascal's own schema file says so, with a
 * comment explaining that a narrower type breaks `.extend()` for downstream kinds. The narrow
 * `AnyNodeId` union is therefore a compile-time artefact of the built-in schemas, not a runtime
 * constraint, which is why casting here is safe rather than merely convenient.
 *
 * Worth upstreaming: widening the store's id parameter to `string`, or making it generic over
 * registered kinds, would remove this shim for every plugin author rather than just for us.
 */
type SceneNodeInput = { id: string; type: string; parentId?: string | null } & Record<
  string,
  unknown
>;

/** Prefix for ids this plugin mints. Namespaced so it can never collide with a Pascal kind. */
const ID_PREFIX = "humatime";

/**
 * A fresh node id, in Pascal's own `<prefix>_<nanoid>` shape. Ids are a contract: stable across
 * save, load and export, referenced by timelines that cannot repair them, and never derived
 * from a name, an index or a position.
 */
export const newPascalTimeNodeId = (): string => generateId(ID_PREFIX);

/** Create a node of one of this plugin's kinds. */
export function createPluginNode(node: SceneNodeInput, parentId?: string): void {
  useScene.getState().createNode(node as never, parentId as never);
}

/** Delete a node by id. */
export function deletePluginNode(id: string): void {
  useScene.getState().deleteNode(id as never);
}

/** Read a node by id, or undefined when the scene no longer has it. */
export function readPluginNode(id: string): Record<string, unknown> | undefined {
  return (useScene.getState().nodes as Record<string, Record<string, unknown>>)[id];
}

/**
 * Patch a node's data. One `updateNode`, so one undo entry — batch a gesture's fields into a
 * single call rather than writing per field. Any array or object in the patch must be a NEW
 * value, never a mutation of what `readPluginNode` returned (the undo snapshot aliases it).
 */
export function updatePluginNode(id: string, patch: Record<string, unknown>): void {
  useScene.getState().updateNode(id as never, patch as never);
}

/**
 * Patch several nodes as ONE store operation, so one undo entry. Pascal's undo is granular
 * over operations, not nodes — a gesture that retimes two shots (dragging the cut between
 * them) must land as a single Ctrl+Z step, and `updateNodes` is the only lever for that.
 */
export function updatePluginNodes(
  updates: readonly { id: string; data: Record<string, unknown> }[]
): void {
  if (updates.length === 0) return;
  useScene.getState().updateNodes(updates as never);
}

/**
 * A timeline node with this plugin's defaults, ready to hand to `createPluginNode`. Reads the
 * registered definition rather than duplicating its defaults, so the two cannot drift.
 */
export function buildTimelineNode(
  overrides: Record<string, unknown> & { id?: string } = {}
): SceneNodeInput {
  const definition = nodeRegistry.get(TIMELINE_KIND);
  if (!definition) {
    throw new Error(
      `[pascal-time] ${TIMELINE_KIND} is not registered — call registerPascalTimeKinds() at module import time`
    );
  }
  return {
    ...definition.defaults(),
    id: overrides.id ?? newPascalTimeNodeId(),
    type: TIMELINE_KIND,
    ...overrides
  } as SceneNodeInput;
}

/**
 * A cue node with this plugin's defaults. `parentId` should be the timeline whose clock
 * `timeSeconds` is measured on — nothing enforces it, but a cue parented elsewhere is a cue
 * measured against a clock nobody can identify.
 */
export function buildCueNode(
  overrides: Record<string, unknown> & { id?: string } = {}
): SceneNodeInput {
  const definition = nodeRegistry.get(CUE_KIND);
  if (!definition) {
    throw new Error(
      `[pascal-time] ${CUE_KIND} is not registered — call registerPascalTimeKinds() at module import time`
    );
  }
  return {
    ...definition.defaults(),
    id: overrides.id ?? newPascalTimeNodeId(),
    type: CUE_KIND,
    ...overrides
  } as SceneNodeInput;
}

/**
 * The scene document's cues, as the plain data the timeline library's lookup and ride helpers
 * take. This is the seam in one function: Pascal owns creating, naming, retiming, deleting and
 * undoing cues, and the time layer only ever sees `{ id, name, time }`.
 *
 * The node id becomes the cue id, deliberately. Ids are a contract, Pascal mints them, and a
 * hotspot that navigates to a cue therefore stores a node id like every other reference in the
 * system rather than a second kind of identifier that would need its own stability rules.
 *
 * Pass `timelineId` to read only the cues belonging to one clock. Cues are returned in document
 * order; the library sorts by time itself, so ordering here would be a second source of truth.
 */
export function readCues(timelineId?: string): Cue[] {
  const nodes = useScene.getState().nodes as Record<string, Record<string, unknown>>;
  const cues: Cue[] = [];
  for (const node of Object.values(nodes)) {
    if (node.type !== CUE_KIND) continue;
    if (timelineId !== undefined && node.parentId !== timelineId) continue;
    cues.push({
      id: node.id as string,
      name: (node.name as string | undefined) ?? (node.id as string),
      time: (node.timeSeconds as number | undefined) ?? 0
    });
  }
  return cues;
}

/** A shot node with this plugin's defaults. */
export function buildShotNode(
  overrides: Record<string, unknown> & { id?: string } = {}
): SceneNodeInput {
  const definition = nodeRegistry.get(SHOT_KIND);
  if (!definition) {
    throw new Error(
      `[pascal-time] ${SHOT_KIND} is not registered — call registerPascalTimeKinds() at module import time`
    );
  }
  return {
    ...definition.defaults(),
    id: overrides.id ?? newPascalTimeNodeId(),
    type: SHOT_KIND,
    ...overrides
  } as SceneNodeInput;
}

/** A shot as the time layer sees it: a camera, when it takes over, and how long it takes. */
export interface Shot {
  id: string;
  name: string;
  time: number;
  blendSeconds: number;
  definition: VirtualCameraDefinition;
  /** Shape of the blend from the previous shot. Becomes the block's `blendIn.curve`. */
  blendCurve: Easing;
  /** Lens fields animating across the shot's window, or absent. Becomes `block.lensAnimation`. */
  lensAnimation?: CameraBlockLensAnimation;
}

const degToRad = (degrees: number): number => (degrees * Math.PI) / 180;

/**
 * Euler degrees to a quaternion, in three.js's default YXZ-free XYZ order. Written out rather
 * than pulled from three so this module stays free of a runtime three import — the package's
 * only three usage is in renderers, and keeping it that way means the document layer can be
 * read on a server.
 */
function quaternionFromEulerDeg(
  [x, y, z]: readonly [number, number, number]
): [number, number, number, number] {
  const [cx, cy, cz] = [Math.cos(degToRad(x) / 2), Math.cos(degToRad(y) / 2), Math.cos(degToRad(z) / 2)];
  const [sx, sy, sz] = [Math.sin(degToRad(x) / 2), Math.sin(degToRad(y) / 2), Math.sin(degToRad(z) / 2)];
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz
  ];
}

/**
 * The scene document's shots, as the time layer's camera definitions.
 *
 * The virtual camera's id is the node id — so a shot is addressed exactly like every other
 * node, and an orbit body that names `targetNodeId` is naming a node id too. That is the whole
 * seam: the camera frames a thing by identity, so moving the thing re-frames the shot with no
 * timeline edit at all.
 *
 * Returned in document order; the director sorts by time itself.
 */
export function readShots(timelineId?: string): Shot[] {
  const nodes = useScene.getState().nodes as Record<string, Record<string, unknown>>;
  const shots: Shot[] = [];

  for (const node of Object.values(nodes)) {
    if (node.type !== SHOT_KIND) continue;
    if (timelineId !== undefined && node.timelineId !== timelineId) continue;

    const id = node.id as string;
    const position = node.position as [number, number, number];
    const fov = node.fov as number;

    const body: VirtualCameraDefinition["body"] =
      node.body === "orbit"
        ? {
            type: "orbit",
            target:
              (node.targetNodeId as string)
                ? { targetId: node.targetNodeId as string }
                : vec3Of(node.targetPoint as [number, number, number]),
            azimuthDeg: node.azimuthDeg as number,
            elevationDeg: node.elevationDeg as number,
            radius: node.radius as number,
            binding: "world"
          }
        : {
            type: "static",
            position: vec3Of(position),
            quaternion: quatOf(quaternionFromEulerDeg(node.rotationDeg as [number, number, number]))
          };

    const noise = noiseOf(node);
    const lensAnimation = lensAnimationOf(node);

    shots.push({
      id,
      name: (node.name as string | undefined) ?? id,
      time: (node.timeSeconds as number | undefined) ?? 0,
      blendSeconds: (node.blendSeconds as number | undefined) ?? 0,
      blendCurve: (node.blendCurve as Easing | undefined) ?? "easeInOut",
      ...(lensAnimation && { lensAnimation }),
      definition: {
        id,
        body,
        aim: aimOf(node),
        lens: { fov },
        ...(noise && { noise })
      }
    });
  }

  return shots;
}

const vec3Of = ([x, y, z]: readonly [number, number, number]) => ({ x, y, z });

/**
 * The shot's aim. `body` keeps the body's own orientation. `track` watches a node (or a point),
 * and adding `settings` promotes it from an instant look-at to the damped composer — the library
 * distinguishes the two by exactly that presence, so this function is the whole switch.
 */
function aimOf(node: Record<string, unknown>): VirtualCameraAimDefinition {
  if (node.aimMode !== "track") return { type: "body" };
  const targetId = (node.aimTargetNodeId as string | undefined) ?? "";
  const target = targetId
    ? { targetId }
    : vec3Of((node.aimTargetPoint as [number, number, number] | undefined) ?? [0, 0, 0]);
  if (node.composerEnabled !== true) return { type: "track", target };
  return { type: "track", target, settings: composerSettingsOf(node) };
}

/** The flat ComposerSettings the library reads, from the node's flattened composer fields. */
function composerSettingsOf(node: Record<string, unknown>): ComposerSettings {
  const offset = (node.composerTargetOffset as [number, number, number] | undefined) ?? [0, 0, 0];
  return {
    screenX: (node.composerScreenX as number | undefined) ?? 0,
    screenY: (node.composerScreenY as number | undefined) ?? 0,
    deadWidth: (node.composerDeadWidth as number | undefined) ?? 0.18,
    deadHeight: (node.composerDeadHeight as number | undefined) ?? 0.14,
    softWidth: (node.composerSoftWidth as number | undefined) ?? 0.55,
    softHeight: (node.composerSoftHeight as number | undefined) ?? 0.45,
    dampingX: (node.composerDampingX as number | undefined) ?? 6,
    dampingY: (node.composerDampingY as number | undefined) ?? 8,
    targetOffsetX: offset[0],
    targetOffsetY: offset[1],
    targetOffsetZ: offset[2],
    lookaheadTime: (node.composerLookaheadTime as number | undefined) ?? 0.2,
    lookaheadSmoothing: (node.composerLookaheadSmoothing as number | undefined) ?? 8,
    lookaheadIgnoreY: (node.composerLookaheadIgnoreY as boolean | undefined) ?? false,
    centerOnActivate: (node.composerCenterOnActivate as boolean | undefined) ?? false
  };
}

/** Seeded wobble, or null when the shot has none. Per-axis: the wider of the library's shapes. */
function noiseOf(node: Record<string, unknown>): VirtualCameraNoiseSettings | null {
  if (node.noiseEnabled !== true) return null;
  return {
    seed: (node.noiseSeed as number | undefined) ?? 1,
    positionAmplitude: vec3Of(
      (node.noisePositionAmplitude as [number, number, number] | undefined) ?? [0, 0, 0]
    ),
    positionFrequency: vec3Of(
      (node.noisePositionFrequency as [number, number, number] | undefined) ?? [1, 1, 1]
    ),
    rotationAmplitudeDeg: vec3Of(
      (node.noiseRotationAmplitudeDeg as [number, number, number] | undefined) ?? [0, 0, 0]
    ),
    rotationFrequencyDeg: vec3Of(
      (node.noiseRotationFrequencyDeg as [number, number, number] | undefined) ?? [1, 1, 1]
    )
  };
}

/**
 * The shot's lens animation, or null. Only the FOV push is authorable today; the persisted block
 * schema carries all six lens fields, so a later panel can add one without a migration.
 *
 * A push whose end equals its start is NOT emitted: the evaluator would fold a constant into the
 * snapshot every frame for no visible reason, and the absence is what tells a reader the shot
 * has a fixed lens.
 */
function lensAnimationOf(node: Record<string, unknown>): CameraBlockLensAnimation | null {
  if (node.animateFov !== true) return null;
  const from = (node.fov as number | undefined) ?? 50;
  const to = (node.fovEnd as number | undefined) ?? from;
  if (Math.abs(to - from) < 1e-9) return null;
  return { fov: { from, to, easing: (node.fovEasing as Easing | undefined) ?? "easeInOut" } };
}
const quatOf = ([x, y, z, w]: readonly [number, number, number, number]) => ({ x, y, z, w });
