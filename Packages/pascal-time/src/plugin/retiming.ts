// Whole-track retiming: what dragging or resizing a transform track's block on the lane editor
// means. Move = shift every key on every channel by the same delta; resize = scale key times
// about the block's start, INCLUDING each tangent handle's time component — a handle is a real
// (Δtime, Δvalue) control point, and leaving Δtime unscaled would reshape every curve as a side
// effect of retiming. Pure functions returning new arrays: Pascal's undo snapshot aliases the
// old ones (the measured in-place-mutation hazard), so nothing here may mutate.
import type { PersistedTrack } from "./tracks";

type TransformTrack = Extract<PersistedTrack, { type: "transform" }>;
type Channel = NonNullable<TransformTrack["position"]>;
type ChannelKey = Channel[number];

/** First and last key time across all three channels, or null when the track has no keys. */
export function transformTrackSpan(track: TransformTrack): { start: number; end: number } | null {
  let start = Infinity;
  let end = -Infinity;
  for (const channel of [track.position, track.rotation, track.scale]) {
    for (const key of channel ?? []) {
      if (key.time < start) start = key.time;
      if (key.time > end) end = key.time;
    }
  }
  return Number.isFinite(start) ? { start, end } : null;
}

const scaleTangents = (
  tangents: ChannelKey["tangentsAxes"],
  factor: number
): ChannelKey["tangentsAxes"] => {
  if (!tangents || factor === 1) return tangents;
  return tangents.map((axis) => {
    if (!axis) return axis;
    return {
      ...(axis.in ? { in: [axis.in[0] * factor, axis.in[1]] as [number, number] } : {}),
      ...(axis.out ? { out: [axis.out[0] * factor, axis.out[1]] as [number, number] } : {})
    };
  }) as ChannelKey["tangentsAxes"];
};

/**
 * The track with its keys mapped onto `[newStart, newEnd]`: a pure shift when the target span
 * matches the current one, a shift-and-scale otherwise. A single-key track (zero span) only
 * shifts — there is nothing to scale. Times clamp at zero; key ORDER is preserved because the
 * mapping is affine with a positive factor.
 */
export function retimeTransformTrack(
  track: TransformTrack,
  newStart: number,
  newEnd: number
): TransformTrack {
  const span = transformTrackSpan(track);
  if (!span) return track;
  const oldSpan = span.end - span.start;
  const factor = oldSpan > 1e-9 ? Math.max(1e-9, newEnd - newStart) / oldSpan : 1;

  const mapChannel = (channel: Channel | undefined): Channel | undefined =>
    channel?.map((key) => ({
      ...key,
      time: Math.max(0, newStart + (key.time - span.start) * factor),
      ...(key.tangentsAxes ? { tangentsAxes: scaleTangents(key.tangentsAxes, factor) } : {})
    }));

  return {
    ...track,
    ...(track.position ? { position: mapChannel(track.position) } : {}),
    ...(track.rotation ? { rotation: mapChannel(track.rotation) } : {}),
    ...(track.scale ? { scale: mapChannel(track.scale) } : {})
  };
}
