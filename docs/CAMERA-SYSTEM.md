# @huma/path-creator — Camera & Motion System

Complete reference for the Cinemachine-style path/camera/timeline system, written
for a fresh session integrating it into the twin demo
(`three-geospatial/examples/ocean-globe-waterpro-demo`) as a proof of concept.
State as of 2026-07-05, commits `4046912..7145618`, 95 package tests green.

## Repo & commands

- Package: `Packages/path-creator` (`@huma/path-creator`, three `^0.181`, ESM only).
- Demo: `examples/minimal-r3f-demo` — **consumes the package's `dist/`**; after any
  package change run `pnpm --filter @huma/path-creator build` or the demo sees stale code.
- Verify: `pnpm --filter @huma/path-creator lint` (tsc), `... test` (vitest, 95),
  `pnpm --filter minimal-r3f-demo build`.
- Entry points: `@huma/path-creator/core` (pure data+math, no three),
  `/three` (vanilla three adapter), `/r3f` (React Three Fiber), `/timeline` (runtime).

## Architecture in one paragraph

Paths are geometry. **Carts** are the only coupling seam: a cart is a frame
(position + orthonormal basis) riding one path — anything mounts a cart (props,
and virtual-camera bodies). **Virtual cameras** are definitions resolved per
frame through the stage pipeline **body → aim → noise → lens** into plain
`VirtualCameraSnapshot`s; the **brain** cuts/blends snapshots onto a real
camera. **Targets** are id-registered position sources for aims. The
**timeline** is a pure evaluator: same `t` in, same world out — which is what
makes scrubbing, tours, and network replay trivial. Everything persistable is
versioned (`RigDocument` v2, `Timeline` v1).

## core — data & math

### Paths
- `BezierPath` (anchors/controls, modes aligned/mirrored/free/automatic,
  `toJSON()/fromJSON` → `SerializedBezierPath`), `VertexPath` (baked, constant-speed
  queries: `getPointAtDistance`, `getDirectionAtDistance`, `getNormalAtDistance`,
  `resolveDistance(d, EndOfPathInstruction)`).
- `EndOfPathInstruction`: `Loop | Reverse (ping-pong) | Stop`.
- Closed 3D loops: parallel-transport normal seam correction is ported from Unity
  (`buildNormals`) — do not remove; cart orientation depends on it.

### Carts (`core/cart.ts`)
- `PathCart { distance, speed, endOfPathInstruction, orientationMode, positionOffset }`
  - `orientationMode`: `"path-frame"` (tangent/normal), `"path-yaw"` (flat forward,
    world up), `"fixed"` (world axes).
  - `positionOffset` is rail-local `{x: right, y: up, z: forward}` — see
    `offsetAlongBasis(base, basis, offset)`, the single definition of that convention.
- `advanceCartDistance(path, cart, dt)` → next distance (pure; caller stores it).
- `sampleCartFrame(path, cart, atDistance?)` → `CartFrame { position, railPosition,
  forward/up/right, distance, time }` — pure random access; **timelines position carts
  from `t`, never by stepping** (determinism contract).
- `orthonormalBasis(forward, up)` — shared basis + degenerate-up fallback used by
  both cart frames and camera quaternions.

