# Camera & Motion System — Technical Documentation

`@huma/path-creator` is a Cinemachine-style camera and motion library for
Three.js. It provides spline paths, dollies (carts), virtual cameras, tracking
targets, and a deterministic timeline runtime. It is renderer-agnostic (WebGL
and WebGPU) and host-agnostic: any Three.js application drives it through plain
functions and serializable data.

## Architecture Overview

```
BezierPath ──bake──▶ VertexPath          (geometry; constant-speed queries)
                        │
                   PathCart ──▶ CartFrame (a dolly: position + basis on a path)
                        │
        VirtualCameraDefinition           (body → aim → noise → lens)
                        │ resolve(ctx, t)
              VirtualCameraSnapshot       (plain pose + lens; the universal currency)
                        │
              Brain (cut / blend / drive) ──▶ real THREE.Camera
                        ▲
   Timeline ──evaluate(rig, t)──▶ { camera, cartFrames, events }
```

Design rules that hold everywhere:

- **Carts are the only coupling seam.** Paths know nothing about riders; cameras
  know nothing about paths. A dolly is a cart entity; a camera *mounts* a cart
  via its body's `cartId` plus a rail-local offset. Several cameras can mount
  one dolly; a dolly can carry non-camera props.
- **Everything time-varying is a pure function of `t`.** Sampling a cart,
  resolving noise, and evaluating a timeline at the same `t` always produce the
  same result. Scrubbing, playback, and replay are therefore identical.
- **Snapshots are the universal currency.** Every motion source resolves to a
  `VirtualCameraSnapshot`; blending, application, and serialization operate on
  snapshots only.
- **Persistable data is versioned.** `RigDocument` and `Timeline` carry a
  `schemaVersion` and are plain JSON.

## Package Entry Points

| Entry | Contents | Dependencies |
| --- | --- | --- |
| `@huma/path-creator/core` | Paths, carts, virtual-camera data types, targets, rig document, timeline schema | none (pure TS) |
| `@huma/path-creator/three` | Resolution, brain, snapshot apply/blend, object targets, editor layers | `three` |
| `@huma/path-creator/r3f` | Hooks and components | `three`, `react`, `@react-three/fiber` (optional peers) |
| `@huma/path-creator/timeline` | `evaluateTimeline`, events, player | core + three |

## Core Concepts

### Paths

`BezierPath` (editable anchors/controls; control modes aligned, mirrored, free,
automatic; `toJSON()`/`fromJSON()`) bakes into `VertexPath`, which answers
constant-speed queries: `getPointAtDistance`, `getDirectionAtDistance`,
`getNormalAtDistance`, and `resolveDistance(distance, mode)` with
`EndOfPathInstruction.Loop | Reverse | Stop`. Closed 3D loops apply a
parallel-transport normal seam correction so orientation frames are continuous
across the join.

### Carts (dollies)

```typescript
import { createPathCart, advanceCartDistance, sampleCartFrame } from "@huma/path-creator/core";

const cart = createPathCart({ speed: 2, endOfPathInstruction: EndOfPathInstruction.Loop });
cart.distance = advanceCartDistance(path, cart, delta); // live stepping
const frame = sampleCartFrame(path, cart);               // pure; or sampleCartFrame(path, cart, atDistance)
```

`CartFrame` carries `position`, `railPosition`, an orthonormal
`forward/up/right` basis, `distance`, and normalized `time`. Orientation modes:
`"path-frame"` (tangent + path normal), `"path-yaw"` (flattened forward, world
up), `"fixed"` (world axes). `positionOffset` is rail-local
(`x`=right, `y`=up, `z`=forward); `offsetAlongBasis` is the single definition of
that convention. Timelines position carts by sampling at `t` — never by
stepping — to preserve determinism.

### Virtual cameras

A `VirtualCameraDefinition` describes a shot through four stages:

```typescript
const shot: VirtualCameraDefinition = {
  id: "rail-cam",
  body: { type: "cart", cartId: "dolly-1", positionOffset: { x: 0, y: 0.4, z: 0 } },
  aim: { type: "look-at", target: { targetId: "turbine/Nacelle" } },
  noise: { seed: 7, positionAmplitude: 0.05, rotationAmplitudeDeg: 0.8 },
  lens: { fov: 40, dutchDeg: 5 }
};
```

