// Cues: named timestamps on a timeline, and the transport that rides the clock between them.
// A cue is an address, not a segment — the whole point is that "go to the next one" is not a cut
// but an animation OF `t` itself, so the camera, the transforms, the visibility and the audio all
// follow from one number with no separate transition system to build or keep in sync.
// Scope: pure data and pure stepping. Nothing here touches an Object3D or a scene.
import { evaluateEasing, type Easing } from "../core";
import { seekTimelinePlayer, type TimelinePlayer } from "./player";

/**
 * A named point on the timeline. Products with a narrative call these slides, chapters or
 * steps; they are the same thing at different granularities, which is why this carries no
 * notion of which it is.
 *
 * It has no duration. A cue does not own the stretch of time after it — the next cue starts
 * where it starts, and the gap between them is whatever the timeline does there.
 */
export interface Cue {
  id: string;
  name: string;
  /** Seconds on the timeline. The only thing that orders cues; declaration order is ignored. */
  time: number;
}

export interface CueTransition {
  from: number;
  to: number;
  elapsed: number;
  seconds: number;
  easing: Easing;
}

export interface CueTransport {
  /** Null when the clock is not being ridden anywhere. */
  transition: CueTransition | null;
}

export const createCueTransport = (): CueTransport => ({ transition: null });

/** Cues are addressed by time, never by position in the array. */
const sorted = <T extends Cue>(cues: readonly T[]): T[] => [...cues].sort((a, b) => a.time - b.time);

/**
 * The cue at or before `time` — "which slide are we on".
 *
 * `epsilon` exists because a ride lands on a cue by floating-point arithmetic, and a cue you
 * arrived at must read as current rather than as one you have not reached yet.
 */
export function currentCue<T extends Cue>(cues: readonly T[], time: number, epsilon = 1e-3): T | null {
  let found: T | null = null;
  for (const cue of sorted(cues)) {
    if (cue.time <= time + epsilon) found = cue;
    else break;
  }
  return found;
}

/** The next cue strictly after `time`, or null at the end. */
export function nextCue<T extends Cue>(cues: readonly T[], time: number, epsilon = 1e-3): T | null {
  for (const cue of sorted(cues)) if (cue.time > time + epsilon) return cue;
  return null;
}

/** The cue strictly before `time`, or null at the start. */
export function previousCue<T extends Cue>(cues: readonly T[], time: number, epsilon = 1e-3): T | null {
  let found: T | null = null;
  for (const cue of sorted(cues)) {
    if (cue.time < time - epsilon) found = cue;
    else break;
  }
  return found;
}

export interface RideOptions {
  seconds?: number;
  easing?: Easing;
}

/**
 * Start riding the clock to `targetTime`.
 *
 * Replaces any ride in flight, starting from wherever the clock is **now** rather than from the
 * previous ride's origin — so pressing next twice mid-ride accelerates onward instead of
 * snapping backwards and re-travelling ground the viewer already saw.
 */
export function rideTo(
  transport: CueTransport,
  player: TimelinePlayer,
  targetTime: number,
  options: RideOptions = {}
): void {
  const seconds = Math.max(0, options.seconds ?? 1.6);
  if (seconds === 0) {
    // Not a degenerate ride — a deliberate cut. Seeking directly also keeps the step function
    // free of a divide by zero it would otherwise have to guard on every frame.
    transport.transition = null;
    seekTimelinePlayer(player, targetTime);
    return;
  }
  transport.transition = {
    from: player.time,
    to: Math.max(0, targetTime),
    elapsed: 0,
    seconds,
    easing: options.easing ?? "easeInOut"
  };
}

/**
 * Advance a ride in flight. Returns true while riding, so a host knows to skip its normal
 * playback step — a ride owns the clock for its duration.
 *
 * It seeks rather than plays, because arriving at a cue must be scrub-exact and must not fire
 * the events it passed over on the way. A ride is navigation, not playback.
 */
export function stepCueTransport(
  transport: CueTransport,
  player: TimelinePlayer,
  deltaSeconds: number
): boolean {
  const ride = transport.transition;
  if (!ride) return false;

  ride.elapsed += Math.max(0, deltaSeconds);
  const raw = ride.seconds > 0 ? Math.min(1, ride.elapsed / ride.seconds) : 1;
  const eased = evaluateEasing(raw, ride.easing);
  seekTimelinePlayer(player, ride.from + (ride.to - ride.from) * eased);

  if (raw >= 1) {
    // Land on the number, not near it: an eased curve evaluated at 1 is not bit-identical to
    // the target, and a cue you stopped 3 milliseconds short of is a cue you are not on.
    seekTimelinePlayer(player, ride.to);
    transport.transition = null;
    return false;
  }
  return true;
}

/** Ride to the next cue, or do nothing at the end. Returns the cue ridden to. */
export function rideToNext<T extends Cue>(
  transport: CueTransport,
  player: TimelinePlayer,
  cues: readonly T[],
  options?: RideOptions
): T | null {
  const cue = nextCue(cues, player.time);
  if (cue) rideTo(transport, player, cue.time, options);
  return cue;
}

/** Ride to the previous cue, or do nothing at the start. */
export function rideToPrevious<T extends Cue>(
  transport: CueTransport,
  player: TimelinePlayer,
  cues: readonly T[],
  options?: RideOptions
): T | null {
  const cue = previousCue(cues, player.time);
  if (cue) rideTo(transport, player, cue.time, options);
  return cue;
}

/** Ride to a cue by id. Returns the cue, or null when no cue has that id. */
export function rideToCue<T extends Cue>(
  transport: CueTransport,
  player: TimelinePlayer,
  cues: readonly T[],
  cueId: string,
  options?: RideOptions
): T | null {
  const cue = cues.find((candidate) => candidate.id === cueId) ?? null;
  if (cue) rideTo(transport, player, cue.time, options);
  return cue;
}
