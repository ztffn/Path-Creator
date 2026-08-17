# Keyframe Curve Editor for the Keyframed (Transform) Track

## Objective

Give the keyframed position/rotation/scale track a first-class, Unity-style curve
editor as the primary authoring surface, replacing today's number-table-first
inspector. The editor must be a reusable package primitive (like `EasingEditor`),
not a demo one-off, and must share a single curve-interaction codebase with the
existing easing editor rather than forking a second one.

Expected outcomes:
- A package component that plots a track's channels as real-unit curves over the
  track's time span, with the timeline playhead synced, and supports direct
  manipulation: drag a key (time and value), click to add, delete, and shape the
  interpolation via tangent handles that persist as per-key cubic-bezier easing.
- The demo transform-track inspector uses this editor as its main surface; the
  existing per-axis number table becomes the precise-entry fallback; the timeline
  block sparkline stays the read-only glance.
- No change to the persisted data model: the package `TransformTrack` /
  `TransformKey` shape (`Packages/path-creator/src/core/timeline.ts:110`) is already
  the long-term-correct model and is only consumed, never migrated.

## Context and Findings

- The reusable interaction machinery to be shared lives in
  `Packages/path-creator/src/timeline-ui/easing-editor.tsx`: pointer-to-normalized
  mapping and anchor/handle dragging (`easing-editor.tsx:209`), add/remove anchors
  (`easing-editor.tsx:252`, `easing-editor.tsx:274`), tangent relinking
  (`easing-editor.tsx:71`), effective-handle defaults (`easing-editor.tsx:57`), and
  the SVG canvas with grid/curve/handle rendering (`easing-editor.tsx:340`).
- The blocker to reuse is that this file is hard-wired to (a) a normalized 0..1 x
  0..1 coordinate space via `px`/`py` and the `yLo`/`yHi` clamps
  (`easing-editor.tsx:149`), and (b) a single `EasingCurve` value editing one curve
  (`easing-editor.tsx:156`). Both must be generalized.
- The data + evaluation contract to honor: `TransformKey` is `{time, value:[x,y,z],
  easing?}` (`core/timeline.ts:113`); interpolation is per-axis eased-lerp for
  position/scale and shortest-arc slerp for rotation, with per-key easing applied
  in `segment` (`core/timeline.ts:290`) and consumed by `evaluateTransform`
  (`core/timeline.ts:296`). The editor must produce keys this evaluator already
  understands so the sparkline, runtime, and editor never diverge.
- The read-only preview to keep consistent is the timeline block sparkline: markers
  plus per-axis position curves built by the demo helper `transformBlock`
  (`examples/minimal-r3f-demo/src/extra-tracks.ts`) and rendered by `BlockSeries`
  (`Packages/path-creator/src/timeline-ui/block-series.tsx`).
- The demo integration points: the inspector editor `TransformTracksEditor`
  (`examples/minimal-r3f-demo/src/extra-tracks-panel.tsx:332`, channel defs at
  `extra-tracks-panel.tsx:307`), its host `ObjectInspector`
  (`examples/minimal-r3f-demo/src/inspector-object.tsx`), the lane mapping in
  `App.tsx` (`examples/minimal-r3f-demo/src/App.tsx:1276`), and the live-pose reader
  `readObjectPose` (`App.tsx:772`). The playhead clock is the timeline player
  already threaded into the panel via `getPlayhead`.
- Naming collision to resolve: the demo already has a GLB baked-clip "Animation"
  track (`AnimationTracksEditor` in `extra-tracks-panel.tsx`), so the keyframed
  track cannot also be surfaced as "Animation".

## Implementation Plan

- [ ] 1. Lock the naming decision before any label work. Confirm the user-facing
  name for the keyframed transform track. Recommended: surface it as "Motion" and
  leave the GLB baked-clip track as "Animation", changing only user-visible labels
  and copy (in `inspector-object.tsx`, `extra-tracks-panel.tsx`, and the lane name
  in `App.tsx:1276`) while keeping internal type names (`TransformTrack`,
  `transformTracks`) unchanged to avoid a churny cross-cutting rename. Rationale:
  the label is trivial to change but must be settled first because it appears in the
  new editor's headings and the phase-2 channel toggles; deferring it forces rework.
  Document the chosen word and whether any internal identifiers are also renamed.

- [ ] 2. Design the shared curve-engine contract (no code yet — a written interface
  spec added to the plan or a short design note). Define a coordinate-agnostic model:
  an explicit value-domain and time-domain range (each with min/max, allowing
  negative and arbitrary units), a mapping between domain coordinates and pixel
  space in both directions, and a description of one editable curve as an ordered set
  of anchors with optional in/out tangent handles. Specify that the engine renders
  and hit-tests N curves at once, reports which curve/anchor/handle an interaction
  targets, and emits edits as domain-space values (not normalized). Rationale:
  pinning the contract first prevents the extraction from leaking normalized-space
  assumptions into the new consumer. Affected understanding: everything downstream
  depends on this contract.

