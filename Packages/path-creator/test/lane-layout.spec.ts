import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_VISIBLE_LANES,
  LANE_HEIGHT,
  RULER_HEIGHT,
  laneLayout
} from "../src/timeline-ui/lane-layout";

describe("lane layout", () => {
  it("counts the shot lane only when it is shown", () => {
    expect(laneLayout({ shotLane: true, dollyLanes: 2, extraLanes: 1 }).laneCount).toBe(4);
    expect(laneLayout({ shotLane: false, dollyLanes: 2, extraLanes: 1 }).laneCount).toBe(3);
  });

  it("sizes the rail and the editor to the same content height", () => {
    // The two are separate DOM nodes scrolling in lockstep; one number for both is
    // the whole reason this function exists.
    const layout = laneLayout({ shotLane: true, dollyLanes: 0, extraLanes: 11 });
    expect(layout.contentHeight).toBe(RULER_HEIGHT + 12 * LANE_HEIGHT);
  });

  it("defaults to the three-lane cap and reports that a tall show scrolls", () => {
    const capped = laneLayout({ shotLane: false, dollyLanes: 0, extraLanes: 12 });
    expect(capped.maxHeight).toBe(RULER_HEIGHT + DEFAULT_MAX_VISIBLE_LANES * LANE_HEIGHT);
    expect(capped.scrolls).toBe(true);
  });

  it("lets a host show every lane, which is what stops the ruler scrolling away", () => {
    const full = laneLayout({ shotLane: false, dollyLanes: 0, extraLanes: 12, maxVisibleLanes: 12 });
    expect(full.maxHeight).toBe(full.contentHeight);
    expect(full.scrolls).toBe(false);
  });

  it("never collapses to a lane-less viewport", () => {
    expect(laneLayout({ shotLane: true, dollyLanes: 0, extraLanes: 0, maxVisibleLanes: 0 }).maxHeight)
      .toBe(RULER_HEIGHT + LANE_HEIGHT);
  });
});
