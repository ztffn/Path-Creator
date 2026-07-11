<!--
Purpose: Living backlog of remaining/known work for @huma/path-creator and the
reference demo, beyond what's already shipped. Not a task tracker for a single
session — a durable list of deferred features, refactors, and known gaps so they
aren't rediscovered. Update as items land or new ones surface.
Scope: Packages/path-creator + examples/minimal-r3f-demo (+ twin integration).
-->

# Roadmap / backlog

Ordered roughly by priority. "Deferred from" notes where the decision was made.

> **2026-07-06 — first real consumption happened.** The twin integration below
> was executed (and shipped: server persistence + visitor cinematic, deployed).
> It surfaced blockers this roadmap did NOT anticipate — WebGPU renderer
> incompatibility, packaging, georeferencing, handle sizing. Those, plus the
> reconciled items here, now live in the authoritative
> **`GEOSPATIAL-INTEGRATION-DEBRIEF.md`** (P0–P3). Read it before picking up
> reuse work.

## Active / next

### ✅ Demo timeline tracks — GLB clips, keyframed transforms, gizmo, portability (DONE — 2026-07)
Four authorable track kinds, now promoted into the package's versioned timeline
schema alongside camera/cart/event. Each has a package-owned pure `evaluate(t)`;
the object-bound kinds also have reusable Three.js directors:
- **Activation** — object visibility over clip windows (`ActivationTrackDirector`).
- **Audio** — 2D clips, forward-play only (`AudioTrackPlayer`, `audio-player.ts`).
- **Animation (GLB)** — a loaded GLB's baked clips (`GltfActivatable` + `AnimationTrackDirector`).
  Loads via drei `useGLTF`; a bundled CC0 Fox lives in `public/Fox.glb`. Per-clip loop/once;
  overlapping clips crossfade with complementary weights. Actions remain playing while
  explicit local times are applied before `mixer.update(0)`, keeping blends scrub-safe.
- **Transform** — keyframed position/rotation/scale for any object, no baked clip
  (`TransformTrackDirector`). Position/scale eased-lerp; rotation shortest-arc **slerp** from
  Euler-degree keys. Composes with GLB clips (a clip walks the skeleton while a transform
  track moves the root).

Authoring: the shared combined move/rotate/scale **`TransformGizmo`** (Shots mode only) →
"key pose @ playhead" snapshots the pose into keyframes. Placement lives on each
activatable's registered **group** so the gizmo, director, and registry all drive the same node
(selection bounds measure in that group's local frame). Both mesh + transform directors restore
to base/bind pose on leave; new-key defaults seed from the current pose (so keying never jumps).

**Portability DONE (2026-07):** timeline schema v4 and RigDocument schema v4 carry
`activation`, `audio`, `animation`, and `transform` tracks directly. Pure evaluators
ship from `/core` and `/timeline`; `ActivationTrackDirector`, `AnimationTrackDirector`,
`TransformTrackDirector`, and `ObjectBindingRegistry` ship from `/three`. The demo now
consumes those APIs and exports typed tracks inside its show timeline. Import retains a
one-way compatibility path for legacy `x-demo-tracks` files.

Intentionally host-owned: GLTF fetching/component lifecycle, Web Audio asset decoding,
waveform generation, inspectors, hierarchy, and selection UI. These depend on application
loading and authoring policy rather than timeline/runtime semantics.

### ✅ Twin integration (DONE — exceeded the spike)
Consumed `@huma/path-creator` from the geospatial twin's `/author` route as a
dolly+timeline scenario type; went past the spike to in-scene editing, server
persistence, and a visitor cinematic (deployed `twin.humatopia.ai`). Friction
captured in `GEOSPATIAL-INTEGRATION-DEBRIEF.md`. **Key learning: the /core edit
model + /timeline reused cleanly; the /r3f editor UI could NOT render in the
consumer's WebGPU renderer (drei fat lines) — the #1 thing to fix (debrief P0).**

### P0 — WebGPU-safe rendering (the `RigLine` seam)  ·  = debrief P0
**First step DONE.** All package line rendering now routes through `RigLine`
(`src/r3f/rig-line.tsx`), which picks the material by backend: WebGL → drei fat
line (thick); WebGPU → core `LineBasicMaterial` (thin, auto-maps, no
`LineMaterial` device-loss). Wired into `PathVisual` (rails/ties/centre) and
`PathEditor` (sibling dashed); `CartGizmo` uses core `EdgesGeometry` instead of
drei `<Edges>`. Policy this pass (decided with the user): **thin-but-safe on
WebGPU, thick on WebGL.** drei stays an *optional* peer, touched only on the
WebGL branch — the seam localizes every follow-up below to one file.

Follow-ups:
- **Node-material thickness on WebGPU (DEFERRED — not a small change).** RigLine's
  WebGPU branch + the gizmo's `PivotLine` render thin. Fat lines need
  `Line2NodeMaterial`, which lives in `three/webgpu` — a renderer-agnostic package
  can't import it without pulling the WebGPU build into every consumer (breaks
  WebGL-only consumers and the CJS build). Needs a conditional/dynamic-import seam or
  a peer-optional `three/webgpu` split first. Thin-but-safe is the consistent policy
  until then. Dashed lines are likewise dropped on the WebGPU branch.