- [ ] 3. Extract the interaction core from `easing-editor.tsx` into a new shared
  engine module under `Packages/path-creator/src/timeline-ui/` (with the mandatory
  five-line purpose header). Move the pointer-to-domain mapping, anchor/handle drag
  math, add/remove-anchor logic, tangent relinking, effective-handle defaults, and
  the SVG primitive rendering into it, parameterized by the domain ranges from task
  2 instead of hard-coded 0..1 and by a curve index so it can drive multiple curves.
  Keep it controlled and demo-agnostic. Rationale: this is the "one interaction
  codebase" commitment; the hard, already-working logic is preserved, only its
  coordinate assumptions and single-curve assumption are generalized.

- [ ] 4. Re-express `EasingEditor` as a thin specialization of the shared engine.
  It must keep its exact current behavior and public props (`value`, `onChange`,
  `theme`, `height`, `mode`, `backdrop` per `easing-editor.tsx:110`): fixed 0..1 x
  chosen-y domain, single curve, pinned easing endpoints, position/speed toggle, and
  the derivative overlay. Rationale: proves the extraction is non-lossy and prevents
  a second diverging editor; any regression here is caught by existing easing tests
  and the audio/cart/lens consumers that render it.

- [ ] 5. Build the new `KeyframeCurveEditor` package component on the shared engine
  (new file, five-line header). Phase-1 scope: accept a set of position keyframes
  (times and values) plus the current playhead time and time span; render x/y/z as
  three curves colored red/green/blue over a shared auto-fit value domain with the
  playhead drawn as a synced vertical line; support dragging an anchor to change both
  its time and value, click/gesture to add a key, and delete a key. Emit changes back
  as updated keyframes in real units. Controlled and demo-agnostic. Rationale:
  delivers the core authoring capability the user asked for, reusing the engine.

- [ ] 6. Reconcile value-domain ranging between the editor and the sparkline. Ensure
  the auto-fit vertical range (with a manual-override affordance) matches the shared
  normalization already used by `transformBlock`
  (`examples/minimal-r3f-demo/src/extra-tracks.ts`) so the inspector graph and the
  timeline block preview show the same shape. Decide whether the ranging helper
  should move into the package so both consumers share it. Rationale: the sparkline
  and the editor must never disagree about what the motion looks like.

- [ ] 7. Integrate `KeyframeCurveEditor` as the primary surface in the demo
  transform inspector (`extra-tracks-panel.tsx:332` and `inspector-object.tsx`).
  Thread the existing `getPlayhead` and `readObjectPose` (`App.tsx:772`) through so
  the graph shows the playhead and new keys seed from the live pose. Demote the
  current per-axis number table (`extra-tracks-panel.tsx:307` channels) to the
  precise-entry fallback it already is behind the "edit values" toggle, kept in sync
  with graph edits. Leave the read-only lane sparkline untouched. Rationale: makes
  the graph the main authoring UI while keeping numeric precision and the glanceable
  preview.

- [ ] 8. Phase 2 — tangent editing and full channels. Extend `KeyframeCurveEditor`
  to expose in/out tangent handles that write back to each key's `easing` as a
  cubic-bezier (the `Easing` custom-curve form already understood by `segment`,
  `core/timeline.ts:290`), and add rotation and scale channels with per-channel and
  per-axis visibility toggles so up to nine curves stay legible. Rationale: reaches
  feature parity with the "shape the curves of the keyposes" goal and keeps all
  channels editable in one place; deferred from phase 1 so phase 1 ships usable.

- [ ] 9. Phase 3 — usability polish. Add snapping (time-to-grid and optional
  value snapping), multi-select and box-select of keys, drag of a selection, and
  live numeric readouts of the hovered/selected key. Rationale: these make the editor
  pleasant for real authoring but are not required for a usable first release, so
  they are isolated to a final phase that can be reprioritized.

- [ ] 10. Tests. Add package unit tests for the shared engine's coordinate mapping
  and edit operations in real (including negative) domains, and for `EasingEditor`
  parity, alongside the existing timeline-ui coverage. Add or extend demo tests for
  the keyframe-editor edit reducers (add/move/delete producing evaluator-valid keys)
  next to `examples/minimal-r3f-demo/src/transform.spec.ts`. Rationale: the value of
  the extraction is only safe if both consumers are pinned; the reducers must emit
  keys `evaluateTransform` already accepts.

