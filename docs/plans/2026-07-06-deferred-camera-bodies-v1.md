# Deferred Virtual-Camera Bodies (follow / positionCompose / stateful body channel)

Date: 2026-07-06
Status: Partially implemented. Superseding note (2026-07-07): the interactive work below
(tasks 1, 6, 7) shipped, then was **generalized** beyond the orbit-only design here into a
**unified pivot-orbit manual override on any vcam** — `control: CameraOverrideSettings` at the
definition level (azimuth/elevation/pan/dolly, locked/free/recenter), `stepCameraOverride` +
`resolveCameraPivot` (replacing the orbit-specific `stepOrbitBody`/`applyOrbitLive`), applied by
**both** `driveActivation` and `driveTimeline`, with the input layer promoted to the package
(`createOverrideInputAccumulator` in `/three`, `<CameraOverrideSurface>` in `/r3f`). See
`docs/technical/camera-system-implementation.md` → "Manual override (pivot-orbit, any vcam)".
**Remaining: the `follow` body, the `positionCompose` body, and binding-frame position damping**
(smoothing toward a *moving coded target* — distinct from the manual override; the `RigBodyState`
channel hosts it). Tasks 1/6/7 are DONE (as the generalized override); tasks 2–5 and 8–12 stand.
Owner: project maintainer
Depends on: orbit body + the shipped `RigBodyState` override channel (`stepCameraOverride`/`resolveCameraPivot`), `getTargetOrientation`, `OrbitVcamGlyphRig`.

## Objective

Complete the Cinemachine-style camera-body set the twin needs, building directly on the orbit body already shipped. Three deliverables, ordered by dependency:

1. **`follow` / third-person body** — the camera trails a moving target at a constant offset (chase cam), with over-the-shoulder (OTS) framing when target-relative. Fills the gap where today only a cart or a static offset can trail motion.
2. **`positionCompose` body** — screen-frame a target by *moving* the camera (Cinemachine PositionComposer), the position-space analogue of the existing rotation composer (`track` aim + `ComposerSettings`). Inherently stateful.
3. **`RigBodyState` channel** — the per-frame body-state seam both stateful behaviours need: binding-frame position damping, azimuth recentering (idle timer), and interactive azimuth/elevation drag for the orbit body. Mirrors the composer's `RigComposerState` + `stepComposerAim` precedent.

Expected outcome: a host can author "trail behind the vehicle with damping", "keep the subject framed lower-third by dollying", and "auto-orbit that recenters after the user stops dragging" — all with resolution staying pure and stateful smoothing confined to a post-stage stepped once per frame.

## Background and design decisions (from the orbit session)

- **Camera model = body (position) + aim (orientation), independent** — Cinemachine's Position-Control vs Rotation-Control split. New bodies set position; the existing `track` aim frames a possibly-different target. Keep them separable.
- **Resolution stays pure.** `resolveVirtualCameraDefinition` (`Packages/path-creator/src/three/index.ts:578`) is called more than once per frame (brain retarget + activation change-detection), so anything stateful stepped inside it double-advances. The orbit body proved the pattern: pure geometric ideal in resolution, stateful smoothing in a post-stage. `follow` (undamped) and `positionCompose`'s *ideal* frame resolve purely; damping/recentering/lookahead live in the body channel.
- **State channel mirrors the composer.** `RigComposerState` (`three/index.ts:1076`) lives inside `RigDriveState` (`three/index.ts:1365`); `stepComposerAim` (`three/index.ts:1099`) restores prior orientation, reframes, saves it back, and reseeds on a shot change. `RigBodyState` follows this shape and is stepped once in `driveTimeline` (`timeline/index.ts:211`) and `driveActivation` (`three/index.ts:1414`).
- **Damp in the binding frame, not world.** A rotating target smears a world-space damped offset. Damping must run in the target-local (binding) frame — reuse `orbitBindingQuaternion` (`three/index.ts:515`) to enter/leave that frame.
- **Recentering must yield to live input** (reset the idle-wait timer on input) and take the **shortest angular path**.
- **Prefer quaternion/slerp aim-damping over Euler**; clamp elevation off the poles (the orbit body already clamps ±80 via `orbitOffset`).
- **Target orientation is available** (`getTargetOrientation` on the resolve context, `VirtualCameraResolveContext` at `core/virtual-camera.ts:189`, backed by `TargetRegistry.resolveOrientation` and `registerObjectTarget`). Target-relative binding (`lockYaw`/`lock`, `OrbitBinding` at `core/virtual-camera.ts:94`) degrades to `world` when orientation is absent — reuse this policy for `follow`.
- **Snapshots are rig-space; `rigMatrix` places them in world at apply-time (P1.2).** Do NOT bake world transforms into resolution or the body channel. Keep `rigMatrix` identity/omitted byte-identical to today.
- **Cinemachine references** (re-read when implementing): CinemachineFollow (constant `followOffset` + per-axis damping), CinemachineThirdPersonFollow (`shoulderOffset`, `cameraDistance`, damping, optional vertical arm), CinemachinePositionComposer (screen dead/soft zones + camera distance + damping, moving the camera not rotating it), CinemachineOrbitalFollow (recentering per axis: idle `wait`, `time` to center, `center` value).

