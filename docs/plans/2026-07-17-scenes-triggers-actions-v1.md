<!--
Purpose: Phased implementation plan for nested Scenes + a Triggers/Actions layer
on @huma/path-creator: scenes as self-contained, independently-editable timelines
a master can invoke, plus a reactive trigger/action runtime (proximity, markers,
click) that drives them with a camera take/blend/release handoff.
Scope: Packages/path-creator (core/timeline/three/r3f) + examples/minimal-r3f-demo.
-->

# Scenes + Triggers/Actions (nested timelines, reactive interaction layer)

## Objective

Give the presentation/inspection product two composable capabilities, designed
together and shipped in dependency order:

1. **Scenes** — promote the single show timeline into a **Story** of **Scenes**,
   where each Scene is a self-contained timeline (its own tracks, vcams, duration)
   that can be opened and edited on its own, and can be invoked to play as a unit.
2. **Triggers/Actions** — a reactive interaction layer that fires on live,
   spatial, and temporal events (proximity/collision, timeline markers, click) and
   issues actions (transport control, `playScene`, entity/media verbs), including a
   **camera take/blend/release handoff** when the invoked scene owns a camera.

The organizing principle is a hard determinism boundary: **each scene evaluates as
a pure function of its local time**; all branch, active-scene, arm-policy, and
camera-ownership state lives in a separate **reactive runtime layer** above the
pure evaluators. This preserves the scrub-safe, headless-deterministic authored
content while allowing live interactivity in present mode.

Marquee behavior to enable: a user flying a free camera approaches an object; a
proximity trigger fires; the camera blends into that object's authored scene vcam,
the scene plays all its tracks (animation + voiceover), and control blends back to
the user on completion — cancellable if the user grabs the controls (skippable).

## Context and Findings

- The timeline is already a **pure evaluator** — `evaluateTimeline`
  (`Packages/path-creator/src/timeline/index.ts:114`) is a function of `t` with no
  internal clock; the player is separate (`TimelinePlayer`
  `timeline/index.ts:183`, `createTimelinePlayer` `:190`, `seekTimelinePlayer`
  `:229`). This purity is the asset the plan must protect.
- The codebase already models **stateful post-stages over pure evaluation**, which
  is exactly the shape the new runtime layers should follow: `stepCameraOverride`
  (`three/index.ts:1544`) and `driveActivation` (`three/index.ts:1808`) mutate a
  `RigBodyState` (`three/index.ts:1387`) / `RigDriveState` (`three/index.ts:1753`)
  each frame; `driveRig` (`timeline/index.ts:373`) dispatches a per-frame
  `RigDriveIntent` (`timeline/index.ts:352`) across idle/timeline/activation.
- **Camera ownership handoff** pieces already exist: pilot override lives on the
  vcam definition (`CameraOverrideSettings` `core/virtual-camera.ts:100`, used at
  `core/virtual-camera.ts:200`), resolves via `resolveVirtualCameraDefinition`
  (`three/index.ts:574`) and `resolveCameraPivot` (`three/index.ts:1495`), and blends
  use `TimelineBlendIn` (`core/timeline.ts:21`) on `CameraBlock` (`core/timeline.ts:41`).
  `driveTimeline` (`timeline/index.ts:262`) already applies override on the active
  block and skips it mid-blend — the composition the takeover reuses.
- The **document + schema** the Story wraps: `RigDocument`
  (`Packages/path-creator/src/core/rig.ts:36`), `parseRigDocument`
  (`core/rig.ts:82`) and its version-gated migration (`core/rig.ts:87` onward);
  `TIMELINE_SCHEMA_VERSION` and the timeline types live in `core/timeline.ts`.
  Markers have a precedent in the opaque `TimelineEvent` (`core/timeline.ts:83`) /
  `EventTrack` (`core/timeline.ts:90`).
- **Track directors** the actions/scenes drive already ship from `/three`:
  `ObjectBindingRegistry` (`three/object-tracks.ts:23`), `ActivationTrackDirector`
  (`:33`), `TransformTrackDirector` (`:78`), `AnimationTrackDirector` (`:95`), and
  the audio player. Proximity needs live world positions the host owns — in the demo
  via `ActivatablesRegistry` (`examples/minimal-r3f-demo/src/activatables.tsx:31`,
  `resolve` `:48`).