- [ ] 11. Verify end to end and rebuild the package before demo checks. Run the
  package lint, test, and build; the demo type-check, test, and build; then drive the
  running dev server in the browser to confirm the graph renders, the playhead
  tracks, and drag/add/delete/tangent edits move the object and update both the number
  table and the lane sparkline. Rationale: the package ships built output that the
  demo imports, so the demo only reflects package changes after a rebuild; browser
  verification is the only way to confirm the interaction actually works.

- [ ] 12. Isolate commits from the unrelated in-progress refactor. When committing,
  stage only the hunks belonging to this work; do not fold in the pre-existing
  uncommitted changes in `App.tsx`, `extra-tracks.ts`, `hierarchy.tsx`,
  `timeline-ui/index.tsx`, or `audio.spec.ts`. Use conventional commit messages with
  no Claude attribution, and do not run any git command without explicit user
  permission. Rationale: the branch carries a separate refactor that must not be
  entangled with this feature.

## Verification Criteria

- `EasingEditor` renders and behaves identically after the extraction: presets,
  custom-curve editing, add/remove points, tangent modes, the position/speed toggle,
  and the audio backdrop all work as before, and every existing package test passes.
- The keyframe editor plots position x/y/z as three distinct colored curves over a
  value range that fits the keys (including negative values), with a vertical
  playhead line at the current timeline time.
- Dragging an anchor changes both the key's time and value; clicking adds a key that
  seeds from the live pose; deleting removes it; and each operation immediately moves
  the bound object in the viewport and updates the number-table fallback.
- Phase 2: dragging a key's tangent handles changes the interpolation feel and
  persists as that key's cubic-bezier easing, reflected in both the runtime motion
  and the lane sparkline; rotation and scale channels are editable with working
  visibility toggles.
- The inspector graph and the timeline lane sparkline show the same motion shape for
  the same track (no divergence in normalization).
- Package `lint`, `test`, `build` succeed; demo type-check, `test`, and `build`
  succeed; the browser session confirms the interactions above on the real track.
- Only this feature's changes are staged for commit; the unrelated refactor files
  remain untouched.

## Potential Risks and Mitigations

1. **Extraction regresses `EasingEditor` and its downstream consumers (audio gain,
   cart, lens editors).**
   Mitigation: treat task 4 as a behavior-preserving refactor gated by the existing
   package tests and a browser pass on the audio gain editor before proceeding;
   keep `EasingEditor`'s public props unchanged so no consumer edits are needed.

2. **Multi-curve editing of up to nine curves becomes visually unreadable.**
   Mitigation: ship phase 1 with position only; make rotation/scale opt-in via
   visibility toggles in phase 2; use consistent per-axis coloring and dim inactive
   channels.

3. **Real-unit value ranging disagrees with the sparkline's normalization, so the
   inspector and the lane preview show different shapes.**
   Mitigation: task 6 makes both consumers share one ranging helper (moved into the
   package if needed) and asserts agreement in tests.

4. **Editing keys graphically produces easing/tangent data the runtime evaluator
   interprets differently than the editor draws.**
   Mitigation: emit only the `Easing` custom-curve form `segment`
   (`core/timeline.ts:290`) already consumes, and cover the edit reducers with tests
   that round-trip through `evaluateTransform`.

5. **Scope creep turns a phased feature into one large unreviewable change.**
   Mitigation: keep the phase boundaries hard — phase 1 (engine + position editing)
   is independently shippable and verifiable before phase 2/3 begin.

6. **The pre-existing uncommitted refactor gets entangled with this work.**
   Mitigation: task 12 stages only this feature's hunks; verify the working tree
   before any commit and never commit without explicit permission.

## Alternative Approaches

1. Build a standalone keyframe editor without touching `EasingEditor`: fastest to a
   first render, but permanently forks two curve editors with divergent interaction
   code and bugs — rejected because it contradicts the long-term-usability goal.
2. Adapt `EasingEditor` in place by adding domain-range and multi-curve props to the
   existing component rather than extracting an engine: less new surface area, but
   overloads one component with two very different modes and risks regressing the
   easing behavior with every keyframe-editor change — viable but less clean than a
   shared engine with two thin specializations.
3. Use an existing third-party curve/graph-editing library: potentially less code,
   but adds a dependency that must render safely in the consumer's WebGPU-hosted
   app, likely fails the package's zero-heavy-dependency posture, and would not match
   the existing easing/data model — rejected.
4. Keep number-table entry as the only editor and enrich only the read-only
   sparkline: minimal effort, but does not deliver the direct-manipulation authoring
   the user explicitly asked for — rejected.
