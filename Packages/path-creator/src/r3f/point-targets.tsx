// In-viewport authoring for tracking targets: each target is a draggable glyph
// registered as a live pull-source in a TargetRegistry. A cart-mounted target
// follows the shared live cart frame each tick (not draggable); a static point
// target is positioned from state and moved via a PivotControls gizmo. Selection
// ring and gizmo are authoring-only (EditorHelpers layer); the sphere can hide.
import { Billboard, PivotControls } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, type ReactNode } from "react";
import { Matrix4, type Group } from "three";
import type { CartFrame, TargetRegistry, Vec3 } from "../core";
import { EditorHelpers } from "./editor";

export type EditableTarget =
  | { id: string; name?: string; type: "point"; position: Vec3; visibleInRender?: boolean }
  | { id: string; name?: string; type: "cart"; cartId: string; visibleInRender?: boolean };

export interface PointTargetsTheme {
  target?: string;
  targetSelected?: string;
  label?: string;
}

export interface PointTargetsProps {
  targets: EditableTarget[];
  registry: TargetRegistry;
  framesRef: { current: Map<string, CartFrame> };
  selectedId: string | null;
  theme?: PointTargetsTheme;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: Vec3) => void;
  onTransformingChange?: (transforming: boolean) => void;
}

const DEFAULT_THEME: Required<PointTargetsTheme> = {
  target: "#06b6d4",
  targetSelected: "#06b6d4",
  label: "#06b6d4"
};

const PIVOT_PROPS = {
  autoTransform: false,
  fixed: true,
  scale: 75,
  lineWidth: 2,
  depthTest: false
} as const;

// One target: a sphere on layer 0 (seen by the render) when visible, else on the
// editor-helpers layer (authoring-only). Selection ring + move gizmo are always
// authoring-only. A cart-mounted target follows the live cart frame each tick
// and isn't draggable; a static one is positioned from state.
function TargetView({
  target,
  isSelected,
  framesRef,
  theme,
  onSelect,
  onMove,
  onTransformingChange
}: {
  target: EditableTarget;
  isSelected: boolean;
  framesRef: { current: Map<string, CartFrame> };
  theme: Required<PointTargetsTheme>;
  onSelect: (id: string | null) => void;
  onMove: (id: string, position: Vec3) => void;
  onTransformingChange?: ((isTransforming: boolean) => void) | undefined;
}) {
  const groupRef = useRef<Group>(null);

  useFrame(() => {
    const group = groupRef.current;
    if (target.type !== "cart" || !group) return;
    const frame = framesRef.current.get(target.cartId);
    group.visible = frame != null;
    if (frame) group.position.set(frame.position.x, frame.position.y, frame.position.z);
  });

  const sphere = (
    <mesh
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect(isSelected ? null : target.id);
      }}
    >
      <sphereGeometry args={[0.1, 16, 16]} />
      <meshStandardMaterial
        color={theme.target}
        emissive={isSelected ? theme.targetSelected : theme.target}
        emissiveIntensity={isSelected ? 0.55 : 0.3}
      />
    </mesh>
  );
  const body = (
    <>
      {(target.visibleInRender ?? true) ? sphere : <EditorHelpers>{sphere}</EditorHelpers>}
      {isSelected ? (
        <EditorHelpers>
          <Billboard>
            <mesh>
              <ringGeometry args={[0.16, 0.19, 28]} />
              <meshBasicMaterial color={theme.targetSelected} transparent opacity={0.85} depthTest={false} />
            </mesh>
          </Billboard>
        </EditorHelpers>
      ) : null}
    </>
  );

  if (target.type === "cart") {
    // Position driven each frame from the cart frame; not draggable.
    return <group ref={groupRef}>{body}</group>;
  }

  return (
    <>
      <group position={[target.position.x, target.position.y, target.position.z]}>{body}</group>
      {isSelected ? (
        <EditorHelpers>
          <PivotControls
            {...PIVOT_PROPS}
            matrix={new Matrix4().makeTranslation(target.position.x, target.position.y, target.position.z)}
            disableRotations
            disableScaling
            onDragStart={() => onTransformingChange?.(true)}
            onDragEnd={() => onTransformingChange?.(false)}
            onDrag={(matrix) =>
              onMove(target.id, { x: matrix.elements[12], y: matrix.elements[13], z: matrix.elements[14] })
            }
          >
            <mesh>
              <sphereGeometry args={[0.001, 4, 4]} />
              <meshBasicMaterial transparent opacity={0} />
            </mesh>
          </PivotControls>
        </EditorHelpers>
      ) : null}
    </>
  );
}

/**
 * Authored targets: each a live pull-source in the registry. A cart-mounted
 * target resolves to the live cart frame; a static one to its position (read
 * via ref so a drag moves it without re-registering). Registration keys on the
 * id/name/mount set.
 */
export function PointTargets({
  targets,
  registry,
  framesRef,
  selectedId,
  theme,
  onSelect,
  onMove,
  onTransformingChange
}: PointTargetsProps): ReactNode {
  const resolvedTheme: Required<PointTargetsTheme> = { ...DEFAULT_THEME, ...theme };
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const membershipKey = targets
    .map((t) => `${t.id}:${t.name ?? ""}:${t.type === "cart" ? t.cartId : ""}`)
    .join("|");

  useEffect(() => {
    const unregister = targets.map((t) => {
      const source =
        t.type === "cart"
          ? () => framesRef.current.get(t.cartId)?.position ?? null
          : () => {
              const current = targetsRef.current.find((x) => x.id === t.id);
              if (current?.type === "point") return current.position;
              return t.type === "point" ? t.position : null;
            };
      return registry.register(t.id, source, t.name);
    });
    return () => unregister.forEach((fn) => fn());
    // Positions/frames are read live; only re-register when the id/name/mount set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipKey, registry]);

  return (
    <>
      {targets.map((t) => (
        <TargetView
          key={t.id}
          target={t}
          isSelected={t.id === selectedId}
          framesRef={framesRef}
          theme={resolvedTheme}
          onSelect={onSelect}
          onMove={onMove}
          onTransformingChange={onTransformingChange}
        />
      ))}
    </>
  );
}
