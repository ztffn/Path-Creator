// Tests for slides-as-timestamps: cue lookup at, before and after a time, and the ride that
// animates the clock between them. The ride is the product's whole "next slide" interaction, so
// its edges matter — arriving exactly, replacing a ride in flight from the current position
// rather than the old origin, and reporting when it has finished owning the clock.
import { describe, expect, it } from "vitest";
import { createTimelinePlayer } from "@huma/path-creator/timeline";
import {
  createCueTransport, currentCue, nextCue, previousCue,
  rideTo, rideToNext, stepCueTransport, type Cue
} from "./cues";

const CUES: Cue[] = [
  { id: "intro", name: "Intro", time: 0 },
  { id: "turbine", name: "The turbine", time: 4 },
  { id: "detail", name: "Close on the hub", time: 9 }
];

describe("cue lookup", () => {
  it("finds the cue at or before a time", () => {
    expect(currentCue(CUES, 0)?.id).toBe("intro");
    expect(currentCue(CUES, 3.9)?.id).toBe("intro");
    expect(currentCue(CUES, 4)?.id).toBe("turbine");
    expect(currentCue(CUES, 100)?.id).toBe("detail");
  });

  it("walks forward and back, and reports the ends", () => {
    expect(nextCue(CUES, 0)?.id).toBe("turbine");
    expect(nextCue(CUES, 9)).toBeNull();
    expect(previousCue(CUES, 9)?.id).toBe("turbine");
    expect(previousCue(CUES, 0)).toBeNull();
  });

  it("does not depend on the cues being given in order", () => {
    const shuffled = [CUES[2]!, CUES[0]!, CUES[1]!];
    expect(nextCue(shuffled, 0)?.id).toBe("turbine");
    expect(currentCue(shuffled, 5)?.id).toBe("turbine");
  });
});

describe("riding the clock between cues", () => {
  it("eases from where the clock is to the cue, and lands exactly", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    rideTo(transport, player, 4, { seconds: 1, easing: "linear" });

    expect(stepCueTransport(transport, player, 0.5)).toBe(true);
    expect(player.time).toBeCloseTo(2, 6); // linear, halfway
    expect(stepCueTransport(transport, player, 0.5)).toBe(false); // arrived
    expect(player.time).toBe(4); // exactly, not 3.9997
    expect(transport.transition).toBeNull();
  });

  it("overshooting the last step still lands on the cue, not past it", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    rideTo(transport, player, 9, { seconds: 1 });
    stepCueTransport(transport, player, 99);
    expect(player.time).toBe(9);
  });

  it("a new ride mid-flight starts from the current clock, not the old origin", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    rideTo(transport, player, 10, { seconds: 2, easing: "linear" });
    stepCueTransport(transport, player, 1); // halfway: t = 5
    expect(player.time).toBeCloseTo(5, 6);

    // Pressing next again must accelerate onward, never snap back to 0 and re-travel.
    rideTo(transport, player, 12, { seconds: 1, easing: "linear" });
    expect(transport.transition?.from).toBeCloseTo(5, 6);
    stepCueTransport(transport, player, 0.5);
    expect(player.time).toBeCloseTo(8.5, 6);
  });

  it("zero duration is an immediate seek, not a divide by zero", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    rideTo(transport, player, 7, { seconds: 0 });
    expect(player.time).toBe(7);
    expect(transport.transition).toBeNull();
    expect(stepCueTransport(transport, player, 0.016)).toBe(false);
  });

  it("rideToNext advances one slide and stops at the end", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    expect(rideToNext(transport, player, CUES, { seconds: 0 })?.id).toBe("turbine");
    expect(player.time).toBe(4);
    expect(rideToNext(transport, player, CUES, { seconds: 0 })?.id).toBe("detail");
    expect(player.time).toBe(9);
    expect(rideToNext(transport, player, CUES, { seconds: 0 })).toBeNull();
    expect(player.time).toBe(9); // held at the last slide
  });

  it("riding backwards works the same way", () => {
    const player = createTimelinePlayer({ time: 9 });
    const transport = createCueTransport();
    rideTo(transport, player, 4, { seconds: 1, easing: "linear" });
    stepCueTransport(transport, player, 0.5);
    expect(player.time).toBeCloseTo(6.5, 6);
    stepCueTransport(transport, player, 0.5);
    expect(player.time).toBe(4);
  });
});
