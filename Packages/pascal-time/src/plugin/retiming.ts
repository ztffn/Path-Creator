// Whole-track retiming: what dragging or resizing a track's block on the lane editor means, for
// transform tracks and for dolly runs. Move = shift every key by the same delta; resize = scale
// key times about the block's start, INCLUDING each tangent handle's time component — a handle is
// a real (Δtime, Δvalue) control point, and leaving Δtime unscaled would reshape every curve as a
// side effect of retiming. Pure functions returning new arrays: Pascal's undo snapshot aliases the
// old ones (the measured in-place-mutation hazard), so nothing here may mutate.
import type { PersistedTrack } from "./tracks";

type TransformTrack = Extract<PersistedTrack, { type: "transform" }>;
type CartTrack = Extract<PersistedTrack, { type: "cart" }>;
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

/** First and last key time of a dolly run, or null when it has no keys. */
export function cartTrackSpan(track: CartTrack): { start: number; end: number } | null {
  if (track.keys.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const key of track.keys) {
    if (key.time < start) start = key.time;
    if (key.time > end) end = key.time;
  }
  return { start, end };
}

/**
 * A dolly run mapped onto `[newStart, newEnd]` — dragging or resizing its block on the lane.
 *
 * DISTANCES are untouched, and that is the point: retiming a run changes when the cart is where,
 * never where it goes. Resizing therefore changes the cart's speed, which is exactly what
 * dragging a move's edge means on a dolly lane. No tangents to scale here — a cart key's shape is
 * a whole `Easing`, and an easing is expressed in normalized segment time, so it survives a
 * rescale unchanged.
 */
export function retimeCartTrack(track: CartTrack, newStart: number, newEnd: number): CartTrack {
  const span = cartTrackSpan(track);
  if (!span) return track;
  const oldSpan = span.end - span.start;
  const factor = oldSpan > 1e-9 ? Math.max(1e-9, newEnd - newStart) / oldSpan : 1;

  return {
    ...track,
    keys: track.keys.map((key) => ({
      ...key,
      time: Math.max(0, newStart + (key.time - span.start) * factor)
    }))
  };
}
