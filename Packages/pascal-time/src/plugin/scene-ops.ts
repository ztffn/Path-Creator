// The scene-store boundary, cast once so nobody else has to. Pascal types its store against
// `AnyNode` — a closed union of its 46 built-in schemas — and `AnyNodeId`, a template-literal
// union of `${builtinKind}_${string}`. A third-party kind is in neither, so every store call
// from a plugin is a type error even though the runtime accepts it happily. These wrappers hold
// the cast, explain it, and mint ids in the shape Pascal's own kinds use.
import { generateId, nodeRegistry, useScene } from "@pascal-app/core";
import { TIMELINE_KIND } from "./kinds";

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
