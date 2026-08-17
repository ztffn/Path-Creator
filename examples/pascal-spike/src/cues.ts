// Slides as timestamps. A presentation is ONE timeline; a "slide" is a named cue on it, and
// "next slide" is not a cut but a ride — the clock itself is animated from where it is to where
// the cue sits. Because the timeline is a pure function of t, animating t moves the camera,
// the models and everything else for free, with no separate transition system.
// Scope: prototype product layer; this is the piece with a promotion path into /timeline.
import { evaluateEasing, type Easing } from "@huma/path-creator/core";
import { seekTimelinePlayer, type TimelinePlayer } from "@huma/path-creator/timeline";

/** A named point on the timeline. The product calls these slides. */
export interface Cue {
  id: string;
  name: string;
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

const sorted = (cues: readonly Cue[]): Cue[] => [...cues].sort((a, b) => a.time - b.time);

/** The cue at or before `time` — which slide are we on. */
export function currentCue(cues: readonly Cue[], time: number, epsilon = 1e-3): Cue | null {
  let found: Cue | null = null;
  for (const cue of sorted(cues)) {
    if (cue.time <= time + epsilon) found = cue;
    else break;
  }
  return found;
}

/** The next cue strictly after `time`, or null at the end. */
export function nextCue(cues: readonly Cue[], time: number, epsilon = 1e-3): Cue | null {
  for (const cue of sorted(cues)) if (cue.time > time + epsilon) return cue;
  return null;
}

/** The cue strictly before `time`, or null at the start. */
export function previousCue(cues: readonly Cue[], time: number, epsilon = 1e-3): Cue | null {
  let found: Cue | null = null;
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
 * Start riding the clock to `targetTime`. Replaces any ride in flight, starting from wherever
 * the clock is NOW rather than from the previous ride's origin — so pressing next twice mid-ride
 * accelerates through rather than snapping backwards.
 */
export function rideTo(
  transport: CueTransport,
  player: TimelinePlayer,
  targetTime: number,
  options: RideOptions = {}
): void {
  const seconds = Math.max(0, options.seconds ?? 1.6);
  if (seconds === 0) {
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
 * Advance a ride in flight. Returns true while riding, so the caller knows to skip its normal
 * playback step — a ride owns the clock for its duration. Seeks rather than plays, because
 * arriving at a cue must be scrub-exact and must not fire the events it passed over.
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
    seekTimelinePlayer(player, ride.to);
    transport.transition = null;
    return false;
  }
  return true;
}

/** Convenience: ride to the next/previous cue, or do nothing at the ends. */
export function rideToNext(
  transport: CueTransport, player: TimelinePlayer, cues: readonly Cue[], options?: RideOptions
): Cue | null {
  const cue = nextCue(cues, player.time);
  if (cue) rideTo(transport, player, cue.time, options);
  return cue;
}

export function rideToPrevious(
  transport: CueTransport, player: TimelinePlayer, cues: readonly Cue[], options?: RideOptions
): Cue | null {
  const cue = previousCue(cues, player.time);
  if (cue) rideTo(transport, player, cue.time, options);
  return cue;
}
