<!--
GEOSPATIAL-INTEGRATION-DEBRIEF.md — post-mortem + fix backlog from the first
real consumption of @huma/path-creator by an external app (the three-geospatial
"digital twin", a WebGPU R3F globe). Records the snags/root causes we hit while
rushing the integration, and a prioritized backlog to make the package a smooth
drop-in for the NEXT iteration of that app's geospatial editor. No code changes
here — this is the plan the next dedicated session executes.
-->

# Path-Creator × three-geospatial integration debrief

**Date:** 2026-07-06 · **Consumer:** `three-geospatial` digital twin
(`examples/ocean-globe-waterpro-demo`, WebGPU R3F globe; deployed
`twin.humatopia.ai`). **Package at integration:** `@huma/path-creator@0.2.0`.

The goal of Path-Creator is a **smooth install of a reusable path/camera/timeline
system**. This first real consumption was rushed (demo deadline), so it became a
brute-force: the package could not render its own editor in the consumer's
renderer, and the consumer had to reinvent runtime pieces. Everything below is
what to fix so the next geospatial-editor iteration *reuses* rather than
reinvents.

## What the consumer actually did (the workarounds to replace)

- Consumed the package as a **vendored tarball** (`vendor/*.tgz` + `file:` dep),
  repacked on every package change. (Distribution, P3.)
- Used the package's `/core` (BezierPath edit model, VertexPath sampling,
  `TargetRegistry`) and `/timeline` (`evaluateTimeline`, player) — these worked.
- Could **not** use `/r3f` `PathEditor`/`PointTargets` or the `/timeline-ui`
  in-canvas bits — they render with WebGL-only materials (see B). Built a
  **hand-rolled WebGPU-native editor** in the twin instead
  (`storybook-webgpu/src/pathrig/PathRigDriver.tsx`).
- **Replicated the drive-loop** by hand (step → evaluate → apply per frame).
- Wrote all **ENU↔ECEF anchoring** host-side (rig-local y-up → globe ECEF).
- **Bypassed the vcam aim** with a hardcoded world-space `lookAt` (the package
  aim quaternion rolled 90° through the rotated parent).

## What worked (keep, don't regress)

`/core` is genuinely portable and renderer-agnostic — the BezierPath mutation
API (`movePoint`/`splitSegment`/`deleteAnchor`/`setAnchorNormalAngle`),
`VertexPath` sampling, `TargetRegistry`, `RigDocument` serialize/parse +
`buildRigRuntime` validation, and `/timeline` `evaluateTimeline`/player. The
whole edit model was reused verbatim. The dual ESM+CJS build (fixed mid-flight)
and the widened `three` peer range now work.

---

## Snags & root causes

### A. Packaging assumed browser/bundler-only consumption
- **ESM-only broke Node-side consumers.** A consumer's `vite.config.ts` imported
  server middleware that (transitively) imported the package; Vite bundles the
  config as **CJS**, so the ESM-only package threw *"This package is ESM only
  but it was tried to load by require"* at config load — before anything ran.
  Fixed reactively → `tsup format: ['esm','cjs']` + `require` conditions (0.1.2).
- **`three` peer pinned `^0.181.0`** rejected the consumer's `0.183.2`. Widened
  to `>=0.181.0 <0.190.0`. Caret-pinning a fast-moving peer is the anti-pattern.
- **No registry publish** → vendored-tarball churn (repack/bump/reinstall/commit
  every change).

### B. THE BLOCKER — the r3f editor UI is WebGL-only
- `PathEditor` and `PointTargets` draw lines with drei `<Line>`, and drei
  `PivotControls` (the drag gizmo) draws its axes with drei `<Line>` too. drei
  `<Line>` instantiates **`LineMaterial`** from `three-stdlib` — a WebGL fat-line
  material. The consumer runs three's **WebGPU node renderer**, which has no
  auto-map for `LineMaterial` (only `LineBasicNodeMaterial` / `Line2NodeMaterial`
  exist). Result: `THREE.NodeMaterial: Material "LineMaterial" is not
  compatible` → an infinite `drawIndexed` → **GPU device loss** (looked like a
  page reload).
- Also bit the consumer's ocean **depth pre-pass**: it overrides every mesh
  material and re-renders the scene; the editor's fat lines on the shared camera
  crashed there too until the consumer excluded the editor-helpers layer.
