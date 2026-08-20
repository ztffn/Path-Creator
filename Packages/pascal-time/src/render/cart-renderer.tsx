// Renderer for the `huma-time:cart` kind — the dolly cart riding a rail. It has no position of
// its own: every frame it reads the cart frame the director resolved from the timeline and writes
// that straight onto its own Object3D, which is the same "write to the live object, never to node
// data" rule the rest of this package keeps. Plain meshes only, so it survives Pascal's WebGPU
// shell. Scope: one kind's gizmo.
import { useFrame } from "@react-three/fiber";
import { useRef } from "react";
import { useRegistry } from "@pascal-app/core";
import { Matrix4, Vector3, type Object3D } from "three";
import { CART_KIND, type CartNodeType } from "../plugin/kinds";
import { getCartFrames } from "../drive/timeline-scene-driver";

const BODY_COLOR = "#2dd4bf";
const _basis = new Matrix4();
const _right = new Vector3();
const _up = new Vector3();
const _forward = new Vector3();

export default function CartRenderer({ node }: { node: CartNodeType }) {
  const ref = useRef<Object3D>(null!);
  useRegistry(node.id, CART_KIND, ref);

  useFrame(() => {
    const group = ref.current;
    if (!group) return;
    const frame = getCartFrames().get(node.id);
    // No frame means no rail yet (or a cart whose path was deleted). Park it at the origin of
    // its parent rather than leaving it wherever it last was — a cart that keeps riding a rail
    // it no longer has is the kind of stale that reads as a bug in the rail.
    if (!frame) {
      group.position.set(0, 0, 0);
      group.quaternion.identity();
      return;
    }
    group.position.set(frame.position.x, frame.position.y, frame.position.z);
    // Build the orientation from the rail's own basis. The frame's three axes are already
    // orthonormal, so a basis matrix is exact where a lookAt would re-derive `up` and lose the
    // bank a `path-frame` cart is carrying.
    _right.set(frame.right.x, frame.right.y, frame.right.z);
    _up.set(frame.up.x, frame.up.y, frame.up.z);
    _forward.set(frame.forward.x, frame.forward.y, frame.forward.z);
    _basis.makeBasis(_right, _up, _forward);
    group.quaternion.setFromRotationMatrix(_basis);
  });

  return (
    <group name={node.name ?? node.id} ref={ref} visible={node.visible !== false}>
      <mesh>
        <boxGeometry args={[0.36, 0.2, 0.5]} />
        <meshStandardMaterial color={BODY_COLOR} roughness={0.45} />
      </mesh>
      {/* A spur along local +Z so the cart's heading on the rail reads at a glance. A cone's
          axis is +Y, hence the quarter turn — the cart's forward IS +Z (makeBasis puts the
          frame's forward there), which is the opposite of a camera's -Z. */}
      <mesh position={[0, 0, 0.36]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.1, 0.22, 12]} />
        <meshStandardMaterial color={BODY_COLOR} roughness={0.35} />
      </mesh>
    </group>
  );
}
