// Pluggable drag-gizmo seam (debrief P0.2). Editor components render a
// RigGizmoComponent instead of drei PivotControls directly, so a host can inject
// a WebGPU-safe gizmo where drei's fat-line PivotControls crashes the WebGPU
// renderer. Ships PivotGizmo (drei, WebGL default) + TransformGizmo (two stacked
// three TransformControls — translate arrows + rotate rings together — that
// auto-map on the node renderer). PathEditor and PointTargets route through it.
import { PivotControls, TransformControls } from "@react-three/drei";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
 * WebGPU-safe gizmo: two three TransformControls (translate + rotate) stacked on
 * one object, so move arrows and rotate rings show together — the PivotControls
 * "all handles at once" feel, but with LineBasicMaterial axes that auto-map on the
 * node renderer where drei's fat lines crash. Rotate is dropped when
 * disableRotations (e.g. control handles / point targets → translate only). Reports
 * the object's local matrix + the delta since drag-start through onDrag (so a
 * rotate drag can swing an anchor's control points). Needs a makeDefault
 * OrbitControls in the scene so orbit yields to the gizmo during drag.
 */
export const TransformGizmo: RigGizmoComponent = ({
  matrix,
  rotation,
  disableRotations,
  onDrag,
  onDragStart,
  onDragEnd,
  children
}) => {
  const target = useRef<Group>(null!);
  // Local matrix at drag-start (inverted), to report the delta transform.
  const startInverse = useRef(new Matrix4());
  // Which control is mid-drag, so the other one yields (else their pickers fight).
  const [active, setActive] = useState<"translate" | "rotate" | null>(null);

  // Seed the target's local pose from the incoming matrix + rotation; the controls
  // own it thereafter (binding `position` as a prop would fight the drag). Scale is
  // seeded too so a translate/rotate drag doesn't reset an anchor's scale. space=local
  // aligns the arrows to `rotation` (e.g. tangent).
  useEffect(() => {
    const group = target.current;
    if (!group) return;
    group.position.setFromMatrixPosition(matrix);
    group.scale.setFromMatrixScale(matrix);
    if (rotation) group.rotation.set(rotation[0], rotation[1], rotation[2]);
  }, [matrix, rotation]);

  // The gizmo's own picking raycaster defaults to layer 0 only, but a host that
  // parks the gizmo on a reserved layer (e.g. EditorHelpers marks the whole
  // editor subtree onto EDITOR_HELPERS_LAYER) would then be un-grabbable — the
  // handles draw but the raycaster can't hit them. Check all layers so the gizmo
  // is grabbable wherever it lives.
  const enableAllLayers = useCallback((controls: unknown) => {
    // `raycaster` is public at runtime (three-stdlib) though typed private.
    const rc = (controls as { raycaster?: { layers: { enableAll: () => void } } } | null)?.raycaster;
    rc?.layers.enableAll();
  }, []);

  const begin = useCallback(
    (which: "translate" | "rotate") => {
      const group = target.current;
      if (group) {
        group.updateMatrix();
        startInverse.current.copy(group.matrix).invert();
      }
      setActive(which);
      onDragStart?.();
    },
    [onDragStart]
  );
  const end = useCallback(() => {
    setActive(null);
    onDragEnd?.();
  }, [onDragEnd]);
  const report = useCallback(() => {
    const group = target.current;
    if (!group) return;
    group.updateMatrix();
    onDrag(group.matrix.clone(), startInverse.current.clone().multiply(group.matrix));
  }, [onDrag]);

  return (
    <>
      <group ref={target}>{children}</group>
      <TransformControls
        ref={enableAllLayers}
        object={target}
        mode="translate"
        space="local"
        enabled={active !== "rotate"}
        onMouseDown={() => begin("translate")}
        onMouseUp={end}
        onObjectChange={report}
      />
      {!disableRotations ? (
        <TransformControls
          ref={enableAllLayers}
          object={target}
          mode="rotate"
          space="local"
          enabled={active !== "translate"}
          onMouseDown={() => begin("rotate")}
          onMouseUp={end}
          onObjectChange={report}
        />
      ) : null}
    </>
  );
};