- **Demo shell + persistence** to migrate: the drive loop and player
  (`examples/minimal-r3f-demo/src/App.tsx:385`, `useRigDrive` at `App.tsx:35`),
  scene assembly/serialization (`scene-io.ts:211`, `:266`, `buildShowTimeline`
  `scene-io.ts:63`), and autosave (`scene-storage.ts:17`). Extra-tracks state flows
  through `setExtraTracks` (`App.tsx:311`) — note the earlier per-channel
  functional-update hazard applies to multi-scene edits too.
- Deterministic **master-embed** of scenes via control clips (a scene mapped into a
  fixed master-time window) is intentionally **out of scope** here; invocation is
  the live branch (`playScene`) only.

## Design note — Story/Scene contract (task 1)

**Scene.** A Scene IS a `RigTimelineDefinition` — a timeline (own tracks, own
`duration`) with an id and name, referencing the document-level pools (vcams,
carts, targets) by id. Nothing scene-specific is added to the `Timeline` type.
A scene "owns the camera" iff it contains a camera track with at least one
block; this is derived from composition, never a flag.

**Story.** A Story is the ordered `RigDocument.timelines` array plus a
designated entry scene (`RigDocument.entrySceneId`, v7, optional). The entry
scene is the master/show timeline a host plays by default; every other scene is
independently loadable, editable, and invokable. Resolution goes through pure
helpers (`getScene`, `getEntryScene`, `sceneDuration`, `sceneOwnsCamera`) so no
consumer reaches into the array shape.

**Determinism contract.** A scene evaluated at a given local time is identical
regardless of history: `evaluateTimeline(scene, ctx, t)` stays a pure function
of `t` and never learns about branches, triggers, arm state, or camera
ownership. ALL of that state — the active-scene stack, per-scene local clocks,
take/release blend phase, master pause/resume — lives in a separate stateful
runtime (`SceneRuntimeState` in `/timeline`), a sibling of the existing
stateful post-stages (`stepCameraOverride`, `driveActivation`).

**Invocation.** `playScene({ sceneId, fromTime?, skippable?, blend? })` is a
live branch executed by the runtime, not authored data in the master timeline
(deterministic master-embed control clips stay out of scope). The runtime owns
one active scene at a time (a stack later if nesting is needed); invoking while
active replaces after a release. The master player pauses during a branch and
resumes on return.

**Camera handoff.** On take (scene owns a camera): freeze the caller's live
pose (the brain's live snapshot), blend it into the scene's evaluated camera
over the invocation blend (reusing `blendVirtualCameraSnapshots` + the standard
blend curves) while the scene's local clock runs. On completion (or a skippable
cancel triggered by user override input): freeze the scene's last pose and
blend back to the caller's live evaluation (master timeline at its paused
playhead, or the frozen caller pose when the base is idle), then return
control. A scene with no camera track never touches the camera; its non-camera
tracks play while the user keeps piloting.

## Design note — deterministic master-embed (Phase 1.5, pulled forward)

Scene control clips were pulled forward from "later phase" on product request
("stack scenes as blocks in one master timeline"). A `SceneTrack`
(`type: "scene"`, timeline schema v7 / rig v8) holds `SceneClip`s
`{ sceneId, start, end, offset? }`: while `start <= t < end` the referenced
scene evaluates at local time `t - start + offset`. Purely compositional and
scrub-safe — no runtime state; the live-branch counterpart remains `playScene`.
`evaluateTimeline` resolves scenes through `TimelineRigContext.getScene`
(absent ⇒ scene tracks inert) and recurses depth-1: the sub-evaluation gets no
`getScene`, so nested and self-referential embeds are inert (no cycles). The
embedded camera overrides by track order (hard cut at window edges, v1); cart
frames merge only for carts the embedded scene tracks. Non-camera tracks reach
hosts via `evaluateSceneLayers` + layered track directors (`TrackLayer` in
`/three`), merged later-wins per object. `buildRigRuntime` validates clip
`sceneId` references. Demo: one implicit "embeds" track per scene, authored as
a "Scenes" lane (click creates a clip cycling through the other scenes, whole
scene duration by default; drag/resize adjusts the window). Deferred: boundary
blends, per-clip time scale, clip delete UI.

