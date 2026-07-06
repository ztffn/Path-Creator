// Pluggable drag-gizmo seam (debrief P0.2). Editor components render a
// RigGizmoComponent instead of drei PivotControls directly, so a host can inject
// a WebGPU-safe gizmo (three TransformControls) where drei's fat-line PivotControls
// crashes the WebGPU renderer. The package ships PivotGizmo (drei) as the default;
// the TransformControls impl + routing the rest of the editor through this is a
// ROADMAP follow-up (it needs an interactive/WebGPU oracle to verify).
import { PivotControls, TransformControls } from "@react-three/drei";
import { useEffect, useRef, type ReactNode } from "react";
import type { Group, Matrix4 } from "three";

export interface RigGizmoProps {
  /** Initial local transform; the gizmo reports drags relative to it. */
  matrix: Matrix4;
  onDrag: (matrix: Matrix4) => void;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  disableRotations?: boolean;
  disableScaling?: boolean;
  /** Screen-constant gizmo size. */
  scale?: number;
  children?: ReactNode;
}

export type RigGizmoComponent = (props: RigGizmoProps) => ReactNode;

/** Default gizmo: drei PivotControls (WebGL fat-line axes). */
export const PivotGizmo: RigGizmoComponent = ({
  matrix,
  onDrag,
  onDragStart,
  onDragEnd,
  disableRotations,
  disableScaling,
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
    {...(disableRotations && { disableRotations: true })}
    {...(disableScaling && { disableScaling: true })}
    {...(onDragStart && { onDragStart })}
    {...(onDragEnd && { onDragEnd })}
    onDrag={(local) => onDrag(local)}
  >
    {children}
  </PivotControls>
);

/**
 * WebGPU-safe gizmo: three's TransformControls (translate), whose LineBasicMaterial
 * axes auto-map on the node renderer where drei PivotControls' fat lines crash.
 * Translate-only for now (covers the offset/handle cases); rotate/scale is a
 * follow-up. Reports the dragged object's local matrix through onDrag. Needs a
 * makeDefault OrbitControls in the scene so orbit yields to the gizmo during drag.
 */
export const TransformGizmo: RigGizmoComponent = ({
  matrix,
  onDrag,
  onDragStart,
  onDragEnd,
  children
}) => {
  const target = useRef<Group>(null!);
  // Seed the target's local position from the incoming matrix; TransformControls
  // owns it thereafter (don't bind `position` as a prop or React fights the drag).
  useEffect(() => {
    if (target.current) target.current.position.setFromMatrixPosition(matrix);
  }, [matrix]);

  return (
    <>
      <group ref={target}>{children}</group>
      <TransformControls
        object={target}
        mode="translate"
        space="local"
        onMouseDown={() => onDragStart?.()}
        onMouseUp={() => onDragEnd?.()}
        onObjectChange={() => {
          const group = target.current;
          if (!group) return;
          group.updateMatrix();
          onDrag(group.matrix.clone());
        }}
      />
    </>
  );
};
