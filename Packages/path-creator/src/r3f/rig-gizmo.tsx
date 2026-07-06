// Pluggable drag-gizmo seam (debrief P0.2). Editor components render a
// RigGizmoComponent instead of drei PivotControls directly, so a host can inject
// a WebGPU-safe gizmo where drei's fat-line PivotControls crashes the WebGPU
// renderer. Ships PivotGizmo (drei, WebGL default) + TransformGizmo (a vendored,
// WebGPU-safe fork of PivotControls — same combined move+rotate+scale handles,
// but thin LineBasicMaterial-style lines that auto-map on the node renderer).
import { PivotControls } from "@react-three/drei";
import { type ReactNode } from "react";
import type { Matrix4 } from "three";
import { WebGPUPivotControls } from "./pivot";

export interface RigGizmoProps {
  /** Initial local transform; the gizmo reports drags relative to it. */
  matrix: Matrix4;
  /** Initial gizmo orientation (euler), e.g. aligning an axis to a tangent. */
  rotation?: [number, number, number];
  anchor?: [number, number, number];
  /** (localMatrix, deltaLocalMatrix) — delta is the transform since drag-start. */
  onDrag: (local: Matrix4, deltaLocal: Matrix4) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  disableRotations?: boolean;
  disableScaling?: boolean;
  /** Rotation-only: hide the translate arrows + plane sliders (e.g. the midpoint
   *  normal-rotation pivot). Maps to disableAxes + disableSliders. */
  disableTranslation?: boolean;
  /** Screen-constant gizmo size (pixels, with `fixed`). */
  scale?: number;
  children?: ReactNode;
}

export type RigGizmoComponent = (props: RigGizmoProps) => ReactNode;

/** Default gizmo: drei PivotControls (WebGL fat-line axes). */
export const PivotGizmo: RigGizmoComponent = ({
  matrix,
  rotation,
  anchor,
  onDrag,
  onDragStart,
  onDragEnd,
  disableRotations,
  disableScaling,
  disableTranslation,
  scale = 75,
  children
}) => (
  <PivotControls
    autoTransform={false}
    fixed
    depthTest={false}
    lineWidth={2}
    scale={scale}
    matrix={matrix}
    {...(rotation && { rotation })}
    {...(anchor && { anchor })}
    {...(disableRotations && { disableRotations: true })}
    {...(disableScaling && { disableScaling: true })}
    {...(disableTranslation && { disableAxes: true, disableSliders: true })}
    {...(onDragStart && { onDragStart })}
    {...(onDragEnd && { onDragEnd })}
    onDrag={(local, deltaLocal) => onDrag(local, deltaLocal)}
  >
    {children}
  </PivotControls>
);

/**
 * WebGPU-safe gizmo: the vendored PivotControls fork (src/r3f/pivot). Same
 * combined gizmo as PivotGizmo — move arrows + plane sliders + rotate rings +
 * scale handles shown together, per-handle invisible mesh pickers (no shared
 * free-rotate sphere, so translate vs rotate never mis-grab), and `fixed`
 * screen-constant pixel sizing — but its lines are thin node-material-safe lines
 * instead of drei's fat LineMaterial. Reports the dragged object's local matrix +
 * the delta since drag-start through onDrag. Needs a makeDefault OrbitControls in
 * the scene so orbit yields to the gizmo during drag.
 */
export const TransformGizmo: RigGizmoComponent = ({
  matrix,
  rotation,
  anchor,
  onDrag,
  onDragStart,
  onDragEnd,
  disableRotations,
  disableScaling,
  disableTranslation,
  scale = 75,
  children
}) => (
  <WebGPUPivotControls
    autoTransform={false}
    fixed
    depthTest={false}
    lineWidth={2}
    scale={scale}
    matrix={matrix}
    {...(rotation && { rotation })}
    {...(anchor && { anchor })}
    {...(disableRotations && { disableRotations: true })}
    {...(disableScaling && { disableScaling: true })}
    {...(disableTranslation && { disableAxes: true, disableSliders: true })}
    {...(onDragStart && { onDragStart })}
    {...(onDragEnd && { onDragEnd })}
    onDrag={(local, deltaLocal) => onDrag(local, deltaLocal)}
  >
    {children}
  </WebGPUPivotControls>
);