- **Drop drei for lines entirely.** Replace the WebGL branch's drei `<Line>` with
  `three/addons` `Line2` so lines need *zero* drei (drei fully optional, not just
  peer-optional) — the "graceful fallback with no drei" goal.
- **Pluggable, WebGPU-safe gizmo (debrief P0.2).** *DONE — full combined gizmo.*
  `RigGizmo` (`src/r3f/rig-gizmo.tsx`) — `RigGizmoComponent` interface + `PivotGizmo`
  (drei, WebGL default) + `TransformGizmo`. **First tried stacking two three
  `TransformControls` (translate+rotate); abandoned** — the rotate gizmo's invisible
  free-rotate sphere (`XYZE`) overlaps the translate arrows and mis-grabs constantly.
  `TransformGizmo` is now a **vendored fork of drei PivotControls** (`src/r3f/pivot/`)
  with the one WebGPU liability swapped out: its fat `LineMaterial` axis/ring lines
  (drei `<Line>`/three-stdlib) are replaced by `PivotLine` (a thin `THREE.Line` +
  `LineBasicMaterial` via `<primitive>`), and the rotator's fat invisible hit-line by
  an invisible `TubeGeometry` proxy. Everything else (per-handle mesh pickers → no
  mis-grab, `fixed` screen-constant px sizing, `onDrag(local, deltaLocal)`,
  disable* props) is drei's, unchanged. Gives the full move+rotate+(plane)+scale
  gizmo. Both `PathEditor` and `PointTargets` inject it; validated on WebGPU (Metal-3):
  arrow=translate / arc=rotate cleanly isolated, anchor-rotate swings control handles,
  screen-constant, no device loss. WebGL keeps drei PivotControls (fat lines).
  Notes: lines are thin on WebGPU — see the deferred fat-line item below. When drei v11
  (WebGPU) ships stable, this fork can be dropped for `@react-three/drei/webgpu`.
  Midpoint normal-rotation pivot now also routes through the seam (rotation-only via a
  new `disableTranslation` prop → `disableAxes`+`disableSliders`); its WebGPU gate is
  removed, so rotation works on WebGPU everywhere. That closes the last gizmo gate.
- **Glyph-geometry churn on WebGPU — FIXED.** Clicking an anchor lost the WebGPU
  device (`DrawIndexed(168)`, "vertex buffer slot 0 not set"). Root cause: PathEditor's
  handle rings/circles changed their `ringGeometry`/`circleGeometry` **args** (and
  mounted/unmounted the highlight ring) on selection, so three's WebGPU backend
  disposed/recreated GPU buffers mid-frame and drew with an unbound vertex buffer.
  Fix: constant geometry args for every glyph; selection/scale now via mesh `scale` +
  material `opacity` (matrix/uniform updates, no buffer churn). Rule for this package:
  **never vary a mesh's geometry `args` per-interaction on a WebGPU render path — vary
  scale/opacity/color instead.**
