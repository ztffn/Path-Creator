// Reusable editor gizmo: a wireframe box + optional label riding the rail at a
// cart's live frame, so a bare cart (no vcam/target mounted on it) stays visible
// and its rail position/orientation reads at a glance — Cinemachine's dolly cart.
// Reads the cart's frame from a shared frames map. Host places it on the editor-
// helpers layer (inside <EditorHelpers>); playback/vcam cameras never see it.
import { Text } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import { BoxGeometry, EdgesGeometry, type Group } from "three";
import type { CartFrame } from "../core";
import { applyCartFrameToObject } from "../three";

export interface CartGizmoProps {
  /** Shared live cart frames the host writes each frame (cartId -> frame). */
  framesRef: { current: Map<string, CartFrame> };
  cartId: string;
  name?: string;
  /** Box dimensions [width, height, depth] in scene units. */
  size?: [number, number, number];
  color?: string;
  labelColor?: string;
  lineWidth?: number;
}

export function CartGizmo({
  framesRef,
  cartId,
  name,
  size = [0.26, 0.06, 0.18],
  color = "#94a3b8",
  labelColor = "#cbd5e1",
  lineWidth = 2
}: CartGizmoProps) {
  const groupRef = useRef<Group>(null);

  // Sit on the rail with the cart's frame basis as local axes (x=right, y=up,
  // z=forward), ignoring any rail-local offset (that belongs to what rides it).
  useFrame(() => {
    const frame = framesRef.current.get(cartId) ?? null;
    const group = groupRef.current;
    if (!frame || !group) return;
    applyCartFrameToObject(group, frame);
    group.position.set(frame.railPosition.x, frame.railPosition.y, frame.railPosition.z);
  });

  const boxY = size[1] * 0.66;
  // Core edge geometry + LineBasicMaterial: thin but auto-maps on WebGPU, unlike
  // drei <Edges> (fat LineMaterial, WebGL-only). See RigLine / ROADMAP for the
  // node-material thickness follow-up.
  const edges = useMemo(() => new EdgesGeometry(new BoxGeometry(size[0], size[1], size[2])), [size]);

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
