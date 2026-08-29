// Multi-clip selection and the edits that act on a whole set: what is selected, how a
// click changes it, and the uniform-delta arithmetic behind dragging, nudging and
// rippling several clips at once. Pure and DOM-free so the semantics are testable —
// the component contributes the gestures, and the host still owns every write.
// Selection is expressed in the same composite key the lane editor uses for an action.

/** Identifies one clip on one extra lane. */
export interface ExtraClipRef {
  laneId: string;
  clipId: string;
}

/** A clip and where it is being moved to, in seconds. */
export interface ExtraClipMove extends ExtraClipRef {
  start: number;
  end: number;
}

/**
 * The key a selection is expressed in. Same shape as the lane editor's action id, so a
 * click on a block and an entry in `selectedClipKeys` are the same string by construction
 * rather than by two functions that have to agree.
 */
export function extraClipKey(laneId: string, clipId: string): string {
  return `x|${laneId}|${clipId}`;
}

export function parseExtraClipKey(key: string): ExtraClipRef | null {
  if (!key.startsWith("x|")) return null;
  const separator = key.indexOf("|", 2);
  return separator < 0 ? null : { laneId: key.slice(2, separator), clipId: key.slice(separator + 1) };
}

/**
 * What a click does to the selection. A plain click replaces it; an additive click
 * (shift or meta) toggles one member. Toggling OFF the clip you just grabbed would make
 * a shift-drag deselect what it is about to move, so a caller that is starting a drag
 * passes `additive: false` for a clip already in the set — see `selectionForDrag`.
 */
export function toggleSelection(
  keys: readonly string[],
  key: string,
  additive: boolean
): string[] {
  if (!additive) return [key];
  return keys.includes(key) ? keys.filter((existing) => existing !== key) : [...keys, key];
}

/**
 * The selection a drag should act on. Grabbing a clip that is already selected keeps the
 * whole set (that is how you move several at once); grabbing one outside the set replaces
 * it, because dragging an unselected clip must never drag things you cannot see selected.
 */
export function selectionForDrag(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? [...keys] : [key];
}

/**
 * Shift every clip by the same amount, clamped so the earliest one stops at zero rather
 * than the group tearing apart against the left edge. Spacing is preserved: a selection
 * moves as a rigid body, which is the only reading under which "adjust them all" leaves
 * the animation recognisable.
 */
export function shiftClips(clips: readonly ExtraClipMove[], deltaSeconds: number): ExtraClipMove[] {
  if (clips.length === 0) return [];
  const earliest = clips.reduce((lowest, clip) => Math.min(lowest, clip.start), Infinity);
  const delta = Math.max(deltaSeconds, -earliest);
  return clips.map((clip) => ({ ...clip, start: clip.start + delta, end: clip.end + delta }));
}

/**
 * Insert (or, with a negative delta, remove) time at a point: every clip that STARTS at
 * or after it shifts, and everything before it stays put. A clip straddling the point is
 * left alone rather than stretched — a ripple moves things in time, it does not retime
 * them, and stretching one clip in a ripple is how a timeline silently loses a duration
 * somebody tuned.
 */
export function rippleClips(
  clips: readonly ExtraClipMove[],
  atSeconds: number,
  deltaSeconds: number
): ExtraClipMove[] {
  const affected = clips.filter((clip) => clip.start >= atSeconds - 1e-9);
  return shiftClips(affected, deltaSeconds);
}

/** Round a set of moves onto the editor's grid, preserving each clip's own length. */
export function snapMoves(moves: readonly ExtraClipMove[], snapSeconds: number): ExtraClipMove[] {
  if (snapSeconds <= 0) return moves.map((move) => ({ ...move }));
  return moves.map((move) => {
    const start = Math.max(0, Math.round(move.start / snapSeconds) * snapSeconds);
    return { ...move, start, end: start + (move.end - move.start) };
  });
}
