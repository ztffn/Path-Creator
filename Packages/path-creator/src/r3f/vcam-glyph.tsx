// Reusable virtual-camera editor visuals: VirtualCameraGlyph (a camera-shaped
// glyph with frustum outline + name label, coloured by live/selected/idle state)
// and CartVcamGlyphRig (mounts a glyph — or any child — on a cart's rail frame
// with a pluggable offset gizmo). Lines route through RigLine (WebGPU-safe) and
// the gizmo through RigGizmo, so both drop into any host renderer.
import { Text } from "@react-three/drei";
import { useMemo, useRef, type ReactNode } from "react";
import { Matrix4, type Group } from "three";
import type { CartFrame, Vec3 } from "../core";
import { useCartFrameFollow } from "./cart-gizmo";
import { PivotGizmo, type RigGizmoComponent } from "./rig-gizmo";
import { RigLine } from "./rig-line";

export interface VirtualCameraGlyphProps {
  name: string;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
}

export function VirtualCameraGlyph({ name, selected, active, onSelect }: VirtualCameraGlyphProps) {
  // One hue per state: green = live, orange = selected, slate = idle.
  const color = active ? "#22c55e" : selected ? "#f97316" : "#64748b";
  const emissiveIntensity = active ? 0.4 : selected ? 0.3 : 0.12;

  return (
    <group
      onPointerDown={(event) => {
        event.stopPropagation();
        onSelect();
      }}
    >
      <mesh>
        <boxGeometry args={[0.18, 0.12, 0.1]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissiveIntensity} />
      </mesh>
      <mesh position={[0, 0, -0.16]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.08, 0.18, 4]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={emissiveIntensity} />
      </mesh>
      <RigLine
        points={[
          [-0.16, -0.1, -0.34],
          [0.16, -0.1, -0.34],
          [0.16, 0.1, -0.34],
          [-0.16, 0.1, -0.34],
          [-0.16, -0.1, -0.34]
        ]}
        color={color}
        lineWidth={1.5}
      />
      <Text
        position={[0, 0.18, 0]}
        fontSize={0.08}
        color={color}
        anchorX="center"
        anchorY="middle"
        renderOrder={999}
        material-depthTest={false}
        material-depthWrite={false}
      >
        {name}
      </Text>
    </group>
  );
}

export interface CartVcamGlyphRigProps {
  framesRef: { current: Map<string, CartFrame> };
  cartId: string;
  selected: boolean;
  offset: Vec3;
  onOffsetChange: (offset: Vec3) => void;
  onTransformingChange: (isTransforming: boolean) => void;
  /** Injectable offset gizmo; defaults to drei PivotControls (see RigGizmo). */
  gizmo?: RigGizmoComponent;
  children: ReactNode;
}

export function CartVcamGlyphRig({
  framesRef,
  cartId,
  selected,
  offset,
  onOffsetChange,
  onTransformingChange,
  gizmo: Gizmo = PivotGizmo,
  children
}: CartVcamGlyphRigProps) {
  const groupRef = useRef<Group>(null);
  const offsetMatrix = useMemo(
    () => new Matrix4().makeTranslation(offset.x, offset.y, offset.z),
    [offset.x, offset.y, offset.z]
  );

  // The rig group sits ON the rail with the cart's frame basis as its local axes
  // (x=right, y=up, z=forward), so the gizmo's local translation IS the rail-local
  // offset the cart body applies.
  useCartFrameFollow(groupRef, framesRef, cartId);

  // Camera glyphs face -Z; the frame's forward is local +Z here.
  const glyph = <group rotation={[0, Math.PI, 0]}>{children}</group>;

  return (
    <group ref={groupRef}>
      {selected ? (
        <Gizmo
          matrix={offsetMatrix}
          disableRotations
          disableScaling
          onDragStart={() => onTransformingChange(true)}
          onDragEnd={() => onTransformingChange(false)}
          onDrag={(matrix) =>
            onOffsetChange({
              x: matrix.elements[12],
              y: matrix.elements[13],
              z: matrix.elements[14]
            })
          }
        >
          {glyph}
        </Gizmo>
      ) : (
        <group position={[offset.x, offset.y, offset.z]}>{glyph}</group>
      )}
    </group>
  );
}