## Implementation Plan

- [x] 1. **[DONE 2026-07-07 — later generalized; see status note. Current symbols: `stepCameraOverride`/`resolveCameraPivot`/`CameraOverrideInput`, not the orbit-specific names below] Design the `RigBodyState` channel and its step contract.** Shipped: `RigBodyState` (per-axis live offsets + idle timers + vcamId) in `RigDriveState`, `createRigBodyState`, `stepOrbitBody` + `applyOrbitLive`. It reseeds on shot change and integrates `OrbitInput`. Position-damping state (task 5) can extend this same struct. Decide the exact state shape (smoothed position in binding-frame coordinates, recentering idle-timer, live azimuth/elevation offsets from interactive input, and the driven vcam id for reseed-on-shot-change), mirroring `RigComposerState` (`three/index.ts:1076`). Specify a `createRigBodyState` factory and a `stepBody`-style function contract: inputs (camera, definition, resolve context, deltaSeconds, up, rigMatrix), what it reads/writes, and how it reseeds when the driven vcam changes. Rationale: both `positionCompose` and stateful orbit depend on this seam; nailing the contract first prevents two divergent state models. Affected: `Packages/path-creator/src/three/index.ts` (new state type + factory near `createRigDriveState` at `three/index.ts:1371`), `RigDriveState` gains a `body` field.

- [ ] 2. **Decide how the body channel composes with the brain.** The brain blends shot-to-shot from the resolved snapshot; the body channel adds within-shot smoothing toward a moving target. Specify whether the damped body pose feeds the brain's retarget (so the brain blends the already-damped pose) or overrides position after `driveVirtualCameraBrain`, and confirm a cut activation stays instant while within-shot damping persists. Document the ordering relative to `stepComposerAim` (aim overrides orientation after position is set). Rationale: this is the one genuine architectural risk — two position controllers (brain blend vs body damp) must not fight. Affected: the drive dispatch in `driveActivation` (`three/index.ts:1414`) and `driveTimeline` (`timeline/index.ts:211`).

- [ ] 3. **Add the `follow` body to the core body union.** Extend `VirtualCameraBodyDefinition` (`core/virtual-camera.ts:96`) with a `follow` variant: follow target (`Vec3 | { targetId }`), a per-axis `offset` (the `followOffset`), a `binding` reusing `OrbitBinding` (`world`/`lockYaw`/`lock`), and OTS extras for the third-person case (shoulder offset, camera distance, optional vertical arm length). Default the body orientation to look at the target (as orbit does), so `aim: { type: "body" }` works alone. Rationale: renderer-agnostic type first; keep essential-minimum fields, defer collision/side-blend. Affected: `core/virtual-camera.ts`, its re-exports in `three/index.ts` (the `OrbitBinding`/type export block).

- [ ] 4. **Resolve the `follow` body purely.** Add a branch to `resolveVirtualCameraDefinition` (`three/index.ts:578`) that places the camera at `target + binding-frame(offset)`, reusing `orbitBindingQuaternion` (`three/index.ts:515`) for the frame and the same graceful `world` fallback when orientation is absent. The undamped ideal is pure; damping is layered by the body channel from task 1. Rationale: parity with the orbit branch keeps one placement idiom. Affected: `three/index.ts`. Add deterministic unit tests in `test/three.spec.ts` (world/lockYaw/lock offset placement, look-at-target default, OTS shoulder offset in the target frame, null-orientation fallback), following the orbit-body test block pattern.