## Design note — Triggers/Actions contract (task 11)

**Decoupling.** A `TriggerDefinition` (source + condition + arm policy) emits a
signal; an `ActionDefinition` (verb + target + params) is executed; an explicit
`TriggerBinding` (triggerId → actionId, priority) joins them n:m. The demo's v1
authoring UI creates 1:1 trigger+action+binding units, but the schema stays
general. All three live document-level on `RigDocument` (rig schema v9,
additive) — triggers are world/interaction concerns, not scene-local data.

**Sources (v1).** `proximity` (subject = live camera position vs a target/
entity position; enter radius + exit hysteresis band, edge-triggered),
`marker` (a scene's `EventTrack` events, fired on forward PLAYBACK crossings
only — never on scrub/seek), `click` (a bound object clicked in present mode).

**Arm policies.** `once`, `rearm-on-exit` (proximity default), `every-time`,
`cooldown` (seconds) — expressed as pure reducers over per-trigger state, no
timers or side effects.

**Actions (v1 verbs).** `playScene` (sceneId, skippable, blend — executed by
the Phase-1 scene runtime), `transport` (play/pause/seek on the master player),
`setActive` (entity show/hide).

**Determinism boundary.** Definitions + predicates + reducers are pure `/core`
data and functions. ALL armed/fired/hysteresis/cooldown state lives in a
stateful trigger runtime (`/timeline`), a sibling of the scene runtime: it
consumes a per-frame world snapshot (camera position, entity resolver, playback
clock windows, clicks) and emits a command list the host executes. Triggers run
in present mode only and are inert during authoring scrub; a simulate
affordance fires a binding manually from the editor. Conflicts: one `playScene`
per frame (highest binding priority wins); other verbs all execute.

## Implementation Plan

### Phase 1 — Scene foundation (own landable, verified unit)

- [x] 1. Write the Story/Scene design note (contract, no code) into this plan or a
  short sibling doc: define a Scene as a timeline with its own tracks, vcams and
  duration that is independently loadable and editable; a Story as an ordered set of
  scenes plus a designated entry/master scene; and the determinism contract that a
  scene evaluated at a given local time is identical regardless of history (no branch
  state in the evaluator). Rationale: pin the boundary before schema so nesting and
  branch assumptions never leak into the pure evaluator. Affected understanding:
  `core/rig.ts:36`, `core/timeline.ts` (Timeline type, `TIMELINE_SCHEMA_VERSION`).

- [x] 2. Extend the persisted schema to a Story container: change `RigDocument`
  (`core/rig.ts:36`) to hold multiple scenes with a designated entry scene, bump the
  rig and timeline schema versions, and add a version-gated migration that wraps a
  legacy single timeline as `scene[0]` with stable ids while leaving other fields
  additive/optional. Rationale: multi-scene is a document-model change that must
  migrate cleanly and stay backward-loadable before anything consumes it. Affected:
  `core/rig.ts` (schema, `parseRigDocument:82`, migration at `:87`+), `core/timeline.ts`.

- [x] 3. Add pure scene-resolution helpers in `/core`: stable scene ids, get-by-id,
  entry-scene accessor, and per-scene duration, all side-effect-free. Rationale: the
  runtime and triggers address scenes by id; centralize resolution so consumers never
  reach into the array shape. Affected: `core/rig.ts`, `core/timeline.ts`.

- [x] 4. Build the active-scene runtime state machine (in `/timeline`, or `/three`
  if it needs Three types): a stateful controller holding an active-scene stack and
  per-scene local clocks, exposing a `playScene` command (target id, from-time,
  skippable flag), an advance-by-dt step that seeks/plays the pure per-scene
  evaluator, and completion detection that returns to the previous scene/caller. Model
  it on the existing stateful post-stages (`stepCameraOverride` `three/index.ts:1544`,
  `driveActivation` `three/index.ts:1808`) and reuse the player transport
  (`seekTimelinePlayer` `timeline/index.ts:229`, `TimelinePlayer` `:183`). Rationale:
  this is the seam triggers plug into; it must be solid and testable via a manual
  caller before triggers exist. Affected: `timeline/index.ts` (near `driveTimeline:262`,
  `driveRig:373`), `RigDriveState` (`three/index.ts:1753`).