### Virtual camera data (`core/virtual-camera.ts`)
- `VirtualCameraDefinition { id, body, aim?, noise?, lens?, settings? }`
  - body: `{ type:"static", position, quaternion }` or
    `{ type:"cart", cartId, positionOffset? }` (offset composes on top of the cart's own).
  - aim: `{ type:"body" }` or `{ type:"look-at", target: Vec3 | { targetId } }`.
  - noise: seeded value-noise `{ seed, positionAmplitude, positionFrequency,
    rotationAmplitudeDeg, rotationFrequencyDeg }` (scalar or per-axis) — pure fn of
    (settings, time): scrubbing reproduces identical shake.
  - lens: `{ fov, zoom, near, far, orthographicSize, dutchDeg }` (dutch = roll,
    applied at snapshot-apply time; blends with absence-as-zero).
- `VirtualCameraSnapshot { position, quaternion, lens?, settings?, name? }` — the
  universal currency; everything blends/applies snapshots.
- `evaluateVirtualCameraBlendCurve(t, curve)` — easing vocabulary
  `cut|linear|easeIn|easeOut|easeInOut|hardIn|hardOut`, shared with cart keys.

### Targets (`core/targets.ts`)
- `TargetRegistry`: `register(id, () => Vec3|null, name)` → disposer;
  `resolve(id)`; `resolveGroup(members)` weighted centroid; `subscribe`/`version`
  for live UI lists; `list()`.

### Rig document (`core/rig.ts`) — the persistence contract
- `RigDocument` schemaVersion 2: `paths[] {id, bezier, sampling?}`,
  `carts[] {id, pathId, ...cart}`, `vcams?: VirtualCameraDefinition[]`,
  `targets?`, `timelines?: (Timeline & {id})[]`.
- `buildRigRuntime(doc)` → `{ paths, carts, cartPaths, vcams, targets, timelines }`
  Maps; validates every cross-reference; accepts v1; sorts timeline tracks
  (evaluator invariant).

### Timeline schema (`core/timeline.ts`)
- `Timeline { schemaVersion:1, duration, gapMode?, tracks }`
- `CameraTrack { blocks: { id, vcamId, start, end, blendIn?: {durationSeconds,
  curve?}, overrides?: Partial<VirtualCameraDefinition> }[] }` — `overrides`
  shallow-patch the definition per block (a retarget = aim override).
- `CartTrack { cartId, keys: { time, distance, easing? }[] }` — drives that cart.
- `EventTrack { events: { id, time, kind, payload? }[] }` — opaque to the package.
- `createTimeline()` sorts tracks (`sortTimelineTracks`); re-sort after editing times.

## three — vanilla adapter (all functions, no React)

- Resolution: `resolveVirtualCameraDefinition(def, ctx)` → snapshot|null, where
  `ctx = { getCartFrame?, getTargetPosition?, elapsedSeconds? }`. Null when a cart
  is unavailable; unresolvable aim target keeps body orientation.
- Conventions: `applyCartFrameToObject(object, frame)` puts a PROP's **+Z** along
  forward; `cameraQuaternionFromFrame(forward, up)` makes a CAMERA look along
  forward (**-Z**). Don't mix them up.
- Brain: `createVirtualCameraBrainState(initial?)`,
  `activateVirtualCameraBrain(state, snapshot, {durationSeconds, curve})` (cuts if
  no previous/0s/"cut"), `applyVirtualCameraBrain(camera, state, dt)`,
  `retargetVirtualCameraBrain(state, {previous?, target?})` (both blend endpoints
  stay live), and the per-frame protocol
  `driveVirtualCameraBrain(camera, state, definition, ctx, dt)` =
  resolve → retarget → step+apply. Hosts: activate once on shot change, then call
  drive every frame.
- Snapshots: `captureVirtualCameraSnapshot(camera)`, `applyVirtualCameraSnapshot`,
  `blendVirtualCameraSnapshots(from, to, t, {curve})`.
- Targets: `registerObjectTarget(registry, id, object3d)`,
  `registerObjectTargets(registry, root, { names?|pattern?|filter?, idPrefix?,
  includeRoot? })` — walks a GLB scene, ids `<prefix>/<node.name>`, world position
  through parent transforms, one disposer.
- Editor layers: `EDITOR_HELPERS_LAYER = 30`, `markEditorHelpers(root)` (cheap to
  re-assert per frame), `showEditorHelpers(camera)` / `hideEditorHelpers(camera)`.
  Edit-vs-play is one camera bit; **the pointer raycaster also needs the layer**
  (`Raycaster.layers` defaults to layer 0 — this bit us).

## r3f — hooks & components

- `usePathCart({path, speed, mode, orientationMode?, positionOffset?, initialDistance?})`
  → `{cart, step(dt), sampleAt(d?), reset}`; `usePathFollower`, `useDollyCamera`
  (screen-composer aim with Cinemachine lookahead: higher smoothing = more lag),
  `applyScreenComposerAim` (stateful damping stage — NOT part of pure resolution).
- Targets: `TargetRegistryProvider` (optional; module default registry),
  `useTargetRegistry()`, `<TrackingTarget targetId name?>` wrapper,
  `useTrackingTarget(id, ref, {name?, registry?})`,
  `useObjectTargets(rootOrRef, options, registry?)`,
  `useRegisteredTargets(registry?)` (live list via useSyncExternalStore).
- Editor: `<EditorHelpers>` (keeps subtree on layer 30, re-asserted per frame for
  async children like troika text / gizmo internals), `useEditorHelpersVisible(visible?)`
  (enables layer on viewport camera AND raycaster).

## timeline — the runtime

- `evaluateTimeline(timeline, { rig: {paths, carts, cartPaths}, vcams,
  getTargetPosition? }, t)` → `{ camera, cartFrames, activeBlock, blendProgress }`.
  **Pure function of t**: cart distances come from CartTrack keys (eased lerp,
  clamped at ends) or `cart.distance + cart.speed * t`; noise reads `t`; blends
  resolve BOTH shots live at `t`.
- Camera semantics: active block = last with `start <= t`; inside a `blendIn`
  window the previous block blends in (duration = blendIn.durationSeconds);
  before the first block → `camera: null`.
- **gapMode** (`"hold"` default | `"release"`): what happens when the playhead is
  past a block's `end` but before the next block's `start`. *hold* keeps showing
  the last shot (editing-software behavior). *release* returns `camera: null`
  so the HOST's own camera takes over (Cinemachine behavior — e.g. the twin's
  normal orbit camera resumes between tour shots). It's a per-show policy for
  embedding hosts, not a viewer setting; the demo doesn't expose it.
