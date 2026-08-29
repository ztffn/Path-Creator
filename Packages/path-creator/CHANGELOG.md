# Changelog

All notable changes to `@huma/path-creator` are documented here.

## Unreleased

### Added

- **Multi-clip selection and group editing in `TimelineLanes`.** Timing many lanes meant
  moving one block at a time, which is the wrong unit of work for anything with more lanes
  than a camera show has shots.

  - `selectedClipKeys` / `onSelectClips` — a selection across lanes, keyed by
    `extraClipKey(laneId, clipId)`. Built by rubber-banding across empty track, shift- or
    meta-clicking a block, clicking empty track to clear, or Escape.
  - `onExtraClipsTiming` — one callback per GESTURE rather than per clip. Dragging any
    member of a selection moves the whole set by a single delta with the gaps preserved,
    and it arrives as one write, so a nine-block move is one undo step rather than nine.
    `onExtraClipTiming` still works and still receives single moves when this is absent.
  - `nudgeSeconds` — arrow-key step for the selection, defaulting to `snapSeconds`; shift
    multiplies by ten.
  - Exported pure helpers so a host can do the same arithmetic outside a gesture:
    `shiftClips`, `rippleClips` (insert or remove time at a point — everything starting at
    or after it moves, and a clip straddling it is left alone rather than stretched),
    `snapMoves`, `toggleSelection`, `selectionForDrag`, `extraClipKey`, `parseExtraClipKey`.
  - Selected blocks carry `data-clip-selected`, distinct from the existing `data-selected`,
    which is an OR of clip and lane selection and cannot tell the two apart.

  Two behaviours worth knowing because they were bugs first. A drag ends in a click on the
  block dragged, which reads as "select just this one" and collapses the set — so that one
  click is suppressed, and the suppression is cleared by the next mousedown so it cannot
  outlive its gesture. And the arrow-key listener is attached through a CALLBACK ref rather
  than `useRef` plus an empty-dependency effect: StrictMode's simulated remount detaches
  refs around the effect re-run, so the effect could find a null node and attach nothing,
  leaving the keys dead until a reload.

- **`TimelineLanes` works without a camera** (`@huma/path-creator/timeline-ui`). Three props
  turn what was a shot editor with optional extra lanes into a general multi-track editor,
  and the shot half of the API is now optional (`shots`, `dollies`, `dollyMoves`,
  `selectedShotId` and their seven callbacks all default to empty/no-op):

  - `showShotLane` (default `true`) — a host whose show is entirely extra lanes no longer
    carries a permanently empty shot row.
  - `maxVisibleLanes` (default `3`) — the cap that protects a 3D editing viewport from a
    tall show was a module constant, so a host that owns the whole panel could not opt out.
    One lane per animated element hits it immediately. Note the embedded editor's time ruler
    scrolls away with the rows once the cap is exceeded, so sizing this to the lane count is
    better than scrolling.
  - `snapSeconds` (default `0.25`) — drag/resize quantum, and the minimum clip length. A
    quarter second suits a camera show and cannot express the 50-80 ms spacing of element
    timings on a title animation.

  Lane box arithmetic moved to `laneLayout` (also exported, with `RULER_HEIGHT`,
  `LANE_HEIGHT` and `DEFAULT_MAX_VISIBLE_LANES`) so the rail and the editor cannot be sized
  by two expressions that disagree. `examples/logo-timing` is the first host to use none of
  the camera surface.

- **Cues** (`@huma/path-creator/timeline`): named timestamps on a timeline, plus the
  transport that rides the clock between them. `Cue`, `currentCue`, `nextCue`,
  `previousCue`, `createCueTransport`, `rideTo`, `rideToNext`, `rideToPrevious`,
  `rideToCue`, `stepCueTransport`.

  A ride animates `t` itself rather than cutting, so the camera, the transforms, the
  visibility and the audio all follow from one number and there is no separate
  transition system to keep in sync. It seeks rather than plays, so arriving at a cue is
  scrub-exact and does not fire the events it passed over. The lookup helpers are generic
  over the cue type, so a product's own per-cue fields survive the round trip.
- `TimelinePlayer`, `createTimelinePlayer` and `seekTimelinePlayer` moved into their own
  module so cues can depend on the clock without depending on evaluation. The public
  surface is unchanged — they are still exported from `@huma/path-creator/timeline`.

- Timeline schema v4 track types for activation, audio, GLB animation, and
  keyframed object transforms.
- Pure, scrub-safe evaluators for all four track types.
- Automatic overlap crossfades for adjacent audio and animation clips.
- Three.js `ObjectBindingRegistry`, `ActivationTrackDirector`,
  `AnimationTrackDirector`, and `TransformTrackDirector` runtime utilities.
- Timeline UI crossfade wedges for host-defined audio and animation lanes.

### Changed

- RigDocument schema is now v4. Versions 1 through 3 remain readable and migrate
  additively to v4.
- The minimal demo embeds object and media tracks in its typed show timeline instead
  of writing new `x-demo-tracks` sidecars.
- Selected demo objects use the shared combined move/rotate/scale `TransformGizmo`.

### Compatibility

- The minimal demo retains import support for historical `x-demo-tracks` documents.
- Browser-specific audio decoding, GLTF loading, and editor UI remain host adapters.