- [x] 5. Implement the camera take/blend/release handoff inside `playScene`: when the
  invoked scene owns a camera track/vcam, blend from the caller's live pose into the
  scene's active vcam using the existing blend curve, suspend pilot override for the
  scene's duration, then blend back and hand control to override on completion; a
  skippable invocation cancels early and blends back when user override input arrives;
  when the scene has no camera track, leave the camera with the user and play only the
  non-camera tracks. Reuse `resolveVirtualCameraDefinition` (`three/index.ts:574`),
  `TimelineBlendIn` (`core/timeline.ts:21`), and the override state
  (`stepCameraOverride` `three/index.ts:1544`, `RigBodyState` `:1387`,
  `CameraOverrideSettings` `core/virtual-camera.ts:100`). Rationale: the hardest piece;
  building it under `playScene` lets it be verified from a manual button before spatial
  triggers are added. Affected: `three/index.ts` (drive/override), `timeline/index.ts`
  (`driveTimeline`, `driveRig`).

- [x] 6. Thread the active-scene runtime through `driveRig` (`timeline/index.ts:373`)
  and the `RigDriveIntent` (`:352`) so a host's per-frame loop advances the active
  scene(s) and applies the handoff, composing with the existing idle/timeline/
  activation dispatch and override without regressing them. Rationale: one drive entry
  keeps non-r3f runtimes (headless, twin) identical. Affected: `timeline/index.ts`,
  `three` `useRigDrive`, demo `App.tsx:385`.

- [x] 7. Migrate the demo to a Story of scenes: update scene assembly/serialization
  (`scene-io.ts:211`, `:266`, `buildShowTimeline:63`) and autosave
  (`scene-storage.ts:17`) to persist and load multiple scenes, keeping a one-way import
  path for legacy single-timeline saves; route multi-scene edits through a single
  functional state update to avoid the known stale-closure hazard around `setExtraTracks`
  (`App.tsx:311`). Rationale: the demo is the validation app and needs the multi-scene
  document to exercise `playScene`. Affected: `scene-io.ts`, `scene-storage.ts`,
  `App.tsx`.

- [x] 8. Demo standalone scene editing: add a scene switcher to the shell so the editor
  can open and author one scene in isolation, binding the timeline lanes, hierarchy, and
  inspector to the active editing scene. Rationale: the "opened and edited on its own"
  requirement. Affected: `App.tsx` shell/selection, hierarchy and timeline UI.

- [x] 9. Demo manual invocation affordance: a "play scene" control (button/action) that
  issues `playScene` to the runtime, so the branch invocation plus the camera
  take/blend/release can be validated end-to-end before any trigger exists. Rationale:
  de-risk the handoff independently of spatial-trigger complexity. Affected: `App.tsx`,
  scene inspector UI.

- [x] 10. Phase 1 tests: package unit tests for the schema migration (legacy timeline to
  `scene[0]` round-trip), scene resolution/duration, and the active-scene runtime
  (`playScene` seeks/plays, completion returns, skippable cancels), plus demo tests for
  multi-scene assemble/serialize round-trips. Rationale: pin the foundation before
  layering the reactive system. Affected:
  `Packages/path-creator/test/timeline.spec.ts`, `examples/minimal-r3f-demo/src/*.spec.ts`.

### Phase 2 — Triggers/Actions (reactive layer on top of Phase 1)

- [x] 11. Write the trigger/action design note (contract, no code): decouple a Trigger
  (source + condition + arm policy that emits a signal) from an Action (verb + target +
  params) joined by an explicit binding; enumerate the source set (proximity enter/exit
  with hysteresis; scene/timeline markers, forward-playback only; click/tap) and the
  action verbs (transport seek/play/pause/rate, `playScene`, camera take/release, entity
  show/hide, play/stop animation clip, play/stop media); and state that triggers run in
  present mode only and are inert during authoring scrub. Rationale: pin schema and
  semantics before code. Affected understanding: `core/timeline.ts` markers precedent
  (`TimelineEvent:83`, `EventTrack:90`).