- Multiple camera tracks layer: later tracks override earlier (interrupt track).
- Events: `collectTimelineEvents(timeline, t0, t1)` half-open forward window;
  `createTimelinePlayer / stepTimelinePlayer(player, timeline, dt)` (edge-fires
  events exactly once, pauses at end, `loop` wraps) /
  `seekTimelinePlayer` (never fires events).
- **Overlap = crossfade is HOST policy**: the schema stores explicit `blendIn`;
  the demo compiles clip overlap → `blendIn { duration: overlap, easeInOut }`,
  touch → cut, later-start = incoming (Cinemachine). Copy that compile step.

## Demo implementation (reference integration, App.tsx + TimelineLanes.tsx)

- Shot model `DemoVirtualCamera`: `{ id, name, bodyType static|cart, cartId,
  cartOffset, trackTargetId, noisePreset, dutchDeg, shotStart, shotEnd,
  railFrom|railTo (null = free-run), snapshot, poseSource/aimMode/composerSettings }`.
  `toDemoVcamDefinition(vcam)` maps it to a `VirtualCameraDefinition`.
- World model: `paths[] {id, name, bezier}` (one ACTIVE editable spline, others
  render dashed; `switchPath` serializes/loads), `dollies[] {id, name, endOfPath,
  pathId}`. Everything (+ vcams) persists to localStorage key
  `path-creator:minimal-demo:show` as `{dollies, vcams, paths, activePathId}`.
- Frames plumbing: `dollyFramesRef: Map<dollyId, CartFrame>` — filled per frame by
  live free-run carts; **while the timeline drives, evaluated `sample.cartFrames`
  overwrite it** so glyphs/previews match playback.
- PiP driver state machine: `pipDriver: "shots"|"timeline"` — transport/scrub
  claims timeline; selecting/activating a shot claims shots and pauses the player.
  `activeVirtualCameraId` is DERIVED from the activation (`activation.toId`).
  Activation branch: on new key `activateVirtualCameraBrain(resolved)`, then every
  frame `driveVirtualCameraBrain(brainCamera, brain, def, ctx, delta)`.
