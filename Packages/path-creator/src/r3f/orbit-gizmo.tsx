// Orbit-body editor rig (debrief P1 orbit body): mounts a group at the orbit
// target, oriented by the live binding frame (world / lockYaw / lock), and draws
// the authoring/debug gizmo — the orbit ring, the radius arm, a binding-frame
// axis triad, and a camera glyph riding the ring. When selected, a translate
// PivotGizmo at the camera position maps drags back to azimuth/elevation/radius.
// Lines route through RigLine (WebGPU-safe); the frame follows the target each
// frame so lockYaw/lock visibly track a rotating target.
import { useFrame } from "@react-three/fiber";
import { useMemo, useRef, type ReactNode } from "react";
import { Matrix4, type Group } from "three";
import type { OrbitBinding, QuaternionLike, Vec3 } from "../core";
import {
  buildOrbitRingPoints,
  cameraQuaternionFromFrame,
  orbitBindingQuaternion,
  orbitOffset,
  orbitParamsFromLocalOffset
} from "../three";
import { PivotGizmo, type RigGizmoComponent } from "./rig-gizmo";
import { RigLine } from "./rig-line";

type Tuple = [number, number, number];
const toTuple = (v: Vec3): Tuple => [v.x, v.y, v.z];
const LOCAL_UP: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * Monotonic version that bumps whenever `value`'s identity changes — feeds
 * RigLine's `version` so a same-length point buffer re-uploads on WebGPU (a
 * grown/edited orbit ring would otherwise go stale). `value` is a memoized
 * array, so this bumps exactly on a real content change, never per frame.
 */
function useContentVersion(value: unknown): number {
  const ref = useRef(0);
  const prev = useRef<unknown>(null);
  if (prev.current !== value) {
    prev.current = value;
    ref.current += 1;
  }
  return ref.current;
}

export interface OrbitVcamGlyphRigProps {
  /** Live orbit target position (rig space); the ring centres here. */
  resolveTarget: () => Vec3 | null;
  /** Live orbit target orientation for `lockYaw`/`lock`; null → world binding. */
  resolveOrientation?: () => QuaternionLike | null;
  binding: OrbitBinding;
  azimuthDeg: number;
  elevationDeg: number;
  radius: number;
  selected: boolean;
  onChange: (params: { azimuthDeg: number; elevationDeg: number; radius: number }) => void;
  onTransformingChange: (isTransforming: boolean) => void;
  /** Injectable gizmo; defaults to drei PivotControls (see RigGizmo). */
  gizmo?: RigGizmoComponent;
  color?: string;
  /** The camera glyph (or any marker) placed at the orbit position, facing the target. */
  children?: ReactNode;
}

export function OrbitVcamGlyphRig({
  resolveTarget,
  resolveOrientation,
  binding,
  azimuthDeg,
  elevationDeg,
  radius,
  selected,
  onChange,
  onTransformingChange,
  gizmo: Gizmo = PivotGizmo,
  color = "#38bdf8",
  children
}: OrbitVcamGlyphRigProps) {
  const groupRef = useRef<Group>(null);

  // The group IS the binding frame: sit it on the target, oriented by the live
  // binding quaternion, so all children are authored in target-local space and
  // lockYaw/lock visibly follow the target's rotation.
  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const target = resolveTarget();
    if (!target) {
      group.visible = false;
      return;
    }
    group.visible = true;
    group.position.set(target.x, target.y, target.z);
    const orientation = binding !== "world" ? resolveOrientation?.() ?? null : null;
    const q = orbitBindingQuaternion(binding, orientation);
    group.quaternion.set(q.x, q.y, q.z, q.w);
  });

  const offset = useMemo(
    () => orbitOffset(azimuthDeg, elevationDeg, radius),
    [azimuthDeg, elevationDeg, radius]
  );
  // Glyph looks from the ring position back at the target (-offset forward).
  const glyphQuat = useMemo(
    () => cameraQuaternionFromFrame({ x: -offset.x, y: -offset.y, z: -offset.z }, LOCAL_UP),
    [offset]
  );

  const glyph = (
    <group
      position={[offset.x, offset.y, offset.z]}
      quaternion={[glyphQuat.x, glyphQuat.y, glyphQuat.z, glyphQuat.w]}
    >
      {children}
    </group>
  );

  return (
    <group ref={groupRef}>
      {selected ? (
        <OrbitAuthoringGizmo
          offset={offset}
          radius={radius}
          elevationDeg={elevationDeg}
          color={color}
          Gizmo={Gizmo}
          onChange={onChange}
          onTransformingChange={onTransformingChange}
        >
          {glyph}
        </OrbitAuthoringGizmo>
      ) : (
        glyph
      )}
    </group>
  );
}

// Split so the debug-line memos/versions only exist while the rig is selected;
// idle/playback renders just the glyph with no line churn.
function OrbitAuthoringGizmo({
  offset,
  radius,
  elevationDeg,
  color,
  Gizmo,
  onChange,
  onTransformingChange,
  children
}: {
  offset: Vec3;
  radius: number;
  elevationDeg: number;
  color: string;
  Gizmo: RigGizmoComponent;
  onChange: (params: { azimuthDeg: number; elevationDeg: number; radius: number }) => void;
  onTransformingChange: (isTransforming: boolean) => void;
  children: ReactNode;
}) {
  const ringPoints = useMemo(
    () => buildOrbitRingPoints(radius, elevationDeg).map(toTuple),
    [radius, elevationDeg]
  );
  const ringVersion = useContentVersion(ringPoints);

  const armPoints = useMemo<Tuple[]>(
    () => [
      [0, 0, 0],
      [offset.x, offset.y, offset.z]
    ],
    [offset]
  );
  const armVersion = useContentVersion(armPoints);

  const axisLen = Math.max(0.4, radius * 0.25);
  const axes = useMemo<{ points: Tuple[]; color: string }[]>(
    () => [
      { points: [[0, 0, 0], [axisLen, 0, 0]], color: "#ef4444" },
      { points: [[0, 0, 0], [0, axisLen, 0]], color: "#22c55e" },
      { points: [[0, 0, 0], [0, 0, axisLen]], color: "#3b82f6" }
    ],
    [axisLen]
  );
  const axisVersion = useContentVersion(axes);

  const gizmoMatrix = useMemo(
    () => new Matrix4().makeTranslation(offset.x, offset.y, offset.z),
    [offset]
  );

  return (
    <>
      <RigLine points={ringPoints} color={color} lineWidth={1.5} version={ringVersion} />
      <RigLine points={armPoints} color={color} lineWidth={1} version={armVersion} />
      {axes.map((axis, i) => (
        <RigLine
          key={i}
          points={axis.points}
          color={axis.color}
          lineWidth={2}
          version={axisVersion}
        />
      ))}
      <Gizmo
        matrix={gizmoMatrix}
        disableRotations
        disableScaling
        onDragStart={() => onTransformingChange(true)}
        onDragEnd={() => onTransformingChange(false)}
        onDrag={(local) =>
          onChange(
            orbitParamsFromLocalOffset({
              x: local.elements[12],
              y: local.elements[13],
              z: local.elements[14]
            })
          )
        }
      >
        {children}
      </Gizmo>
    </>
  );
}