- [x] 12. `/core` trigger + action data + pure predicates: add scene-level and
  entity-level trigger/action/binding definitions to the schema (additive/optional, with
  migration), and pure evaluation given a world snapshot — proximity distance tests with
  enter/exit hysteresis, marker-crossing detection that only reports forward-playback
  crossings, and arm-policy transitions (once / rearm-on-exit / every-time / cooldown)
  expressed as pure reducers with no timers or side effects. Rationale: definitions and
  predicates are framework-agnostic and belong in core; effects do not. Affected:
  `core/timeline.ts`, `core/rig.ts` (schema + migration).

- [x] 13. Reactive trigger runtime (in `/three` or `/timeline`): a stateful stepper that
  consumes a per-frame world snapshot (entity + camera world positions, active-scene
  local times, user input) and the core predicates, maintains armed/fired/hysteresis/
  cooldown state per the arm policy, resolves conflicts by author priority, and emits a
  command list (transport ops, `playScene`, entity/media/camera verbs) executed by the
  Phase 1 active-scene runtime and the track directors. Build it as a sibling stateful
  stage to `stepCameraOverride` (`three/index.ts:1544`) and `driveActivation`
  (`:1808`), emitting the same commands the manual button used in Phase 1. Rationale:
  the live bridge between spatial state and the pure scenes. Affected: `three/index.ts`,
  `timeline/index.ts` (`driveRig`).

- [x] 14. `/r3f` + demo wiring: assemble the per-frame world snapshot from live camera
  and activatable world positions (`ObjectBindingRegistry` `three/object-tracks.ts:23`;
  demo `ActivatablesRegistry` `activatables.tsx:31`, `resolve` `:48`), dispatch emitted
  commands to the runtime/player (`App.tsx:385`), and gate triggers off during authoring
  scrub so the editor stays deterministic. Rationale: proximity needs live positions only
  the host holds; the editor must not fire triggers while scrubbing. Affected:
  `App.tsx`, `demo-scene-viewport`, `/r3f` drive wrapper.

- [x] 15. Demo trigger authoring + preview UI: author a proximity/marker/click trigger,
  bind it to an action (including `playScene`), and set arm policy, radius/hysteresis,
  priority, and skippable; add a simulate/preview affordance so triggers can be tested
  without entering present mode. Rationale: the concepts must be authorable and
  previewable. Affected: inspector panels, a new triggers section.

- [x] 16. Phase 2 tests: package tests for the pure predicates (proximity enter/exit with
  hysteresis; markers fire on forward playback and never on scrub) and arm-policy
  reducers (once / rearm-on-exit / every-time / cooldown), plus command-emission
  determinism across a snapshot sequence; demo tests that the trigger-to-action binding
  emits the expected command for the collision example. Rationale: the reactive layer's
  correctness rests on pure, testable predicates and reducers. Affected:
  `test/timeline.spec.ts`, demo specs.

### Cross-cutting

- [x] 17. Verify end-to-end and isolate commits: run package lint, test, and build and
  the demo type-check, test, and build; drive the running demo to confirm the marquee
  example (free camera approaches an object, proximity trigger fires, the camera blends
  into the scene vcam, all its tracks play including animation and voiceover, and control
  blends back on completion, with a skippable interrupt cancelling early); then stage
  only this feature's hunks, leaving the unrelated in-progress refactor untouched, and
  do not run git without explicit permission. Rationale: the browser is the only place
  the live handoff and spatial trigger are truly validated, and the branch carries a
  separate refactor. Affected: whole feature.

## Verification Criteria

- A legacy single-timeline rig document loads and round-trips as a Story whose sole
  entry is `scene[0]`; the schema version bump and migration are covered by tests.
- A scene can be opened and authored in isolation in the demo, and its edits persist
  independently of other scenes.
