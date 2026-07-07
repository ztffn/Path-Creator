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

### Camera bodies — orbit DONE; follow / positionCompose / stateful channel deferred
**Orbit body DONE (this session).** A pure `orbit` body (`azimuth/elevation/radius`
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

**Interactive control DONE** (Cinemachine OrbitalFollow input axes + recentering): per-axis
`locked`/`free`/`recenter` on the orbit body, live `OrbitInput` (pointer/wheel) fed via the
activation driver into a stateful `RigBodyState` post-stage (`stepOrbitBody`/`applyOrbitLive`)
that mirrors `RigComposerState`/`stepComposerAim` — resolution stays pure, timeline playback
stays scrub-safe. The twin's manual-override + return-to-coded orbit is matched, not regressed.
Demo pilots it via a PiP pad + per-axis mode UI.

**Deferred (planned):** the `follow`/third-person body, the `positionCompose` body, and
binding-frame **position damping** (smoothing the camera toward a moving coded target — the
`RigBodyState` channel now exists and can host it). Research synthesis, architecture, task
breakdown, risks, and alternatives:
[the deferred-camera-bodies plan](../plans/2026-07-06-deferred-camera-bodies-v1.md).

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

- Legacy migration: pre-RigDocument saved shows (old `SHOW_STORAGE_KEY`) do NOT migrate
  dolly moves into per-dolly runs (edge case; only affects saves made before this session's
  storage change). Shots/paths/targets still migrate.
- Dolly `speed` is global (rig speed applied to all carts at document-assemble time); per-cart
  speed would be more capable. `RigCartDefinition.speed` already supports it.
- The demo `TrackingTargetDefinition` group variant isn't authored (`SceneTarget` excludes it);
  target groups (weighted multi-subject framing) are unimplemented in the demo UI.