- **body**: `static` (explicit pose), `cart` (mounted on a dolly), or `orbit`
  (orbit a follow target at azimuth/elevation/radius).
- **aim**: keep body orientation, or look at a fixed `Vec3` / registered target id.
- **noise**: seeded value noise, a pure function of `(settings, time)`.
- **lens**: fov/zoom/near/far/orthographicSize/`dutchDeg` (roll). Leaving `lens`
  undefined preserves the host camera's projection.

Resolution is stateless:

```typescript
import { resolveVirtualCameraDefinition } from "@huma/path-creator/three";

const snapshot = resolveVirtualCameraDefinition(shot, {
  getCartFrame: (cartId) => frames.get(cartId) ?? null,
  getTargetPosition: (targetId) => registry.resolve(targetId),
  getTargetOrientation: (targetId) => registry.resolveOrientation(targetId),
  elapsedSeconds: t
});
```

Returns `null` when a referenced cart/orbit target is unavailable; an
unresolvable aim target keeps the body orientation.

#### Orbit body

The `orbit` body places the camera on a sphere around a follow target, defaulting
its orientation to look back at that target — so `aim: { type: "body" }` alone
gives a working orbit, and a `track` aim frames a *different* target for
"auto-orbit while looking elsewhere" (body position and aim are independent, per
Cinemachine's Position-Control vs Rotation-Control split).

```typescript
body: {
  type: "orbit",
  target: { targetId: "turbine/Nacelle" }, // position source (a Vec3 also works)
  azimuthDeg: 45,        // around the frame up; 0 sits on the frame +Z
  elevationDeg: 20,      // above the horizon; clamped ±80 off the poles
  radius: 6,
  binding: "lockYaw",    // offset frame — see below
  autoOrbitDegPerSec: 12 // optional: pure time-driven spin (scrub-safe)
}
// Manual override (drag/zoom at runtime) is authored on the DEFINITION, not the
// body — it applies to any vcam. See "Manual override" below.
```

Resolution stays pure. Auto-orbit advances azimuth by
`autoOrbitDegPerSec × elapsedSeconds`, so scrubbing to the same instant
reproduces the identical pose — no per-frame state. `binding` selects the offset
frame:

- `world` — angles in world (rig) axes; the target's rotation is ignored
  (a compass-anchored orbit that holds as the target spins underneath).
- `lockYaw` — the frame follows the target's **yaw only**, world up preserved
  (level horizon, no roll); the camera stays on the same side as the target
  turns. Needs `getTargetOrientation`.
- `lock` — the frame inherits the target's **full** orientation; the camera is
  welded to the target and rolls/tilts with it.

Target-relative bindings (`lockYaw`/`lock`) read the target's live orientation
through `getTargetOrientation`; when it is unavailable (a literal `Vec3`, or no
orientation registered) they degrade gracefully to `world`. Register orientation
via `registerObjectTarget` (pulls `getWorldQuaternion`) or a fourth argument to
`TargetRegistry.register`.

The pure placement math is shared with the authoring gizmo: `orbitOffset`
(params → local offset), `orbitParamsFromLocalOffset` (its inverse, for drag),
`orbitBindingQuaternion` (binding → frame), and `buildOrbitRingPoints` (the ring
polyline). The r3f `OrbitVcamGlyphRig` draws the debug/authoring gizmo — the
orbit ring, radius arm, a binding-frame axis triad, and a camera glyph on the
ring — and, when selected, a translate `PivotGizmo` at the camera position that
maps drags back to azimuth/elevation/radius. The frame follows the target each
frame, so `lockYaw`/`lock` visibly track a rotating target. See the minimal demo
(Add Orbit VCam) for end-to-end authoring against a spinning turbine target.

### Manual override (pivot-orbit, any vcam)

Any vcam can be grabbed and flown at runtime — the twin's OrbitControls model,
generalized: **LMB → orbit** azimuth/elevation around a pivot, **RMB → pan** the
pivot (re-frames what's centred), **wheel → damped dolly** toward the pivot. This
is authored on the **definition**, not the body, as `control: CameraOverrideSettings`
so it applies to `static`, `cart`, and `orbit` alike:

```typescript
const shot: VirtualCameraDefinition = {
  id: "overview",
  body: { type: "orbit", /* … */ },
  control: {
    azimuth: { mode: "free" },                                 // holds where left
    elevation: { mode: "recenter", recenterWait: 1.5, recenterTime: 1 },
    pan: { mode: "recenter", recenterWait: 1.5, recenterTime: 1 },
    dolly: { mode: "free" },
    minDistance: 1, maxDistance: 40                             // dolly clamp
  }
};
```

Each axis takes a mode:

- `locked` (default when `control`/the axis is omitted) — input ignored; the shot
  plays exactly as authored.
- `free` — user input drives the axis and it stays where the user leaves it.
- `recenter` — user input drives it, then after `recenterWait` idle seconds it eases
  back to the coded value over ~`recenterTime` (shortest angular path for azimuth).

**The pivot** is the vcam's aim target → its orbit target → a synthesized point in
front of the coded pose, so any shot has something to orbit/pan/dolly around.

**Purity is preserved.** Resolution never sees the override — it's a **stateful
post-stage** (`RigBodyState` in `RigDriveState`, alongside the brain and composer,
mirroring `stepComposerAim`). Each frame `stepCameraOverride(coded, pivot, id,
control, state, input, dt)` recomposes the pose as a **rigid rotation of the coded
offset about the pivot**: azimuth yaws the pivot→camera offset about world-up,
elevation pitches it about the horizontal axis in its azimuth plane, dolly scales
its length, pan trucks the pivot — and the **same rotation is applied to the coded
orientation**. Because it rotates the coded offset itself (not a spherical
reconstruction of it), a zero offset reproduces the coded pose **bit-for-bit**,
preserving any authored roll and steep (near-pole) framing that a world-axis
decompose would flatten or clamp to ±80. Elevation is clamped ±80 off horizontal but
never tighter than the coded elevation (a steep shot holds, then only tilts back);
azimuth wraps to (-180,180]; the dolly is damped toward a target bounded to the
reachable band `[min,max]` (widened to include the coded distance, so an out-of-range
shot never jumps and the wheel reverses without a dead zone). With no live offset it
returns the coded snapshot unchanged (exact passthrough) and reports `active: false`;
when live it owns position **and** aim (look at the panned pivot) and the caller
skips the composer. It reseeds on a shot change. Both drivers apply it:
`driveActivation` and `driveTimeline` (on the active block's pose, skipped mid-blend;
input is withheld while blending so a gesture never accumulates into a jump when the
blend completes), so piloting works under an activated shot **and** under timeline
playback — the
timeline picks the vcam and blends, the override axes still respond, just like
Cinemachine input axes under a timeline.

**Input mapping is packaged** so hosts don't re-implement it:
`createOverrideInputAccumulator()` (`/three`, framework-agnostic) maps pointer/wheel
gestures — `orbit(dx,dy)` / `pan(dx,dy)` / `dolly(deltaY)` — to `CameraOverrideInput`
and `drain()`s once per frame into the drive intent's `overrideInput`. The r3f
`<CameraOverrideSurface accumulator={…}>` is a transparent capture layer that owns
pointer + wheel (non-passive wheel `preventDefault`, RMB context-menu suppression) —
severing R3F's editor-camera picking and stopping scroll/zoom leakage — and feeds the
accumulator. A host (twin) mounts the surface while a vcam is live, disables its own
OrbitControls, and passes `accumulator.drain()` as `overrideInput`.

Two orientation conventions exist and must not be mixed:
`applyCartFrameToObject(object, frame)` aligns a **prop's +Z** with travel;
`cameraQuaternionFromFrame(forward, up)` makes a **camera look along** the
direction (−Z convention).

### The brain

The brain owns which shot is live and how shots transition:

```typescript
import {
  createVirtualCameraBrainState,
  activateVirtualCameraBrain,
  driveVirtualCameraBrain
} from "@huma/path-creator/three";

const brain = createVirtualCameraBrainState();
// on shot change:
activateVirtualCameraBrain(brain, resolvedSnapshot, { durationSeconds: 1.5, curve: "easeInOut" });
// every frame while a shot is live:
driveVirtualCameraBrain(camera, brain, shotDefinition, resolveContext, delta);
```

`driveVirtualCameraBrain` re-resolves the definition each frame and retargets
the blend, so blends chase moving bodies and tracked targets — both blend
endpoints stay live, as in Cinemachine. Lower-level pieces
(`updateVirtualCameraBrain`, `retargetVirtualCameraBrain`,
`blendVirtualCameraSnapshots`, `applyVirtualCameraSnapshot`,
`captureVirtualCameraSnapshot`) are exported for custom flows.

### Tracking targets

`TargetRegistry` maps ids to live position sources. Sources are pull-based —
resolved at query time, never cached between frames.

```typescript
// vanilla three: register every named node of a loaded model
const dispose = registerObjectTargets(registry, gltf.scene, {
  pattern: /^Rotor/, idPrefix: "turbine"
}); // ids: "turbine/<node.name>"

// r3f:
<TrackingTarget targetId="ship">{...}</TrackingTarget>
useObjectTargets(sceneRef, { names: ["Nacelle", "Hub"] });
const targets = useRegisteredTargets(); // live list for picker UI
```

`resolveGroup(members)` returns a weighted centroid (Cinemachine target
groups). The registry exposes `subscribe`/`version` so UI lists stay current.

### Timeline

Schema (`schemaVersion: 1`, plain JSON):

- `CameraTrack` — blocks `{ vcamId, start, end, blendIn?, overrides? }`.
  `blendIn` blends from the previous block over its duration; `overrides`
  shallow-patch the vcam definition per block (a retarget is an aim override).
- `CartTrack` — `{ cartId, keys: { time, distance, easing? }[] }`; keyframed
  dolly motion with eased interpolation, clamped at the ends. Carts without a
  track derive distance as `cart.distance + cart.speed * t`.
- `EventTrack` — `{ id, time, kind, payload }`; opaque to the library.

Evaluation is the load-bearing contract:

```typescript
import { evaluateTimeline } from "@huma/path-creator/timeline";

const sample = evaluateTimeline(timeline, { rig, vcams, getTargetPosition }, t);
// sample: { camera: VirtualCameraSnapshot | null, cartFrames: Map, activeBlock, blendProgress }
```

Semantics:

| Situation | Result |
| --- | --- |
| Before the first block | `camera: null` — the host camera is free |
| Inside a block | That vcam, resolved at `t` |
| Inside a `blendIn` window | Both shots resolved live at `t`, blended |
| Blocks touching | Hard cut |
| Gap between blocks, `gapMode: "hold"` (default) | The last shot stays live |
| Gap between blocks, `gapMode: "release"` | `camera: null` — the host camera takes over |

`gapMode` in plain terms: when the playhead sits between two clips, "hold"
keeps showing the previous clip's camera (editing-software behavior);
"release" hands control back to whatever camera the application normally runs
(Cinemachine behavior). Hosts embedding the timeline inside an interactive app
usually want `release`; linear show playback usually wants `hold`.

Multiple camera tracks layer: later tracks override earlier ones (an
interrupt/cutaway track). Track contents must be sorted by time —
`createTimeline`/`buildRigRuntime` establish this invariant so the per-frame
evaluator never sorts.

Playback state lives in a thin player; events edge-fire exactly once:

```typescript
const player = createTimelinePlayer({ loop: false, rate: 1 });
const fired = stepTimelinePlayer(player, timeline, delta); // TimelineEvent[]
seekTimelinePlayer(player, t); // scrub; never fires events
```

### Rig document (persistence)

`RigDocument` (`schemaVersion: 2`) serializes an entire production: `paths[]`,
`carts[]`, `vcams[]`, `targets[]`, `timelines[]`, all referenced by id.
`buildRigRuntime(document)` instantiates runtime maps and validates every
cross-reference; unknown references throw at load, not during playback.

### Editor/play separation

Editor-only visuals (spline handles, camera glyphs, frustum helpers) live
exclusively on `EDITOR_HELPERS_LAYER` (30). An editing viewport enables the
layer; playback cameras never see it — edit vs. play is one camera bit, not a
scene change.

```tsx
<EditorHelpers>{/* gizmos, path lines, glyphs */}</EditorHelpers>
useEditorHelpersVisible(); // marks the viewport camera AND the event raycaster
```

The raycaster note matters: `THREE.Raycaster.layers` defaults to layer 0, so
helper interactivity requires enabling the layer on the raycaster too —
`useEditorHelpersVisible` does both.

## Data Flow (host application, per frame)

1. Update dolly frames: live mode steps carts (`advanceCartDistance` +
   `sampleCartFrame`); timeline mode takes `sample.cartFrames` from
   `evaluateTimeline` instead.
2. Resolve the live shot: `driveVirtualCameraBrain(camera, brain, def, ctx, delta)`
   for interactively activated shots, or apply `sample.camera` during timeline
   playback (`applyVirtualCameraSnapshot`).
3. Fire `stepTimelinePlayer` events into application systems (captions, layer
   toggles, UI).

## Integration Guide (embedding in a host scene)

The reference integration is the repository's `examples/minimal-r3f-demo`; the
patterns below generalize to any host (e.g. a geospatial digital-twin scene).

1. **Coordinate frame** — the library is coordinate-agnostic. Author paths in
   the host's local metric frame (e.g. an ENU group anchored at a site) and run
   all sampling in that frame.
2. **Build a rig** — `VertexPath` per rail, `PathCart` per dolly, vcam
   definitions mounting them, targets registered from host objects
   (`registerObjectTargets` for model nodes, or `registry.register(id, () => pos)`
   for computed positions).
3. **Author or compile a timeline** — either author blocks directly, or follow
   the demo's clip model: clips on one shot track, overlap compiled into
   `blendIn` (overlap = crossfade, touch = cut, later start blends in).
4. **Drive the host camera** — while `evaluateTimeline(...).camera` is non-null,
   apply it and suppress the host's own camera controller; with
   `gapMode: "release"`, a null camera is the signal to hand control back.
5. **Renderer** — the library touches only math classes
   (`Vector3`/`Quaternion`/`Matrix4`/`Layers`); it works identically under
   WebGL and WebGPU renderers.

## Performance Considerations

- The timeline evaluator is allocation-light and never sorts in the hot path
  (sorted-tracks construction invariant).
- Brain snapshots are cloned at API boundaries deliberately; resolution reuses
  module-level scratch math objects.
- Editor-helper layer re-assertion is a guarded per-frame traverse (writes only
  on change) to cover asynchronously created children (text glyphs, gizmo
  internals).
- Host UIs must not rebuild timeline/editor data structures at pointer rate;
  derive them from the minimal fields they depend on (the demo keys its
  compiled timeline on timing fields only).

## Testing Strategy

`Packages/path-creator/test/` (vitest): geometry and seam continuity
(`cart.spec.ts`), resolution/brain/noise/lens (`three.spec.ts`), registry and
object targets (`targets.spec.ts`), evaluator semantics incl. scrub-equals-play
determinism, gap modes, events, and rig round-trips (`timeline.spec.ts`).
When adding timeline features, always pin: determinism (evaluate twice ≡),
boundary behavior (block edges, blend windows), and serialization round-trips.

## Known Limitations

- Vcam `follow` body type (damped target following) is not implemented; use
  cart bodies or the r3f screen-composer aim stage.
- The screen-composer aim (`applyScreenComposerAim`) is stateful (damping,
  lookahead) and therefore lives outside pure resolution; it applies to live
  cameras only, not to timeline evaluation.
- Confiner/collision (camera volume constraints) is intentionally out of scope
  until a host defines its scene-query policy.

## Related Documentation

- `docs/plans/` — historical design plans for the port and camera phases.
- `README.md` — package installation and quick start.