- **Root cause:** built and only ever validated against a **WebGL** demo. No
  WebGPU surface, so the incompatibility was invisible until the consumer's
  browser. This is the single reason the flagship editor couldn't be reused.

### C. Runtime pieces the consumer had to reinvent
- **Drive-loop not extracted** (long-pending "3c-4", see
  `STAGE-3C-HANDOFF.md`). Every consumer must hand-write the per-frame
  `stepTimelinePlayer → evaluateTimeline → apply cartFrames / vcam snapshot`.
- **No georeferencing/anchoring story.** The package assumes a flat,
  identity-parent world. On a globe the consumer wrote all ENU↔ECEF placement
  (anchor group orientation `makeBasis(east, up, -north)`, rig-local → world).
- **Camera-follow through a transformed parent rolls 90°.**
  `applyVirtualCameraSnapshot` (and the aim resolution) assume the camera is at
  world root; composing the snapshot through a rotated ENU parent tilted the
  horizon. Consumer bypassed with a world-space `camera.lookAt(centroid)` + a
  fixed up-vector.

### D. Editor ergonomics
- **Fixed absolute handle/line sizes** (tuned to the demo's unit scale) were
  huge at site scale (metres) — hard to grab, overlapping. No scale-aware or
  configurable sizing. Consumer hand-set `HANDLE_RADIUS`/gizmo `size`.
- **Multilane timeline editor** (`/timeline-ui` `TimelineLanes`) exists but ships
  the heavy `@xzdarcy/react-timeline-editor` (+ unmaintained transitive
  `react-virtualized`). The lanes themselves are DOM (renderer-agnostic), but it
  was deferred and unproven in the consumer.

### E. Process
- Rushing → reactive one-crash-at-a-time patching instead of a designed
  consumption contract; no cross-renderer test; browser was the only oracle.

---

## Fix backlog (prioritized)

> Legend — **Effort:** S(<½ day) M(~1 day) L(multi-day). Each item lists the
> symptom, the fix, affected package surface, and acceptance criteria.

### P0 — WebGPU-safe rendering (unblocks reuse; delivers "thicker lines")

**P0.1 — Renderer-agnostic line component.** *(M)*
Replace drei `<Line>` inside `PathEditor`/`PointTargets` (and any in-canvas
`/timeline-ui` preview) with an internal `<RigLine>` that picks the material by
renderer: WebGPU → `Line2NodeMaterial` (fat, works) or `LineBasicNodeMaterial`;
WebGL → keep drei/`LineMaterial`. Detect via the R3F `gl` (`gl.isWebGPURenderer`
or the backend tag). Expose `width` in the theme (your "thicker lines").
- Surface: `src/r3f/path-editor.tsx`, `src/r3f/point-targets.tsx`, new
  `src/r3f/rig-line.tsx`; extend `PathEditorTheme`/`PointTargetsTheme` with
  line-width fields.
- Accept: both a WebGL and a WebGPU example render the path + handles with no
  `LineMaterial` incompatibility and no `drawIndexed` crash.

**P0.2 — Pluggable, WebGPU-safe gizmo.** *(M)*
drei `PivotControls` is WebGL-only (fat-line axes). Offer three's built-in
`TransformControls` (its `LineBasicMaterial` gizmo auto-maps in WebGPU — proven
in the twin) as the default/selectable editor gizmo. Make the gizmo pluggable:
`PathEditor`/`PointTargets` take a `gizmo?: 'pivot' | 'transform' | custom`.
- Surface: `src/r3f/path-editor.tsx`, `src/r3f/point-targets.tsx`.
- Accept: dragging anchors/targets works in WebGPU with no crash; WebGL demo
  still offers PivotControls.

**P0.3 — WebGPU validation surface.** *(M)*
Add a WebGPU example (or a story) rendering the full editor under
`WebGPURenderer`, so B-class regressions are caught in-repo, not in a consumer's
browser. This is the guardrail that makes the package trustworthy on WebGPU.
- Surface: `examples/` (new minimal WebGPU editor) or a story; CI/dev check.
- Accept: the WebGPU example mounts `PathEditor`+`PointTargets`+timeline and is
  interactive; documented as the cross-renderer test.

### P1 — Runtime completeness (removes host reinvention)

**P1.1 — Extract the drive-loop** (the pending 3c-4). *(M)*
Ship `stepRig(runtime, player, dt)` (pure) + `useRigDrive({runtime, player,
onCartFrames, onCamera})` (r3f). The consumer's `PathRigDriver.useFrame` is the
reference implementation to generalize.
- Surface: `/three` (pure `stepRig`) + `/r3f` (`useRigDrive`); see
  `STAGE-3C-HANDOFF.md` §3c-4 (it says keep editor chrome in the demo — still
  true; extract only the loop).
- Accept: the demo and the twin can both drop their hand-written loop.

**P1.2 — Camera-follow through arbitrary parent.** *DONE.*
Root cause: `applyVirtualCameraSnapshot` set the camera's *local* pose from a
rig-space snapshot, and `stepComposerAim` mixed local `camera.position/quaternion`
with a world-space target + used a rig-space up — all correct only when the driven
camera is at world root. Fix: thread an optional `rigMatrix` (the rig root's world
matrix) through the drive params (`RigTimelineParams`/`RigActivationParams` →
`driveRig`/`useRigDrive`). When set, the snapshot is composed through it
(`world = rig · local`, decomposed onto the world-root camera) and the composer's
target (point) + up (direction) are transformed to world (`applyMatrix4` /
`transformDirection`) — so the horizon levels to the rig's up, not world-Y. Omit it
(or pass identity) and behaviour is byte-identical to before (the current demo).
- Surface: `/three` (`applyVirtualCameraSnapshot`, `applyVirtualCameraBrain`,
  `driveVirtualCameraBrain`, `stepComposerAim`, `driveActivation`), `/timeline`
  (`driveTimeline`). Host passes its rig group's `matrixWorld` as `rigMatrix`.
- Accept: met. Unit-tested (rotated+translated + rolled parents: correct world
  pose, level horizon via screen-right ⟂ rig-up, world-space composer target).
  No consumer-side `lookAt` bypass needed.

**P1.3 — Georeferencing / anchoring helper + doc.** *(M)*
A small `<RigAnchor frame={...}>` (or a transform util) that mounts a rig in a
host-supplied basis, plus a doc section "embedding a rig in a world frame
(ENU/ECEF)". Codify the `makeBasis(east, up, -north)` + rig-local-y-up
convention the twin discovered.
- Surface: `/r3f` (`RigAnchor`), `camera-system-implementation.md` (embed guide).
- Accept: a globe consumer places a rig without writing ENU math.

### P2 — Editor UX for the next geospatial editor

**P2.1 — Scale-aware / configurable handle + line sizing.** *(S)*
Handle radius and line width as theme fields (world units and/or
screen-constant). Ships with P0.1's width work.
- Accept: handles readable at metre-scale sites without host overrides.

**P2.2 — Multilane timeline editor, reusable + themed.** *(M–L)*
Prove `/timeline-ui` `TimelineLanes` as the next editor's timeline: it is DOM
(renderer-agnostic) so it drops into any host, but (a) its optional in-canvas
PiP/frustum preview needs P0's WebGPU-safe line/gizmo, and (b) de-risk the
`@xzdarcy` + `react-virtualized` dependency (pin, wrap in the existing error
boundary, or plan a lighter in-house lane UI per `ROADMAP.md` F3).
- Accept: a host mounts multi-vcam/cart lanes with a theme and no WebGPU concern
  for the lanes; documented integration.

### P3 — Distribution

**P3.1 — Publish to a registry.** *(S)*
Publish `@huma/path-creator` (private npm / GHCR npm) so consumers install by
version instead of vendoring a tarball. Kills the repack/bump/reinstall churn.
- Accept: consumer depends on `@huma/path-creator@^x` from the registry;
  document the release flow.

---

## Suggested order

P0.1 → P0.2 → P0.3 (unblocks the editor on WebGPU and delivers thicker lines and
a regression guard) → P1.1/P1.2/P1.3 (stop consumers reinventing) → P2 (the
next editor's UX: sizing + multilane timeline) → P3 (publish). P0 is the
foundation the multilane editor's in-canvas bits also depend on.

## References
- `docs/technical/STAGE-3C-HANDOFF.md` — drive-loop extraction (3c-4) plan.
- `docs/technical/camera-system-implementation.md` — camera/motion reference +
  embed guide (extend for P1.3).
- `docs/technical/ROADMAP.md` — F3 (speed-curve / lane UI direction).
- Consumer reference impl (WebGPU-native editor + drive-loop + ENU anchoring):
  `three-geospatial/storybook-webgpu/src/pathrig/PathRigDriver.tsx` and
  `examples/ocean-globe-waterpro-demo/{rig,app,ui}/`.
