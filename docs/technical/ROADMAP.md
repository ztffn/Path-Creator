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
- **Node-material thickness on WebGPU.** RigLine's WebGPU branch renders thin;
  upgrade it to `Line2NodeMaterial` (fat, WebGPU-native) so lines are thick on
  both backends. Dashed lines are also dropped on the WebGPU branch until then.
- **Drop drei for lines entirely.** Replace the WebGL branch's drei `<Line>` with
  `three/addons` `Line2` so lines need *zero* drei (drei fully optional, not just
  peer-optional) — the "graceful fallback with no drei" goal.
- **Pluggable, WebGPU-safe gizmo (debrief P0.2).** *DONE.*
  `RigGizmo` (`src/r3f/rig-gizmo.tsx`) — `RigGizmoComponent` interface + `PivotGizmo`
  default + `TransformGizmo` (three `TransformControls`, WebGPU-safe). Both `PathEditor`
  (handle pivot) and `PointTargets` (target pivot) route through the seam and are
  validated editable on WebGPU (select + drag move real data, no device loss).
  Note: TransformGizmo enables all layers on its picking raycaster so it stays
  grabbable when a host parks it on the reserved EditorHelpers layer.
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
**Integration-validated:** the twin reinvented this loop by hand
(`PathRigDriver.useFrame`) because it wasn't extracted — confirming the need.
The per-frame orchestration (step player → `evaluateTimeline` → position carts →
drive camera brain → composer) currently lives in `examples/minimal-r3f-demo/src/App.tsx`
`Scene.useFrame`. Extract a framework-agnostic `driveRig`/`stepRig` (state holder:
brain + composer state + composed quaternion + cart stepping) into `/three` (needs
only a three `Camera`, no r3f), with a thin `useRigDrive` `useFrame` wrapper in `/r3f`.
Makes rig playback reusable by the twin/elastiq without r3f. This is the modularity endgame.

Rolled into 3c-4 (deferred from the /simplify altitude pass):
- Move the composer function (`applyScreenComposerAim`, `getScreenCorrection`) from
  `/r3f` to `/three` — it's pure three.js (takes a `Camera`), misfiled in r3f.
- Reconcile the two composer-config shapes: flat `ComposerSettings` (core) vs nested
  `ScreenComposerOptions` (r3f). Have the composer consume `ComposerSettings` directly
  (or make one extend the other) so consumers stop hand-mapping flat→nested.
- Move `vcamTrackTargetId` (pure accessor over `VirtualCameraDefinition`) into
  `core/virtual-camera.ts` — it belongs with the aim, not in the demo.

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

## Known gaps / smaller items

- Legacy migration: pre-RigDocument saved shows (old `SHOW_STORAGE_KEY`) do NOT migrate
  dolly moves into per-dolly runs (edge case; only affects saves made before this session's
  storage change). Shots/paths/targets still migrate.
- Dolly `speed` is global (rig speed applied to all carts at document-assemble time); per-cart
  speed would be more capable. `RigCartDefinition.speed` already supports it.
- The demo `TrackingTargetDefinition` group variant isn't authored (`SceneTarget` excludes it);
  target groups (weighted multi-subject framing) are unimplemented in the demo UI.
