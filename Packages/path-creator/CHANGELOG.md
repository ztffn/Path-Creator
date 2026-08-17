# Changelog

All notable changes to `@huma/path-creator` are documented here.

## Unreleased

### Added

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
