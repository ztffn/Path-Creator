// Lane box arithmetic for TimelineLanes, kept out of the component so it can be
// tested without a DOM. The height of the rail and the height of the embedded
// editor are the SAME number — they scroll in lockstep, and a mismatch shows up
// as icons drifting away from the rows they label. One function owns it so the
// two call sites cannot disagree, and so the visible-lane cap can be a host
// decision instead of a module constant.

/** The embedded editor's time ruler: its own height plus the gap before row one. */
export const RULER_HEIGHT = 42;
/** Row pitch, shared by the rail icons and the editor's `rowHeight`. */
export const LANE_HEIGHT = 36;
/**
 * Lanes visible before the lane area scrolls. Three keeps a tall camera show from
 * eating the editing viewport; a host with room for more (one lane per animated
 * element, say) passes its own.
 */
export const DEFAULT_MAX_VISIBLE_LANES = 3;

export interface LaneCounts {
  /** The always-on shot track. False for hosts that only use extra lanes. */
  shotLane: boolean;
  dollyLanes: number;
  extraLanes: number;
  /** Defaults to DEFAULT_MAX_VISIBLE_LANES. Clamped to at least one lane. */
  maxVisibleLanes?: number;
}

export interface LaneLayout {
  laneCount: number;
  /** Full content height: what both the rail and the editor are sized to. */
  contentHeight: number;
  /** Cap on the scroll viewport. */
  maxHeight: number;
  /** Whether the content exceeds the cap, so the ruler scrolls out of view. */
  scrolls: boolean;
}

export function laneLayout({
  shotLane,
  dollyLanes,
  extraLanes,
  maxVisibleLanes = DEFAULT_MAX_VISIBLE_LANES
}: LaneCounts): LaneLayout {
  const laneCount = (shotLane ? 1 : 0) + dollyLanes + extraLanes;
  const visible = Math.max(1, Math.floor(maxVisibleLanes));
  const contentHeight = RULER_HEIGHT + laneCount * LANE_HEIGHT;
  return {
    laneCount,
    contentHeight,
    maxHeight: RULER_HEIGHT + visible * LANE_HEIGHT,
    scrolls: laneCount > visible
  };
}
