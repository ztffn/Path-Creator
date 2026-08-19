// Renderer for the `huma-time:shot` kind — the one kind in this package that draws something,
// because a shot is the one that is placed. A body and a cone pointing down local -Z, which is
// where a three.js camera looks, so the marker shows both where the shot is and where it aims.
// Deliberately plain meshes: a node renderer must stay renderer-agnostic or it breaks under the
// WebGPU shell, which is why there are no fat lines and no text here. Scope: one kind's gizmo.
import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { useRegistry } from "@pascal-app/core";
import { MathUtils, Vector3, type Object3D } from "three";
import { SHOT_KIND, type ShotNodeType } from "../plugin/kinds";

/** Muted until selected — a shot list is scene furniture, not the subject. */
const BODY_COLOR = "#7c8ba1";
const LENS_COLOR = "#38bdf8";

/**
 * Inside this range the marker hides. A from-view shot sits EXACTLY where the camera is, so
 * without this the author's first sight after capturing is the inside of the lens cone — a
 * screen-filling wash of LENS_COLOR obscuring the whole scene. Same convention as Blender
 * hiding the active camera's body in camera view. The REGISTERED group stays visible — only
 * the marker meshes hide, so activation tracks and selection still own `visible` semantics.
 */
const HIDE_WITHIN_METRES = 0.8;
const _markerWorld = new Vector3();

export default function ShotRenderer({ node }: { node: ShotNodeType }) {
  const ref = useRef<Object3D>(null!);
  const marker = useRef<Object3D>(null);
  useRegistry(node.id, SHOT_KIND, ref);

  useFrame(({ camera }) => {
    if (!marker.current || !ref.current) return;
    ref.current.getWorldPosition(_markerWorld);
    marker.current.visible = _markerWorld.distanceTo(camera.position) > HIDE_WITHIN_METRES;
  });

  return (
    <group
      name={node.name ?? node.id}
      position={node.position}
      ref={ref}
      rotation={node.rotationDeg.map(MathUtils.degToRad) as unknown as [number, number, number]}
      visible={node.visible !== false}
    >
      <group ref={marker}>
        <mesh>
          <boxGeometry args={[0.32, 0.24, 0.42]} />
          <meshStandardMaterial color={BODY_COLOR} roughness={0.5} />
        </mesh>
        {/* Rotated onto -Z: a cone's axis is +Y, a camera looks down -Z. */}
        <mesh position={[0, 0, -0.34]} rotation={[-Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.16, 0.26, 16]} />
          <meshStandardMaterial color={LENS_COLOR} roughness={0.35} />
        </mesh>
      </group>
    </group>
  );
}
