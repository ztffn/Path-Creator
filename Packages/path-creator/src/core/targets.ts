// Tracking targets: the "what should the camera look at" seam. Anything that
// can produce a world position registers under an id (scene objects, carts,
// fixed points); vcam aims and composers reference targets by id and resolve
// per frame through a TargetRegistry. Groups blend members into a weighted
// centroid, matching Cinemachine's target-group concept. Engine-agnostic.
import { type Vec3 } from "./types";
import { vec3 } from "./vec3";

export interface TargetGroupMember {
  targetId: string;
  weight: number;
}

export type TrackingTargetDefinition =
  | { id: string; name?: string; type: "point"; position: Vec3 }
  | { id: string; name?: string; type: "cart"; cartId: string }
  | { id: string; name?: string; type: "group"; members: TargetGroupMember[] };

export type TargetSource = () => Vec3 | null;

export interface RegisteredTarget {
  id: string;
  name: string;
}

/**
 * Runtime lookup from target id to live world position. Sources are pull-based
 * (queried at resolve time), so a registered scene object or cart is always
 * read at its current pose — nothing is cached between frames.
 */
export class TargetRegistry {
  private readonly sources = new Map<string, { name: string; source: TargetSource }>();
  private readonly listeners = new Set<() => void>();
  private version_ = 0;

  /** Registers a target source; returns an unregister function. */
  register(id: string, source: TargetSource, name = id): () => void {
    this.sources.set(id, { name, source });
    this.notify();
    return () => {
      if (this.sources.get(id)?.source === source) {
        this.sources.delete(id);
        this.notify();
      }
    };
  }

  /** Notified when targets are added or removed (not when they move). */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Monotonic counter bumped on registration changes; cheap snapshot key. */
  get version(): number {
    return this.version_;
  }

  private notify(): void {
    this.version_ += 1;
    for (const listener of this.listeners) listener();
  }

  resolve(id: string): Vec3 | null {
    return this.sources.get(id)?.source() ?? null;
  }

  /** Weighted centroid of resolvable members; null when nothing resolves. */
  resolveGroup(members: TargetGroupMember[]): Vec3 | null {
    let totalWeight = 0;
    let sum = vec3.create();

    for (const member of members) {
      const weight = Math.max(0, member.weight);
      if (weight === 0) continue;
      const position = this.resolve(member.targetId);
      if (!position) continue;
      sum = vec3.add(sum, vec3.scale(position, weight));
      totalWeight += weight;
    }

    return totalWeight > 0 ? vec3.scale(sum, 1 / totalWeight) : null;
  }

  list(): RegisteredTarget[] {
    return [...this.sources.entries()].map(([id, entry]) => ({ id, name: entry.name }));
  }

  has(id: string): boolean {
    return this.sources.has(id);
  }
}