- Invoking `playScene` from the manual button blends a user-controlled camera into the
  scene's vcam, plays every track in that scene, and blends control back to the user on
  completion without a visible pop; a skippable invocation cancels and blends back when
  the user supplies override input.
- Invoking a scene that has no camera track plays its non-camera tracks while the user
  retains camera control.
- A proximity trigger fires exactly once on entering its radius (edge), respects the
  enter/exit hysteresis band, and re-arms according to the authored policy; markers fire
  during forward playback only and never during a scrub or seek.
- The collision example runs in the browser: approaching the object plays its scene
  (animation plus voiceover) with the camera takeover and release described above.
- Triggers are inert while scrubbing in the editor, and the simulate affordance previews
  a trigger without present mode.
- Package lint, test, and build and the demo type-check, test, and build all pass, with
  unit coverage for the migration, the scene runtime, the trigger predicates, and the
  arm-policy reducers.
- Only this feature's changes are staged for commit; the unrelated refactor files remain
  untouched.

## Potential Risks and Mitigations

1. **Branch/active-scene/trigger state leaks into the pure evaluator, breaking
   scrub-safety and headless determinism.**
   Mitigation: enforce a hard boundary — scenes evaluate as a pure function of local
   time; all stack, clock, arm-policy, and ownership state lives in the reactive
   runtime; add a test asserting a scene evaluated at a given local time is identical
   regardless of prior history.

2. **The camera take/blend/release pops or fights the user on hand-back.**
   Mitigation: build and verify the handoff from the manual button before triggers;
   blend in and out from live poses; make it skippable so user input cancels; reuse the
   existing blend curve and override engage/disengage rather than new motion code.

3. **Proximity re-fire storms / chatter at a zone boundary.**
   Mitigation: edge detection plus enter/exit hysteresis plus author-settable arm policy
   and cooldown; unit-test the predicate and arm reducers against boundary-hover
   sequences.

4. **Markers machine-gun when the playhead is scrubbed across them.**
   Mitigation: fire markers on forward playback only, never from a seek/scrub; cover with
   a test that a large scrub crosses many markers and fires none.

5. **Multi-scene edit state races through the demo's React state updates (the earlier
   stale-closure hazard).**
   Mitigation: route multi-scene and multi-channel edits through single functional state
   updates; keep runtime (non-authoring) state out of React render state entirely.

6. **Schema churn breaks existing saved scenes or the twin consumer.**
   Mitigation: additive/optional fields, a version-gated migration wrapping the old
   timeline as `scene[0]`, and a one-way legacy import path; re-check the twin's
   consumption against the geospatial debrief before landing.

7. **Scope explosion from building two large features at once.**
   Mitigation: keep the phase boundary hard — Phase 1 (scenes plus the handoff) is
   independently shippable and verified before Phase 2 (triggers) begins; deterministic
   master-embed stays deferred.

8. **Entanglement with the unrelated in-progress refactor already in the working tree.**
   Mitigation: stage only this feature's hunks, verify the working tree before any
   commit, and never commit without explicit permission.

## Alternative Approaches

1. Triggers first against the current single timeline, with a placeholder cue/range
   target, and scenes later: faster to a first trigger demo, but the marquee "play
   scene:2 with camera takeover" cannot be built as described until scenes exist, and the
   action schema would be reworked when scenes land — rejected in favor of scenes-first.
2. Put the trigger/branch logic inside the timeline evaluator: fewer moving parts, but it
   makes the timeline impure and destroys the scrub-safe, headless-deterministic guarantee
   the whole system rests on — rejected.
3. Use deterministic master-embed (scene control clips at fixed master-time windows) as
   the invocation mechanism instead of a live branch: elegant and fully scrub-safe, but it
   cannot express a live, user-position-driven "play on approach," so it complements rather
   than replaces the reactive layer — kept for a later phase, not a substitute here.
4. Adopt a third-party state-machine or behavior-tree library for triggers: potentially
   less code, but adds a dependency that must be WebGPU-safe and framework-agnostic and
   would not match the pure-predicate plus command-emission model — rejected in favor of a
   small in-house reducer set.
