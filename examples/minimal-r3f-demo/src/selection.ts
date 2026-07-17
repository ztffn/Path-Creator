// Unified single-selection model for the demo's engine-style Hierarchy + Inspector.
// One Selection atom identifies the active entity across every kind; the Hierarchy
// lists them, the Inspector renders the selected one, and the viewport highlights
// it — replacing the old per-type selectedXxxId state. Path-anchor sub-selection
// (selectedHandleIndex/Midpoint) stays separate, scoped to the active path.

export type EntityKind = "scene" | "path" | "dolly" | "camera" | "target" | "object" | "audio" | "trigger";

export interface SelectionRef {
  kind: EntityKind;
  id: string;
}

export type Selection = SelectionRef | null;

/** The fixed id of the singleton Scene entity (global settings). */
export const SCENE_ID = "scene";

/** True when `selection` points at exactly this entity. */
export function isSelected(selection: Selection, kind: EntityKind, id: string): boolean {
  return selection?.kind === kind && selection.id === id;
}

/** The selected id for a kind, or null when a different kind (or nothing) is selected. */
export function selectedIdOf(selection: Selection, kind: EntityKind): string | null {
  return selection?.kind === kind ? selection.id : null;
}
