# Changelog

All notable changes to `@huma/path-creator` are documented here.

## Unreleased

### Added

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
