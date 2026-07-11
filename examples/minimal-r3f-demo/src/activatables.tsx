// Demo-side "activatables" registry: the analogue of dragging a GameObject onto a
// Unity Activation Track. TargetRegistry is position/orientation-only, so this maps
// a stable id -> live Object3D so the activation applier can toggle .visible by id.
// An <Activatable id name> wrapper registers its group on mount; useActivatables
// lists the bound objects for the authoring UI. Purely demo scaffolding.
import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { TransformGizmo } from "@huma/path-creator/r3f";
import { Box3, BoxGeometry, EdgesGeometry, Matrix4, Vector3, type AnimationAction, type AnimationMixer, type Group, type Object3D } from "three";

/**
 * The animation side of an activatable: a GLB model's mixer plus its baked clips,
 * keyed by clip name. Present only for objects loaded from an animated GLB; the
 * AnimationTrackDirector reads it to drive clips by time. Primitives omit it.
 */
export interface AnimationFacet {
  mixer: AnimationMixer;
  actions: Map<string, AnimationAction>;
  clips: string[];
  /** Restore the model's captured bind pose (used when the timeline is left). */
  resetToRest: () => void;
}

export interface ActivatableInfo {
  id: string;
  name: string;
  /** Baked clip names when this activatable is an animated GLB model (else omitted). */
  clips?: string[];
}

/** id -> live Object3D map with change notification, mirroring TargetRegistry's shape. */
export class ActivatablesRegistry {
  private entries = new Map<string, { name: string; object: Object3D; animation?: AnimationFacet }>();
  private listeners = new Set<() => void>();
  private snapshot: ActivatableInfo[] = [];

  register(id: string, object: Object3D, name = id, animation?: AnimationFacet): () => void {
    this.entries.set(id, { name, object, ...(animation && { animation }) });
    this.rebuild();
    return () => {
      const current = this.entries.get(id);
      if (current?.object === object) {
        this.entries.delete(id);
        this.rebuild();
      }
    };
  }

  resolve(id: string): Object3D | null {
    return this.entries.get(id)?.object ?? null;
  }

  /** The animation facet for a GLB model, or null for primitives / unknown ids. */
  resolveAnimation(id: string): AnimationFacet | null {
    return this.entries.get(id)?.animation ?? null;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ActivatableInfo[] => this.snapshot;

  private rebuild(): void {
    this.snapshot = [...this.entries.entries()].map(([id, { name, animation }]) => ({
      id,
      name,
      ...(animation && { clips: animation.clips })
    }));
    for (const listener of this.listeners) listener();
  }
}

const ActivatablesContext = createContext<ActivatablesRegistry | null>(null);

export function ActivatablesProvider({
  registry,
  children
}: {
  registry: ActivatablesRegistry;
  children: ReactNode;
}) {
  return <ActivatablesContext.Provider value={registry}>{children}</ActivatablesContext.Provider>;
}

export function useActivatablesRegistry(): ActivatablesRegistry {
  const registry = useContext(ActivatablesContext);
  if (!registry) throw new Error("useActivatablesRegistry must be used within <ActivatablesProvider>");
  return registry;
}

/** Reactive list of bound activatables for the authoring UI. */
export function useActivatables(registry: ActivatablesRegistry): ActivatableInfo[] {
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

/**
 * Wraps children in a group and registers it as an activatable by id — the demo's
 * "bindable GameObject". Registration follows the id/name identity so a rename or
 * remount re-registers cleanly.
 */
export function Activatable({
  id,
  name,
  selected = false,
  onSelect,
  animation,
  position,
  rotation,
  scale,
  gizmoEnabled = false,
  onTransformingChange,
  children
}: {
  id: string;
  name?: string;
  selected?: boolean;
  onSelect?: () => void;
  /** Present when the child is an animated GLB model; surfaced via resolveAnimation. */
  animation?: AnimationFacet;
  /** Base placement applied to the registered group (so the gizmo + transform tracks
   *  drive the same node the object visibly sits on). */
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number | [number, number, number];
  /** Show the combined move/rotate/scale gizmo while this object is selected. */
  gizmoEnabled?: boolean;
  /** Fired on gizmo drag start/end so the host can suspend orbit controls. */
  onTransformingChange?: (transforming: boolean) => void;
  children: ReactNode;
}) {
  const registry = useActivatablesRegistry();
  const groupRef = useRef<Group>(null);
  const [bounds, setBounds] = useState<{ center: [number, number, number]; size: [number, number, number] } | null>(null);
  // Placement values arrive as fresh arrays each render; key by value so the effect
  // re-applies only on a real change (never clobbering a gizmo/director pose).
  const placeKey = JSON.stringify({ position, rotation, scale });
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    if (position) group.position.set(position[0], position[1], position[2]);
    if (rotation) group.rotation.set(rotation[0], rotation[1], rotation[2]);
    if (scale !== undefined) typeof scale === "number" ? group.scale.setScalar(scale) : group.scale.set(scale[0], scale[1], scale[2]);
    group.updateWorldMatrix(true, true);
    const unregister = registry.register(id, group, name ?? id, animation);
    // Measure in the group's LOCAL frame (world box mapped back through the group's
    // inverse), so a placed/scaled group still outlines correctly as a child.
    const box = new Box3().setFromObject(group);
    if (!box.isEmpty()) {
      box.applyMatrix4(new Matrix4().copy(group.matrixWorld).invert());
      const c = box.getCenter(new Vector3());
      const s = box.getSize(new Vector3());
      setBounds({ center: [c.x, c.y, c.z], size: [s.x * 1.3 + 0.12, s.y * 1.3 + 0.12, s.z * 1.3 + 0.12] });
    }
    return unregister;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, id, name, animation, placeKey]);
  // A gizmo can unmount mid-drag when timeline playback starts. Always release the
  // host's orbit lock in that case.
  const gizmoActive = selected && gizmoEnabled;
  useEffect(() => {
    if (!gizmoActive) return;
    return () => onTransformingChange?.(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gizmoActive]);
  return (
    <>
    <group ref={groupRef} {...(onSelect && { onPointerDown: (event: { stopPropagation: () => void }) => { event.stopPropagation(); onSelect(); } })}>
      {children}
      {selected && bounds ? <SelectionBox center={bounds.center} size={bounds.size} /> : null}
    </group>
    {gizmoActive && groupRef.current ? (
      <TransformGizmo
        matrix={groupRef.current.matrix.clone()}
        onDrag={(local) => {
          const group = groupRef.current;
          if (!group) return;
          local.decompose(group.position, group.quaternion, group.scale);
          group.updateMatrix();
          group.updateWorldMatrix(true, true);
        }}
        onDragStart={() => onTransformingChange?.(true)}
        onDragEnd={() => onTransformingChange?.(false)}
      />
    ) : null}
    </>
  );
}

/** A WebGPU-safe wireframe box (constant geometry) marking the selected object. */
function SelectionBox({ center, size }: { center: [number, number, number]; size: [number, number, number] }) {
  const edges = useMemo(() => {
    const box = new BoxGeometry(size[0], size[1], size[2]);
    const geometry = new EdgesGeometry(box);
    box.dispose();
    return geometry;
  }, [size]);
  useEffect(() => () => edges.dispose(), [edges]);
  return (
    <lineSegments position={center}>
      <primitive object={edges} attach="geometry" />
      <lineBasicMaterial color="#f97316" />
    </lineSegments>
  );
}