- [ ] 5. **Implement binding-frame position damping in the body channel.** In `stepBody`, exponentially smooth the current camera position toward the resolved ideal, computed in the target-local binding frame (transform current + ideal into the frame via `orbitBindingQuaternion`, lerp with `alpha = 1 - e^(-(12/damping)·dt)` — the same heaviness convention as the composer's `getScreenCorrection` at `three/index.ts` and lookahead), then transform back. Apply per-axis damping. Rationale: world-space damping smears under a rotating target; the binding frame is the fix from the research. Affected: `three/index.ts`. Unit tests: a moving/rotating target with damping converges to the ideal and lags correctly; zero damping equals the pure ideal (byte-identical to task 4).

- [x] 6. **[DONE 2026-07-07 — later generalized to pivot-orbit; recentering now per-axis azimuth/elevation/pan/dolly at the definition level] Per-axis recentering (azimuth/elevation/radius) on the orbit body.** Shipped as `control: { azimuth|elevation|radius: { mode: "locked"|"free"|"recenter", recenterWait?, recenterTime? } }`; `stepOrbitBody` decays the live offset toward the coded value after the idle wait (shortest angular path, elevation clamped off the poles). Original text: **Add azimuth recentering to the orbit body via the body channel.** Extend the orbit path so the body channel tracks an idle timer: after interactive input stops for the configured `wait`, drive the live azimuth offset back toward the authored `center` over `time`, along the shortest angular path, resetting the timer on any new input. Resolution still computes the geometric ideal from the *effective* azimuth (authored + auto-orbit + recentered live offset); the recentered offset is the stateful part. Rationale: recentering is the orbit feature deferred this session; it is inherently stateful (idle timer) so it belongs here, not in pure resolution. Affected: `core/virtual-camera.ts` (optional recentering config on the orbit body), `three/index.ts` (body channel). Unit tests with a synthetic clock: idle past `wait` recenters; input resets the timer; shortest-path across the ±180 seam.

- [x] 7. **[DONE 2026-07-07 — later generalized; input now `CameraOverrideInput` via `createOverrideInputAccumulator`/`<CameraOverrideSurface>` + `overrideInput` on both drivers] Interactive azimuth/elevation/radius input on the orbit body.** Shipped: `OrbitInput` (per-axis pointer/wheel deltas) on `RigActivationParams.orbitInput`, flowed through `driveRig`/`useRigDrive`; the demo feeds a PiP pilot pad + per-axis mode UI. Original text: **Wire interactive azimuth/elevation drag into the orbit body channel.** Let a host feed pointer/drag deltas that adjust the live azimuth/elevation offsets held in `RigBodyState`, clamped off the poles, feeding both recentering (task 6) and the gizmo. Define the neutral input surface (a method on the body channel or an intent field), mirroring how `RigDriveIntent` (`timeline/index.ts`) carries neutral input. Rationale: "auto-orbit while looking" plus manual nudge is a twin use case; interactive input is the third deferred orbit piece. Affected: `three/index.ts`, `timeline/index.ts` (intent surface), `Packages/path-creator/src/r3f/rig-drive.ts` (thin passthrough).

- [ ] 8. **Add the `positionCompose` body to the core union.** Add a `positionCompose` variant to `VirtualCameraBodyDefinition` (`core/virtual-camera.ts:96`): target, camera distance, and screen dead/soft zones + per-axis damping. Reuse or factor the zone/damping vocabulary shared with `ComposerSettings` (`core/virtual-camera.ts:120`) rather than duplicating it. Rationale: PositionComposer is the rotation composer's position-space twin; sharing the zone math keeps one framing model. Affected: `core/virtual-camera.ts`.

- [ ] 9. **Implement the `positionCompose` step in the body channel.** Mirror `applyScreenComposerAim` (`three/index.ts:890`) but correct *position* instead of orientation: project the target into screen space, and when it leaves the dead zone, move the camera (at the configured distance) to reframe with per-axis damping, clamping at the soft edge. State lives in `RigBodyState`; reseed on shot change like `stepComposerAim` (`three/index.ts:1099`). Rationale: reuses the proven dead/soft-zone + damping machinery from the aim composer, only the output axis differs. Affected: `three/index.ts`. Unit tests: target inside dead zone → no move; beyond soft edge → clamped; damping heaviness matches the aim composer.

- [ ] 10. **Step the body channel in both drivers.** Call the body step once in `driveTimeline` (`timeline/index.ts:211`) and `driveActivation` (`three/index.ts:1414`), against the shared `RigDriveState.body`, in the order decided in task 2, threading `up` and `rigMatrix` exactly as `stepComposerAim` receives them. Ensure idle re-entry resets body state cleanly (mirror how `driveRig` idle at `timeline/index.ts:290` clears composer/activation). Rationale: one shared channel means position continuity survives a timeline↔activation switch, like the brain and composer. Affected: `three/index.ts`, `timeline/index.ts`.

- [ ] 11. **Author the new bodies in the demo without capping the library.** Extend `examples/minimal-r3f-demo/src/vcam-model.ts` (`DemoVirtualCamera` + `toVcamView`/`vcamDefFromView` round-trip) and `App.tsx` (`DemoShotPatch`, editor panel controls, Scene render branch, add-button) for `follow` and `positionCompose`, exactly as the orbit body was added this session. Add debug/authoring gizmos: for `follow`, an offset handle + target-to-camera arm following the binding frame; for `positionCompose`, a screen dead/soft-zone overlay. Rationale: the standing project rule is to grow the demo to the feature, never narrow the library to the demo (see the demo-must-not-cap-library memory). Affected: demo `vcam-model.ts`, `App.tsx`, and new r3f gizmo components paralleling `OrbitVcamGlyphRig`.

- [ ] 12. **Verify and document.** Run the full green sweep (package lint/test/build + both example builds) and drive the demo in system Chrome via the Playwright WebGPU oracle: trail a moving target with damping, dolly-frame a target with `positionCompose`, and confirm orbit recentering after idle. Then update `docs/technical/camera-system-implementation.md` to document the shipped behaviour (the plan is not the implementation doc). Rationale: body math is unit-testable but the damping/recentering feel and the gizmos need a real driven frame; docs track actual implementation. Affected: `test/three.spec.ts`, `docs/technical/camera-system-implementation.md`.

## Verification Criteria

- `follow` body resolves purely to `target + binding-frame(offset)` for all three bindings, defaults to looking at the target, and falls back to `world` when the target has no orientation — covered by deterministic unit tests.
- With damping enabled, a `follow` camera converges to the ideal offset and lags a moving/rotating target correctly; with zero damping the pose is byte-identical to the pure ideal.
- Orbit recentering returns azimuth to the authored center after the idle `wait`, resets on new input, and takes the shortest angular path across the ±180 seam — covered by synthetic-clock unit tests.
- `positionCompose` leaves the camera still while the target is inside the dead zone, moves to reframe beyond it, and clamps at the soft edge, with damping heaviness matching the aim composer.
- A timeline→activation switch preserves body-channel continuity (no position pop), matching the brain/composer behaviour.
- `rigMatrix` omitted/identity produces byte-identical output to today for all existing (static/cart/orbit) shots.
- Full green sweep passes; the demo authors `follow` and `positionCompose` with working gizmos; the WebGPU oracle shows correct behaviour with no device-loss/console errors.
- `docs/technical/camera-system-implementation.md` documents the shipped bodies and the body channel.

## Potential Risks and Mitigations

1. **Two position controllers (brain blend vs body damp) fight, causing pops or drift.**
   Mitigation: resolve the composition question in task 2 before coding the channel; add a regression test that a cut activation is instant while within-shot damping persists, and that a stable shot with a still target holds exactly at the ideal.

2. **World-space damping smears the offset when the target rotates.**
   Mitigation: damp in the binding frame using `orbitBindingQuaternion`; test explicitly with a rotating target that the offset stays on the correct side while damping only the transition.

3. **Recentering interferes with live input or takes the long way around.**
   Mitigation: reset the idle-wait timer on any input; wrap the azimuth delta to (-180,180] and drive along the shortest path; synthetic-clock tests for both.

4. **Statefulness leaks into resolution, breaking determinism/scrub-safety.**
   Mitigation: keep `resolveVirtualCameraDefinition` pure — it returns only the geometric ideal; all timers/smoothing live in `RigBodyState`. Assert that resolving the same definition twice with the same context is idempotent.

5. **Duplicated dead/soft-zone + damping math between the aim composer and `positionCompose` drifts over time.**
   Mitigation: factor the shared zone/heaviness helpers so both composers call one implementation; if not cleanly factorable, document the intentional parallel and cover both with the same test shape.

6. **Gizmo geometry churn causes WebGPU device loss.**
   Mitigation: route all lines through `RigLine` with version-bumped buffers (the `useContentVersion` pattern in `OrbitVcamGlyphRig`); never vary geometry args per frame (per the no-geometry-args-churn memory).

## Alternative Approaches

1. **Make resolution stateful (pass the body state into the resolve context) instead of a separate post-stage.** Rejected: `resolveVirtualCameraDefinition` runs multiple times per frame (brain retarget + activation change-detection), so a stateful resolve double-advances damping/recentering and breaks scrub determinism. The post-stage mirrors the proven composer design.

2. **Reuse the brain's shot blend as the position damper.** Rejected: the brain is a fixed-duration eased blend between shots; follow/orbit damping is continuous exponential smoothing toward a moving target — a different curve and lifetime. Conflating them removes control and misbehaves when both a shot blend and target motion are active.

3. **Implement `follow` as a thin preset over `orbit`** (offset expressed as azimuth/elevation/radius). Rejected for the essential case: OTS follow is naturally a Cartesian offset in the target frame (shoulder + distance behind heading); forcing it through spherical params obscures authoring. Keep them as sibling bodies sharing the binding-frame helper.

4. **Ship `follow` and `positionCompose` before the shared body channel** (undamped only). Viable as an incremental step — `follow`'s pure ideal and `positionCompose`'s ideal frame resolve without state — but `positionCompose` and orbit recentering are not useful without the channel, so the channel (tasks 1–2) should land first or alongside.
