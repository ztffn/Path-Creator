// Reusable editor gizmo: a wireframe box + optional label riding the rail at a
// cart's live frame, so a bare cart (no vcam/target mounted on it) stays visible
// and its rail position/orientation reads at a glance — Cinemachine's dolly cart.
// Reads the cart's frame from a shared frames map. Host places it on the editor-
// helpers layer (inside <EditorHelpers>); playback/vcam cameras never see it.
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef } from "react";
import { BoxGeometry, EdgesGeometry, type Group } from "three";
import type { CartFrame } from "../core";
import { applyCartFrameToObject } from "../three";

/**
 * Per-frame: sit `groupRef` on the rail at the cart's live frame — the frame
 * basis as local axes (x=right, y=up, z=forward), position on the rail (ignoring
 * any rail-local offset, which belongs to what rides the cart). Shared so the
 * cart marker and any cart-mounted rig follow the rail identically.
 */
export function useCartFrameFollow(
  groupRef: { current: Group | null },
  framesRef: { current: Map<string, CartFrame> },
  cartId: string
): void {
  useFrame(() => {
    const frame = framesRef.current.get(cartId) ?? null;
    const group = groupRef.current;
    if (!frame || !group) return;
    applyCartFrameToObject(group, frame);
    group.position.set(frame.railPosition.x, frame.railPosition.y, frame.railPosition.z);
  });
}

// Stable default so the geometry memo below actually holds (an inline literal
// default would be a fresh reference every render → rebuilt geometry per frame).
const DEFAULT_CART_SIZE: [number, number, number] = [0.26, 0.06, 0.18];

export interface CartGizmoProps {
  /** Shared live cart frames the host writes each frame (cartId -> frame). */
  framesRef: { current: Map<string, CartFrame> };
  cartId: string;
  name?: string;
  /** Box dimensions [width, height, depth] in scene units. */
  size?: [number, number, number];
  color?: string;
  labelColor?: string;
}

export function CartGizmo({
  framesRef,
  cartId,
  name,
  size = DEFAULT_CART_SIZE,
  color = "#94a3b8",
  labelColor = "#cbd5e1"
}: CartGizmoProps) {
  const groupRef = useRef<Group>(null);
  useCartFrameFollow(groupRef, framesRef, cartId);

  // Core edge geometry + LineBasicMaterial: thin but auto-maps on WebGPU, unlike
  // drei <Edges> (fat LineMaterial, WebGL-only). See RigLine / ROADMAP for the
  // node-material thickness follow-up.
  const edges = useMemo(() => {
    const box = new BoxGeometry(size[0], size[1], size[2]);
    const geometry = new EdgesGeometry(box);
    box.dispose();
    return geometry;
  }, [size]);
  useEffect(() => () => edges.dispose(), [edges]);

  const boxY = size[1] * 0.66;

  return (
    <group ref={groupRef}>
      <lineSegments position={[0, boxY, 0]}>
        <primitive object={edges} attach="geometry" />
        <lineBasicMaterial color={color} />
      </lineSegments>
      {name ? (
        <Text
          position={[0, boxY + 0.1, 0]}
          fontSize={0.08}
          color={labelColor}
          anchorX="center"
          anchorY="middle"
          renderOrder={999}
          material-depthTest={false}
        >
          {name}
        </Text>
      ) : null}
    </group>
  );
}
