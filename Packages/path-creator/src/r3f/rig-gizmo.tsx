// Pluggable drag-gizmo seam (debrief P0.2). Editor components render a
// RigGizmoComponent instead of drei PivotControls directly, so a host can inject
// a WebGPU-safe gizmo (three TransformControls) where drei's fat-line PivotControls
// crashes the WebGPU renderer. The package ships PivotGizmo (drei) as the default;
// the TransformControls impl + routing the rest of the editor through this is a
// ROADMAP follow-up (it needs an interactive/WebGPU oracle to verify).
import { PivotControls, TransformControls } from "@react-three/drei";
import { useEffect, useRef, type ReactNode } from "react";
import { Matrix4, type Group } from "three";

export interface RigGizmoProps {
  /** Initial local transform; the gizmo reports drags relative to it. */
  matrix: Matrix4;
  /** Initial gizmo orientation (euler), e.g. aligning an axis to a tangent. */
  rotation?: [number, number, number];
  anchor?: [number, number, number];
  /** (localMatrix, deltaLocalMatrix) — delta is identity for translate-only gizmos. */
  onDrag: (local: Matrix4, deltaLocal: Matrix4) => void;
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
  rotation,
  anchor,
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
    {...(rotation && { rotation })}
    {...(anchor && { anchor })}
    {...(disableRotations && { disableRotations: true })}
    {...(disableScaling && { disableScaling: true })}
    {...(onDragStart && { onDragStart })}
    {...(onDragEnd && { onDragEnd })}
    onDrag={(local, deltaLocal) => onDrag(local, deltaLocal)}
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
const IDENTITY_DELTA = new Matrix4();

export const TransformGizmo: RigGizmoComponent = ({
  matrix,
  rotation,
  onDrag,
  onDragStart,
  onDragEnd,
  children
}) => {
  const target = useRef<Group>(null!);
  // Seed the target's local pose from the incoming matrix + rotation;
  // TransformControls owns it thereafter (binding `position` as a prop would
  // fight the drag). space=local aligns the arrows to `rotation` (e.g. tangent).
  useEffect(() => {
    const group = target.current;
    if (!group) return;
    group.position.setFromMatrixPosition(matrix);
    if (rotation) group.rotation.set(rotation[0], rotation[1], rotation[2]);
  }, [matrix, rotation]);

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
          // Translate-only: no rotation delta, so the anchor co-move uses the
          // absolute position (vs its drag-start) rather than this delta.
          onDrag(group.matrix.clone(), IDENTITY_DELTA);
        }}
      />
    </>
  );
};
