// The transport's contract: who may move the clock, what "driving" means, and the exact frame
// playback stops on. These are the semantics the activation director keys off (playing=false AT
// the duration is "playback finished"; the same time reached by scrubbing is not), so they are
// pinned here rather than implied by the driver. Pure store logic — no Pascal, no React.
// Scope: src/transport/store.ts. The end-to-end proof lives in the editor-host browser check.
import { beforeEach, describe, expect, it } from "vitest";
import { pascalTimeTransport } from "../src/transport/store";

const t = () => pascalTimeTransport.getState();

beforeEach(() => {
  pascalTimeTransport.setState({
    timelineId: null,
    time: 0,
    playing: false,
    driving: false,
    preview: true,
    rate: 1
  });
});

describe("pointing the transport at a timeline", () => {
  it("starts parked: no subject, no clock, not driving", () => {
    expect(t()).toMatchObject({ timelineId: null, time: 0, playing: false, driving: false });
  });

  it("a new subject is a new session — clock and flags reset", () => {
    t().setTimeline("clock_a");
    t().play();
    t().seek(5);
    t().setTimeline("clock_b");
    expect(t()).toMatchObject({ timelineId: "clock_b", time: 0, playing: false, driving: false });
  });

  it("re-pointing at the SAME subject changes nothing — panels re-render freely", () => {
    t().setTimeline("clock_a");
    t().seek(5);
    t().setTimeline("clock_a");
    expect(t().time).toBe(5);
    expect(t().driving).toBe(true);
  });

  it("play and seek are inert with no subject — nothing can own a scene it cannot name", () => {
    t().play();
    t().seek(3);
    expect(t()).toMatchObject({ time: 0, playing: false, driving: false });
  });
});

describe("ownership (driving)", () => {
  beforeEach(() => t().setTimeline("clock"));

  it("play takes ownership", () => {
    t().play();
    expect(t()).toMatchObject({ playing: true, driving: true });
  });

  it("scrubbing takes ownership without starting the clock", () => {
    t().seek(2.5);
    expect(t()).toMatchObject({ time: 2.5, playing: false, driving: true });
  });

  it("pause holds the scene — still driving, clock stopped", () => {
    t().play();
    t().pause();
    expect(t()).toMatchObject({ playing: false, driving: true });
  });

  it("release gives the scene back but keeps the clock position for a re-engage", () => {
    t().play();
    t().seek(4);
    t().release();
    expect(t()).toMatchObject({ time: 4, playing: false, driving: false });
  });

  it("a scrub never goes below zero", () => {
    t().seek(-1);
    expect(t().time).toBe(0);
  });
});

describe("preview versus edit mode", () => {
  beforeEach(() => t().setTimeline("clock"));

  it("edit mode parks the playhead WITHOUT owning the scene — pose-then-key needs this", () => {
    t().setPreview(false);
    t().seek(3);
    expect(t()).toMatchObject({ time: 3, driving: false, playing: false });
  });

  it("leaving preview releases the scene and stops playback", () => {
    t().play();
    t().setPreview(false);
    expect(t()).toMatchObject({ preview: false, driving: false, playing: false });
  });

  it("re-entering preview re-takes ownership at the parked time", () => {
    t().setPreview(false);
    t().seek(3);
    t().setPreview(true);
    expect(t()).toMatchObject({ time: 3, driving: true, playing: false });
  });

  it("play is always a preview — pressing it in edit mode switches back", () => {
    t().setPreview(false);
    t().play();
    expect(t()).toMatchObject({ preview: true, playing: true, driving: true });
  });

  it("preview on with no subject cannot take ownership of anything", () => {
    t().setTimeline(null);
    t().setPreview(false);
    t().setPreview(true);
    expect(t().driving).toBe(false);
  });
});

describe("advancing the clock", () => {
  beforeEach(() => {
    t().setTimeline("clock");
    t().play();
  });

  it("accumulates deltas while playing", () => {
    t().advance(0.5, 10, false);
    t().advance(0.25, 10, false);
    expect(t().time).toBeCloseTo(0.75);
  });

  it("does nothing while paused — the panel's scrub position is not fought over", () => {
    t().pause();
    t().advance(1, 10, false);
    expect(t().time).toBe(0);
  });

  it("stops EXACTLY at the duration, playing=false on that frame — the 'finished' signal", () => {
    t().seek(9.9);
    t().play();
    t().advance(0.5, 10, false);
    expect(t()).toMatchObject({ time: 10, playing: false, driving: true });
  });

  it("wraps when the timeline loops, and keeps playing", () => {
    t().seek(9.5);
    t().play();
    t().advance(1, 10, true);
    expect(t().time).toBeCloseTo(0.5);
    expect(t().playing).toBe(true);
  });

  it("a zero-duration timeline cannot play — parked at 0 rather than dividing by it", () => {
    t().advance(1, 0, true);
    expect(t()).toMatchObject({ time: 0, playing: false });
  });

  it("rate scales advancing only — a scrub is rate-blind", () => {
    t().setRate(0.5);
    t().advance(1, 10, false);
    expect(t().time).toBeCloseTo(0.5);
    t().seek(4);
    expect(t().time).toBe(4);
  });

  it("a rate of zero or below is refused — the clock only runs forward", () => {
    t().setRate(0);
    t().setRate(-1);
    expect(t().rate).toBe(1);
  });
});