- Timeline compile (`demoTimeline` memo): blocks from shots sorted by start;
  overlap→blendIn; per-dolly `CartTrack` from shots' `railFrom/railTo` (keys at
  block start/end, easeInOut). **Memo keyed on timing fields only** — rebuilding
  editorData at pointer rate (gizmo drags) crashed the lane editor once
  (update-depth loop). Never key it on the whole vcam objects.
- Lane editor (`TimelineLanes.tsx`): @xzdarcy/react-timeline-editor as a
  CONTROLLED shell — their engine is never used; cursor slaved via `setTime`
  (only when changed — setTime forceUpdates); one shot track (all clips) + one
  read-only dashed lane per dolly with moves (click selects owning shot); blend
  wedge drawn on incoming clip; full containment vetoed (Cinemachine Mix);
  0.25s snap; wrapped in an error boundary so a lane crash can't kill the canvas.
- Layout: left panel = world (Path Editing, Paths, Dollies), right = cameras
  (capture, blend, shots w/ Track·Noise/Dutch·Dolly/Rail·Composer rows), bottom-center
  dock = timeline. PiP bottom-right shows whichever camera drives (rig/brain/timeline);
  frustum helper binds to that camera and tints by state
  (green live / orange selected / slate rig). Semantic palette: orange=selected,
  green=live, blue=rig/motion, cyan=targets, slate=idle.

## Twin PoC integration recipe (tomorrow)

Twin seams (see memory `twin_visitor_author_mode_split`): `app/cameraCommands.ts`
reserves `{ type: 'follow-path' }`; `sites/types.ts` `SiteTour.path` is
`SerializedBezierPath` in site-ENU meters; `AuthorSlotContext.dispatchCamera`.

1. **Frame**: keep the package coordinate-agnostic — do everything in a site-ENU
   group (the twin already places content ENU-at-anchor). Author `BezierPath` in
   ENU meters (heights included, `PathSpace.XYZ`).
2. **Rig**: build in memory first (skip RigDocument until persistence):
   `VertexPath` from the tour path; one `PathCart` per dolly; vcams
   `{ body: {type:"cart", cartId}, aim: {type:"look-at", target:{targetId}} }`;
   register targets from twin objects (`registerObjectTargets(registry, shipModel,
   { pattern: /.../ })` or `registry.register("platform", () => enuPos)`).
3. **Timeline**: blocks per shot + CartTracks (copy the demo's compile), or author
   directly. `gapMode: "release"` is likely RIGHT for the twin: between tour shots
   the normal `CameraRig` keeps control.
4. **Drive**: implement the `follow-path` CameraCommand as a mode that, while
   active, each frame does `const s = evaluateTimeline(tl, ctx, player.time)` and
   applies `s.camera` to the twin camera (`applyVirtualCameraSnapshot`) — bypassing
   OrbitControls/CameraRig while `s.camera != null` (that's what release gives you:
   null = hand back to CameraRig). Step the player with frame delta; fire
   `activeEvents` into panels/layer overrides.
5. **Gotchas**: three pinned 0.183.2 both repos ✓; the twin scene mutates world
   matrices in ENU — resolve AFTER the frame's positions update; the twin is
   WebGPU (`three/webgpu`) — the package only touches math classes
   (Vector3/Quaternion/Matrix4/Layers), no renderer coupling, so it works;
   PivotControls/drei are demo-only deps, not package requirements; camera
   near/far must fit twin scale (snapshot lens optional — leave lens undefined to
   keep the twin camera's projection).

## Known deferred items

Multiple clips per vcam in the demo (schema supports); demo storing
`VirtualCameraDefinition` directly (QA-pass deferral); custom (non-native) form
controls per design skill; `out`-param on `sampleCartFrame` (decide before
publish); Phase F docs/publish hardening; per-clip override/event-track editing UI.