- **WebGPU-safe text/labels (RigLabel).** *DONE.* troika `<Text>` doesn't crash on
  current three but renders a silent garbage white quad on the WebGPU node renderer
  (its SDF atlas doesn't sample there). `RigLabel` (`src/r3f/rig-label.tsx`) draws the
  text to a 2D canvas on a camera-facing Sprite (SpriteMaterial auto-maps both
  backends); PathEditor anchor numbers, CartGizmo, and VirtualCameraGlyph all route
  through it, and the WebGPU label gates are removed. Validated rendering real glyphs
  on WebGPU (Metal-3) and no WebGL regression. (PointTargets has no label; its gizmo
  routing is the remaining seam item below.)
- **WebGPU validation example (debrief P0.3).** *DONE.* `examples/webgpu-check` now
  mounts the full `PathEditor` under `WebGPURenderer` and is render + select + drag
  interactive (validated headless & headed on Apple Metal-3 via a Playwright oracle
  driving system Chrome). Labels/midpoint pivot gated off pending RigLabel. Note: the
  package DIST must be rebuilt for the example to pick up changes (a stale dist with
  ungated troika text is what first surfaced the device-loss chain).

### 3c-4 — extract the drive-loop into the package  ·  = debrief P1.1
**DONE.** The per-frame orchestration is extracted and framework-agnostic:
`driveTimeline` (`/timeline`) steps the player → `evaluateTimeline` → publishes cart
frames → parks the pose + runs the composer; `driveActivation` + `createRigDriveState`
(`/three`) hold the shared brain + composer state; and **`driveRig(state, camera,
intent, dt)` (`/timeline`)** dispatches idle/timeline/activation with one call. The
r3f `useRigDrive` (`/r3f`) is now a thin `useRef`+`useCallback` wrapper over `driveRig`
— so a non-r3f runtime (headless render, elastiq) drives the rig identically with its
own camera + loop, no r3f. The demo consumes `useRigDrive`; the twin can drop its
hand-written `PathRigDriver.useFrame`. `applyScreenComposerAim`/`getScreenCorrection`
already moved to `/three`; `vcamTrackTargetId` already in `core/virtual-camera.ts`.

Remaining 3c-4 cleanup: *none.* The composer-config reconciliation is DONE —
`ScreenComposerOptions` is gone; the composer consumes flat `ComposerSettings`
throughout (no consumer-side flat→nested mapping).

### Camera bodies — orbit + manual override DONE; follow / positionCompose deferred
**Orbit body DONE.** A pure `orbit` body (`azimuth/elevation/radius`
+ `autoOrbitDegPerSec` advanced from the resolve clock, so scrub-safe) with three
binding modes — `world` (compass-anchored), `lockYaw` (follows target heading, level
horizon), `lock` (welded) — resolving in `resolveVirtualCameraDefinition` (`/three`).
Target orientation flows through `getTargetOrientation` on the resolve context, backed
by `TargetRegistry.resolveOrientation` + `registerObjectTarget` (pulls world quaternion);
target-relative binding degrades to `world` when orientation is absent. Shared placement
helpers (`orbitOffset`/`orbitParamsFromLocalOffset`/`orbitBindingQuaternion`/
`buildOrbitRingPoints`) back both resolution and the `OrbitVcamGlyphRig` authoring/debug
gizmo (ring + radius arm + binding-frame triad + camera glyph + translate handle). The
minimal demo authors orbit bodies against a spinning turbine target. Covers the twin's
overview (world) and detail (lockYaw) wind-turbine views. Model = body (position) + aim
(orientation) independent, per Cinemachine's Position/Rotation-Control split.

**Manual override DONE — unified pivot-orbit, any vcam** (the twin's OrbitControls model).
`control: CameraOverrideSettings` lives on the vcam **definition** (not the body), so any
shot — `static`/`cart`/`orbit` — can be flown: **LMB** orbit azimuth/elevation around a
pivot, **RMB** pan the pivot (re-frames), **wheel** damped dolly (min/max clamp), per-axis
`locked`/`free`/`recenter`. The pivot is the aim target → orbit target → a synthesized
point-in-front. Resolution stays pure: `stepCameraOverride` + `resolveCameraPivot` are a
stateful post-stage (`RigBodyState` in `RigDriveState`, mirroring `stepComposerAim`) that
decomposes/recomposes the coded pose around the pivot; exact passthrough when idle, owns
pose+aim (composer skipped) when live. **Both** drivers apply it — `driveActivation` and
`driveTimeline` (on the active block, skipped mid-blend) — so piloting works under an
activated shot and under timeline playback. Input mapping is **promoted to the package**:
`createOverrideInputAccumulator` (`/three`, framework-agnostic pointer/wheel → override) +
`<CameraOverrideSurface>` (`/r3f`, transparent capture layer owning pointer/wheel). The twin
mounts the surface while a vcam is live, disables its own OrbitControls, and passes
`accumulator.drain()` as the drive intent's `overrideInput` — no re-implementation. Matches
the twin's manual-override + return-to-coded orbit, not a regression of it.

**Deferred (planned):** the `follow`/third-person body, the `positionCompose` body, and
binding-frame **position damping** (smoothing the camera toward a *moving coded target* —
distinct from the manual override; the `RigBodyState` channel can host it). Research
synthesis, architecture, task breakdown, risks, and alternatives:
[the deferred-camera-bodies plan](../plans/2026-07-06-deferred-camera-bodies-v1.md).

**Not promoted (deliberate):** the demo's edit/play `viewMode` + camera-swap compositor +
OrbitControls gating are app-shell — the twin has its own shell (OrbitControls, PiP,
path-rig gating), so imposing one isn't wanted. The reusable seam is the override + input
surface + drive `overrideInput`, which *is* in the package.

### F3 — dolly motion as an editable speed curve
Replace discrete dolly move-blocks with a per-dolly **motion curve** (keyframes of
position-over-time on the dolly lane): flat = parked, sloped = moving, curve shape =
speed/accel/damping. Simpler mental model ("the dolly's journey") and the natural home
for fine speed control. Data is already cart-track keys, so this is a UI/authoring change,
not a data rework. Decision (this session): don't invest further in the block UI; do the
curve here. Needs a custom curve-editing lane (the current @xzdarcy lane does blocks/actions,
not 2D keyframe curves).

> Shares the @xzdarcy dependency risk called out in debrief **P2.2** (multilane
> timeline reuse): the same limitation (blocks/actions, not 2D curves) plus its
> unmaintained transitive `react-virtualized` argue for a lighter in-house lane —
> do F3's curve lane and P2.2's reuse together.

### Scroll-driven timeline (scrollytelling demo)
A demo where **page scroll scrubs the timeline**: scrolling down advances `t`,
scrolling up rewinds — carts move, cameras cut/blend, and views change as the
reader scrolls, for a scrollytelling narrative. Cheap by construction: the
timeline is a **pure evaluator** (`evaluateTimeline(timeline, ctx, t)` is a
function of `t` with no internal clock), so a scroll handler just maps scroll
progress → `t` via `seekTimelinePlayer` (scrub semantics, no event double-fire)
and drives a frame — no playback clock needed. Build as a new `examples/`
scrollytelling scene (map `scrollTop/scrollHeight` → `t`, optionally smooth/damp
the mapping so scroll feels inertial). Pairs well with the new follow/orbit
camera bodies for "view changes as you scroll". Consider a small reusable
`useScrollTime` hook in `/r3f` if the mapping proves generally useful.

## Known gaps / smaller items

- **Conditional: smooth Web Audio gain automation if crossfade artifacts are observed.**
  Overlapping clips already receive automatic complementary crossfade weights, multiplied
  by authored clip envelopes and track gain. The player currently applies the evaluated
  gain once per render frame. Do not add scheduling complexity preemptively; if audible
  zipper noise or clicks are reproduced, ramp or time-constant-smooth `GainNode.gain`
  updates and add an audio regression/manual verification case.
- Legacy migration: pre-RigDocument saved shows (old `SHOW_STORAGE_KEY`) do NOT migrate
  dolly moves into per-dolly runs (edge case; only affects saves made before this session's
  storage change). Shots/paths/targets still migrate.
- ~~Dolly `speed` is global~~ **DONE (demo).** Each dolly now carries its own free-run
  `speed` (per-cart), authored via a per-dolly slider in the Dollies section and threaded
  into each cart's `createPathCart({ speed })`. Uses `RigCartDefinition.speed`, which always
  supported it; the demo previously collapsed it to one global value.
- The demo `TrackingTargetDefinition` group variant isn't authored (`SceneTarget` excludes it);
  target groups (weighted multi-subject framing) are unimplemented in the demo UI.
