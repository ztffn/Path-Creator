// Triggers/Actions schema + pure predicates: TriggerDefinition (source +
// condition + arm policy), ActionDefinition (verb + target + params), and
// TriggerBinding joining them n:m — plus the side-effect-free proximity
// hysteresis and arm-policy reducers the reactive runtime steps. All state
// lives with the runtime caller; nothing here owns time, timers, or effects.
import type { Vec3 } from "./types";
import type { VirtualCameraBlendCurve } from "./virtual-camera";

/** When a fired trigger re-arms. `cooldown` re-arms after `seconds`. */
export type TriggerArmPolicy =
  | { type: "once" }
  | { type: "rearm-on-exit" }
  | { type: "every-time" }
  | { type: "cooldown"; seconds: number };

/**
 * What a trigger listens to.
 * - proximity: the live camera enters `radius` around a target/entity; it must
 *   leave `radius + hysteresis` before an exit registers (chatter guard).
 * - marker: a scene's EventTrack event crossed during forward PLAYBACK
 *   (never scrub/seek). `eventKind`/`eventId` filter which events match.
 * - click: a bound object clicked in present mode.
 */
export type TriggerSource =
  | { type: "proximity"; targetId: string; radius: number; hysteresis?: number }
  | { type: "marker"; sceneId?: string; eventKind?: string; eventId?: string }
  | { type: "click"; objectId: string };

export interface TriggerDefinition {
  id: string;
  name?: string;
  source: TriggerSource;
  arm: TriggerArmPolicy;
  enabled?: boolean;
}

/** What a fired trigger does (executed by the host's runtimes). */
export type ActionDefinition =
  | {
      id: string;
      type: "playScene";
      sceneId: string;
      skippable?: boolean;
      blend?: { durationSeconds?: number; curve?: VirtualCameraBlendCurve };
    }
  | { id: string; type: "transport"; op: "play" | "pause" | "seek"; time?: number }
  | { id: string; type: "setActive"; objectId: string; active: boolean };

/** Joins a trigger to an action. Higher priority wins playScene conflicts. */
export interface TriggerBinding {
  id: string;
  triggerId: string;
  actionId: string;
  priority?: number;
}

// --- Pure predicates / reducers -------------------------------------------------

/** Proximity hysteresis state: whether the subject is currently "inside". */
export interface ProximityState {
  inside: boolean;
}

export interface ProximityEdge {
  inside: boolean;
  entered: boolean;
  exited: boolean;
}

/**
 * One proximity step: entering happens at `radius`, exiting only past
 * `radius + hysteresis` — a subject hovering on the boundary produces no
 * enter/exit chatter. Pure: returns the next state + edges.
 */
export function stepProximity(
  state: ProximityState,
  subject: Vec3,
  target: Vec3,
  radius: number,
  hysteresis = 0
): ProximityEdge {
  const dx = subject.x - target.x;
  const dy = subject.y - target.y;
  const dz = subject.z - target.z;
  const distance = Math.hypot(dx, dy, dz);
  if (!state.inside) {
    const entered = distance <= radius;
    return { inside: entered, entered, exited: false };
  }
  const exited = distance > radius + Math.max(0, hysteresis);
  return { inside: !exited, entered: false, exited };
}

/** Arm-policy state: whether the trigger may fire, plus cooldown bookkeeping. */
export interface ArmState {
  armed: boolean;
  /** Seconds until a cooldown re-arm (0 when not cooling down). */
  cooldownRemaining: number;
  firedCount: number;
}

export function createArmState(): ArmState {
  return { armed: true, cooldownRemaining: 0, firedCount: 0 };
}

/**
 * One arm-policy step, as a pure reducer: given the elapsed dt, whether the
 * source's condition fired this frame, and (for proximity) whether the subject
 * exited, returns the next state and whether the trigger actually fires.
 * - once: fires a single time, never re-arms.
 * - rearm-on-exit: re-arms when the subject exits (proximity semantics).
 * - every-time: fires on every condition edge.
 * - cooldown: re-arms `seconds` after firing.
 */
export function stepArmPolicy(
  state: ArmState,
  policy: TriggerArmPolicy,
  input: { conditionFired: boolean; exited?: boolean },
  deltaSeconds: number
): { state: ArmState; fire: boolean } {
  let armed = state.armed;
  let cooldownRemaining = Math.max(0, state.cooldownRemaining - Math.max(0, deltaSeconds));

  if (policy.type === "cooldown" && !armed && cooldownRemaining <= 0) armed = true;
  if (policy.type === "rearm-on-exit" && !armed && input.exited) armed = true;
  if (policy.type === "every-time") armed = true;

  const fire = armed && input.conditionFired;
  if (fire) {
    if (policy.type === "once" || policy.type === "rearm-on-exit") armed = false;
    if (policy.type === "cooldown") {
      armed = false;
      cooldownRemaining = Math.max(0, policy.seconds);
    }
  }

  return {
    state: { armed, cooldownRemaining, firedCount: state.firedCount + (fire ? 1 : 0) },
    fire
  };
}
