// The stateful clock the pure evaluator does not have: a plain {time, playing, rate, loop}
// record plus the two operations that never need to know what a Timeline contains — create and
// seek. Kept apart from index.ts so things that ride the clock (cues) can depend on the player
// without depending on evaluation, which would be a cycle. `stepTimelinePlayer` stays in
// index.ts because advancing the clock fires events, and events need the timeline.
export interface TimelinePlayer {
  time: number;
  playing: boolean;
  rate: number;
  loop: boolean;
}

export function createTimelinePlayer(init: Partial<TimelinePlayer> = {}): TimelinePlayer {
  return {
    time: init.time ?? 0,
    playing: init.playing ?? false,
    rate: init.rate ?? 1,
    loop: init.loop ?? false
  };
}

/** Jumps the clock without firing events (scrub semantics). */
export function seekTimelinePlayer(player: TimelinePlayer, timeSeconds: number): void {
  player.time = Math.max(0, timeSeconds);
}
