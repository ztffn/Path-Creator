// Demo-side "activatables" registry: the analogue of dragging a GameObject onto a
// Unity Activation Track. TargetRegistry is position/orientation-only, so this maps
// a stable id -> live Object3D so the activation applier can toggle .visible by id.
// An <Activatable id name> wrapper registers its group on mount; useActivatables
// lists the bound objects for the authoring UI. Purely demo scaffolding.
import { createContext, useContext, useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import type { Group, Object3D } from "three";
import { evaluateActivation, type ActivationTrack } from "./extra-tracks";

export interface ActivatableInfo {
  id: string;
  name: string;
}

/** id -> live Object3D map with change notification, mirroring TargetRegistry's shape. */
export class ActivatablesRegistry {
  private entries = new Map<string, { name: string; object: Object3D }>();
  private listeners = new Set<() => void>();
  private snapshot: ActivatableInfo[] = [];

  register(id: string, object: Object3D, name = id): () => void {
    this.entries.set(id, { name, object });
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

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ActivatableInfo[] => this.snapshot;

  private rebuild(): void {
    this.snapshot = [...this.entries.entries()].map(([id, { name }]) => ({ id, name }));
    for (const listener of this.listeners) listener();
  }
}

/** Snapshots the current .visible of each bound object, so "revert" can restore it. */
export function captureVisibility(
  registry: ActivatablesRegistry,
  tracks: readonly ActivationTrack[]
): Map<string, boolean> {
  const original = new Map<string, boolean>();
  for (const track of tracks) {
    const object = registry.resolve(track.objectId);
    if (object && !original.has(track.objectId)) original.set(track.objectId, object.visible);
  }
  return original;
}

/** Writes desired visibility onto each bound object (unregistered ids are skipped). */
export function applyVisibility(registry: ActivatablesRegistry, visibility: Map<string, boolean>): void {
  for (const [id, visible] of visibility) {
    const object = registry.resolve(id);
    if (object) object.visible = visible;
  }
}

/** Applies each track's Unity Post-Playback State when the director stops/leaves. */
export function applyPostPlayback(
  registry: ActivatablesRegistry,
  tracks: readonly ActivationTrack[],
  original: Map<string, boolean>
): void {
  for (const track of tracks) {
    const object = registry.resolve(track.objectId);
    if (!object) continue;
    switch (track.postPlaybackState) {
      case "active":
        object.visible = true;
        break;
      case "inactive":
        object.visible = false;
        break;
      case "revert":
        object.visible = original.get(track.objectId) ?? true;
        break;
      case "leaveAsIs":
        break;
    }
  }
}

/**
 * Owns the per-frame activation state machine (the demo's PlayableDirector): on
 * entry it captures original visibility; while the director controls (play or
 * scrub) it shows objects per their clip windows; and once playback reaches the
 * end — or the director is left — it applies and holds the Post-Playback State
 * until the user scrubs/plays again. All mutating; call sync() once per frame.
 */
export class ActivationDirector {
  private original = new Map<string, boolean>();
  private wasDriving = false;
  private held = false;
  private lastPlaying = false;
  private lastTime = 0;

  sync(
    registry: ActivatablesRegistry,
    tracks: readonly ActivationTrack[],
    driving: boolean,
    duration: number,
    time: number,
    playing: boolean
  ): void {
    if (driving) {
      if (!this.wasDriving) {
        this.original = captureVisibility(registry, tracks);
        this.held = false;
        this.wasDriving = true;
      }
      const atEnd = duration > 0 && time >= duration - 1e-3;
      // Playing, or scrubbing away from the end, resumes clip evaluation.
      if (playing || time !== this.lastTime) this.held = false;
      // Playback reached the end this frame → hold the Post-Playback State.
      if (this.lastPlaying && !playing && atEnd) this.held = true;
      if (this.held) applyPostPlayback(registry, tracks, this.original);
      else applyVisibility(registry, evaluateActivation(tracks, time));
    } else if (this.wasDriving) {
      applyPostPlayback(registry, tracks, this.original);
      this.wasDriving = false;
      this.held = false;
    }
    this.lastPlaying = playing;
    this.lastTime = time;
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
  children
}: {
  id: string;
  name?: string;
  children: ReactNode;
}) {
  const registry = useActivatablesRegistry();
  const groupRef = useRef<Group>(null);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    return registry.register(id, group, name ?? id);
  }, [registry, id, name]);
  return <group ref={groupRef}>{children}</group>;
}
