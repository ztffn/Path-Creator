// Cues and the ride between them. The ride is the whole "next slide" interaction of any
// narrative product built on this library, so the edges are the contract: arriving exactly on
// the number, replacing a ride in flight from the CURRENT clock rather than the old origin,
// treating zero duration as a cut, and never firing the events it passed over.
// Promoted from the elastiq spike with the edge coverage the implementation plan names.
import { describe, expect, it } from "vitest";
import { createTimeline } from "../src/core";
import {
  createCueTransport,
  createTimelinePlayer,
  currentCue,
  nextCue,
  previousCue,
  rideTo,
  rideToCue,
  rideToNext,
  rideToPrevious,
  stepCueTransport,
  stepTimelinePlayer,
  type Cue
} from "../src/timeline";

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

  it("has no cue before the first one", () => {
    expect(currentCue(CUES, -1)).toBeNull();
    expect(currentCue([], 5)).toBeNull();
  });

  it("walks forward and back, and reports the ends", () => {
    expect(nextCue(CUES, 0)?.id).toBe("turbine");
    expect(nextCue(CUES, 9)).toBeNull();
    expect(previousCue(CUES, 9)?.id).toBe("turbine");
    expect(previousCue(CUES, 0)).toBeNull();
  });

  it("does not depend on the cues being given in order", () => {
    // Cues are addressed by time. Authoring order, document order and array order are all
    // accidents of how they were written down.
    const shuffled = [CUES[2]!, CUES[0]!, CUES[1]!];
    expect(nextCue(shuffled, 0)?.id).toBe("turbine");
    expect(currentCue(shuffled, 5)?.id).toBe("turbine");
    expect(previousCue(shuffled, 9)?.id).toBe("turbine");
  });

  it("treats a cue you just landed on as current, not as one still ahead", () => {
    // A ride lands by floating-point arithmetic. Without the epsilon, arriving at 4 could
    // leave `currentCue` reporting the previous slide and the deck showing the wrong title.
    expect(currentCue(CUES, 4 - 1e-9)?.id).toBe("turbine");
    expect(nextCue(CUES, 4 - 1e-9)?.id).toBe("detail");
  });

  it("keeps whatever extra fields a product hangs on its cues", () => {
    // Products carry their own per-cue data (a render mode, a permission set, a slide id).
    // The lookup helpers must hand that back, not launder it into a bare Cue.
    interface SlideCue extends Cue {
      renderMode: "polished" | "reading";
    }
    const slides: SlideCue[] = [
      { id: "a", name: "A", time: 0, renderMode: "polished" },
      { id: "b", name: "B", time: 5, renderMode: "reading" }
    ];
    expect(currentCue(slides, 6)?.renderMode).toBe("reading");
    expect(nextCue(slides, 0)?.renderMode).toBe("reading");
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

  it("reversing mid-ride turns around from where it is, not from the destination", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    rideTo(transport, player, 10, { seconds: 2, easing: "linear" });
    stepCueTransport(transport, player, 1); // t = 5, heading up

    rideTo(transport, player, 0, { seconds: 1, easing: "linear" });
    expect(transport.transition?.from).toBeCloseTo(5, 6);
    stepCueTransport(transport, player, 0.5);
    expect(player.time).toBeCloseTo(2.5, 6);
  });

  it("zero duration is an immediate seek, not a divide by zero", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    rideTo(transport, player, 7, { seconds: 0 });
    expect(player.time).toBe(7);
    expect(transport.transition).toBeNull();
    expect(stepCueTransport(transport, player, 0.016)).toBe(false);
  });

  it("never seeks below zero, however the ride is aimed", () => {
    const player = createTimelinePlayer({ time: 2 });
    const transport = createCueTransport();
    rideTo(transport, player, -5, { seconds: 1, easing: "linear" });
    stepCueTransport(transport, player, 1);
    expect(player.time).toBe(0);
  });

  it("stepping an idle transport is a no-op that reports it is not riding", () => {
    const player = createTimelinePlayer({ time: 3 });
    const transport = createCueTransport();
    expect(stepCueTransport(transport, player, 0.016)).toBe(false);
    expect(player.time).toBe(3);
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

  it("rideToPrevious walks back and stops at the start", () => {
    const player = createTimelinePlayer({ time: 9 });
    const transport = createCueTransport();
    expect(rideToPrevious(transport, player, CUES, { seconds: 0 })?.id).toBe("turbine");
    expect(rideToPrevious(transport, player, CUES, { seconds: 0 })?.id).toBe("intro");
    expect(rideToPrevious(transport, player, CUES, { seconds: 0 })).toBeNull();
    expect(player.time).toBe(0);
  });

  it("rideToCue jumps by id, and reports an id no cue has", () => {
    // Branching navigation addresses a cue directly rather than stepping — a hotspot click or
    // a graph edge names where it goes.
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    expect(rideToCue(transport, player, CUES, "detail", { seconds: 0 })?.id).toBe("detail");
    expect(player.time).toBe(9);
    expect(rideToCue(transport, player, CUES, "nope", { seconds: 0 })).toBeNull();
    expect(player.time).toBe(9); // unmoved
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

  it("is a pure function of the steps taken, not of how they were divided", () => {
    // Determinism again, at the transport level: the same total delta must land in the same
    // place however many frames it arrived in, or a slow client and a fast one see different
    // journeys — which is the room's consensus problem in miniature.
    const ride = (deltas: number[]): number => {
      const player = createTimelinePlayer();
      const transport = createCueTransport();
      rideTo(transport, player, 10, { seconds: 1 });
      for (const delta of deltas) stepCueTransport(transport, player, delta);
      return player.time;
    };
    expect(ride([0.5])).toBeCloseTo(ride([0.25, 0.25]), 9);
    expect(ride([0.5])).toBeCloseTo(ride([0.1, 0.1, 0.1, 0.1, 0.1]), 9);
  });
});

describe("a ride is navigation, not playback", () => {
  it("does not fire the events it passes over", () => {
    // Playing through an event fires it; arriving at a cue past it must not. Otherwise
    // skipping to slide 5 would trigger every sound and trigger between here and there.
    const timeline = createTimeline({
      duration: 10,
      tracks: [
        {
          type: "event",
          id: "events",
          events: [
            { id: "bang", time: 2 },
            { id: "crash", time: 5 }
          ]
        }
      ]
    });

    const played = createTimelinePlayer({ playing: true });
    expect(stepTimelinePlayer(played, timeline, 6).map((event) => event.id)).toEqual([
      "bang",
      "crash"
    ]);

    const ridden = createTimelinePlayer();
    const transport = createCueTransport();
    rideTo(transport, ridden, 6, { seconds: 0 });
    expect(ridden.time).toBe(6);
    // The ride moved the clock past both events and fired neither, because it seeks.
    expect(stepTimelinePlayer(ridden, timeline, 0).length).toBe(0);
  });
});
