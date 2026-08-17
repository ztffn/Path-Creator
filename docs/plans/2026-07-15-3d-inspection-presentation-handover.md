<!--
Purpose: Handover + full concept spec for a coding agent picking up the
"inspect a 3D object on stage" interaction and its place in the larger
"author & present 3D scenes as presentations" vision. Built on @huma/path-creator.
Author: handoff drafted 2026-07-15. Status: SPEC — not yet implemented beyond a
throwaway prototype (see §11).
Scope: Packages/path-creator (reuse + small additions) + a new examples/ demo.
-->

# Handover — 3D object inspection as a presentation primitive

## 0. How to onboard (paste to the coding agent)

```
You are continuing work in /Users/steffen/Projects/huma/3d/Path-Creator.

This repo is a standalone TS port inspired by Unity Path-Creator: a
Cinemachine-style camera/motion library for Three.js + R3F. Main package is
Packages/path-creator (published as @huma/path-creator, layered core/three/r3f/
timeline). examples/minimal-r3f-demo is the internal validation app.

Read first, in order:
1) docs/plans/2026-07-15-3d-inspection-presentation-handover.md   (THIS doc — the spec)
2) docs/technical/camera-system-implementation.md                (the API you build on)
3) docs/technical/ROADMAP.md                                     (what's done/deferred)
4) docs/technical/GEOSPATIAL-INTEGRATION-DEBRIEF.md              (WebGPU + reuse pitfalls)
5) AGENTS.md and .agents/AGENTS.md                               (guardrails)

Then run `pnpm install && pnpm build && pnpm test` and skim examples/minimal-r3f-demo/src/App.tsx
to see how the existing rig/timeline is driven, before writing code.

Execution expectations: package-first, keep /core framework-agnostic, keep new
demo code under examples/, keep everything time-varying a pure function of t,
render WebGPU-safe (see §10.1), run tests+build before concluding.
```

---

## 1. The vision (why this exists)

The parent project is a **framework for authoring and delivering 3D scenes as
presentations** — think "slides, but the slide is a live 3D scene and the camera
is a first-class narrative instrument." `@huma/path-creator` already provides the
authoring/runtime spine for that: editable spline paths, dolly carts, virtual
cameras (static / cart / **orbit**), tracking targets, manual pilot override, and
a deterministic, scrub-safe **timeline**. What's shipped is the *authored* motion
story (cuts, blends, dollies, keyframed transforms) — a presenter or reader moves
through a pre-built sequence.

The concept in this handover adds the **live, interactive counterpart**:
**inspection**. At a chosen moment the audience (or presenter) can *take hold of*
an object on stage and examine it — orbit it, climb it, look closer — using mouse,
a **mobile device's orientation sensors**, a **physical camera gimbal**, or, on
capable hardware, **AR / WebXR**. Then control hands back to the authored story.

Inspection is not a bolt-on viewer; it is a **presentation primitive** that
composes with the timeline: an author marks objects (and sub-regions/"layers") as
inspectable, chooses the input source and constraints, and the runtime blends
between authored playback and hands-on inspection without popping.

### 1.1 Two mental models (pick per shot, both must be supported)

- **Lens / magic window** — the camera copies the input orientation; the object
  stays fixed; you look *around* by aiming the device. Natural for spatial or
  architectural scenes.
- **Object-in-hand** — the input orientation drives the *object's* rotation; the
  camera stays put; it feels like turning the thing in your hand. Usually more
  intuitive for inspecting a discrete object and avoids the disorientation of a
  camera that pivots in place with no translation.

These are inverses of each other. The rig must express both as a mode, not two
separate code paths.

### 1.2 Degrees of freedom (design the abstraction around this)

- `deviceorientation` / a 3-axis gimbal = **3DoF** (rotation only). You can *aim*
  but not *translate*. This is the "magic window" tier and the universal fallback.
- WebXR (AR) = **6DoF** (rotation + position). You can walk *around* the object.
  This is the upgrade tier on supported devices.

The clean architecture is one interface with graceful degradation: **WebXR when
available → `deviceorientation` magic-window fallback → mouse/trackpad on desktop.**
Same scene, same rig, degraded input.

---

## 2. What already exists in the package (reuse — do NOT reinvent)

Read `docs/technical/camera-system-implementation.md` for the authoritative API.
The pieces this concept builds directly on:

**Orbit camera body** (`/core` `VirtualCameraBodyDefinition` variant `orbit`;
resolved in `/three` `resolveVirtualCameraDefinition`):
`{ type:"orbit", target: Vec3 | {targetId}, azimuthDeg, elevationDeg, radius,
binding?, autoOrbitDegPerSec? }`. Binding modes `world` (compass-anchored),
`lockYaw` (follows target heading, level horizon), `lock` (welded). This is
"orbit an object at azimuth/elevation/radius" — the core of inspection — and it is
**already done and scrub-safe** (auto-orbit advances from the resolve clock).

**Manual pilot override** (`control: CameraOverrideSettings` on the vcam
*definition*; stepped by `/three` `stepShotOverride` → `stepCameraOverride`):
LMB orbit azimuth/elevation around a pivot, RMB pan the pivot, wheel damped dolly
(min/max clamp), each axis `locked | free | recenter`. Exact passthrough when
idle; owns pose+aim when live; composes through the drive loop under both
activation and timeline playback. **This is the hands-on layer** — inspection is
largely "an orbit vcam + a `control` block, driven live."

**Input mapping, promoted to the package:**
- `/three` `createOverrideInputAccumulator({orbitDegPerPixel, panPerPixel,
  dollyPerWheel})` → framework-agnostic `orbit(dx,dy)/pan(dx,dy)/dolly(wheel)` +
  `drain(): CameraOverrideInput | null`. **A new input source (phone/gimbal/XR)
  is just another producer of these three gestures.**
- `/r3f` `<CameraOverrideSurface>` — a transparent capture layer owning
  pointer/wheel; drains into the drive intent. Use this for the mouse/touch path
  instead of hand-rolling listeners (the throwaway prototype hand-rolled them —
  don't copy that).

**Drive loop (framework-agnostic):** `/timeline` `driveRig(state, camera, intent,
dt)` dispatches idle/timeline/activation and applies the override; `/r3f`
`useRigDrive` is a thin wrapper. The drive `intent` carries `overrideInput`. **The
inspection rig should ride this loop**, not a bespoke per-frame resolve+apply, so
it composes with timeline playback and the authored↔inspect handoff for free.

**Targets:** `/core` `TargetRegistry` (pull-based; `register(id, source, name,
orientation?)`, `resolve`, `resolveOrientation`, `resolveGroup(members)` = weighted
centroid). `/three` `registerObjectTarget(registry, id, object, name)` pulls a live
scene object's world position+quaternion. **Targets are how "the object on stage"
is referenced — always a live scene object, never a decoupled point.**

**Timeline:** deterministic, versioned (`RigDocument`/`Timeline` schema v4), pure
`evaluateTimeline(timeline, ctx, t)`; camera/cart/event + activation/audio/
animation/transform tracks; crossfade blends. This is where "inspection windows"
will live as a new track/segment kind (§6).

### 2.1 Known-relevant gaps already logged in ROADMAP

- **Target groups aren't authored in the demo** (`SceneTarget` excludes the group
  variant). The pedestal-through-layers idea (§5) leans on group blending, so this
  gap must be closed for authoring.
- **`follow` body + binding-frame position damping are deferred** (see
  `docs/plans/2026-07-06-deferred-camera-bodies-v1.md`). Smooth motion toward a
  *moving coded target* (relevant to a smoothly-travelling pedestal target) is a
  planned `RigBodyState` channel — coordinate with that plan rather than inventing
  a parallel smoother.
- **WebGPU rendering constraints** (debrief P0, ROADMAP): consumers render under
  WebGPU; any new debug/authoring visuals must go through the `RigLine`/`RigLabel`/
  `RigGizmo` seams and must not vary geometry `args` per interaction. See §10.1.

---

## 3. Scope of this handover

Full presentation-framework concept, delivered in phases (§7). Concretely:

1. An **inspection rig** abstraction that turns any live scene object into an
   inspectable subject, driven by a pluggable **InputSource**.
2. **InputSource** implementations: pointer (reuse), `deviceorientation` (3DoF
   magic-window + object-in-hand), and a **WebXR** 6DoF path. A gimbal adapter is
   specced but hardware-gated (§4.4).
3. **Layered inspection** (the "vertical dolly through crate layers" case): move a
   real-object-derived focus up/down discrete layers with snap-to-detent feel.
4. **Authored ↔ inspect handoff**: enter/exit inspection from the timeline with a
   smooth blend; a data model for declaring inspection windows.
5. **Authoring**: how an author marks inspectable objects/layers, picks input +
   constraints, in the demo (and the serialized scene file).
6. **Second-screen / companion** model (specced; phase-gated).

Non-goals in §9.

---

## 4. Spec — the inspection rig & input sources

### 4.1 `InspectionSubject` (the unit of inspection)

A subject binds a live scene object (or a set of them) to an inspection shot.

```ts
interface InspectionSubject {
  id: string;
  /** Target id(s) already registered via registerObjectTarget. */
  targetId: string;
  /** "lens" = camera takes the input orientation; "object" = the subject does. */
  mode: "lens" | "object";
  /** Orbit framing when entering inspection. */
  framing: { azimuthDeg: number; elevationDeg: number; radius: number; binding?: OrbitBinding };
  /** Per-axis freedom while inspecting (maps to CameraOverrideSettings). */
  constraints: CameraOverrideSettings;   // azimuth/elevation/pan/dolly locked|free|recenter, min/maxDistance
  /** Optional layered inspection (§5). */
  layers?: InspectionLayers;
}
```

The rig turns a subject into a `VirtualCameraDefinition` with an `orbit` body
(target = `subject.targetId`, framing from `subject.framing`) and
`control = subject.constraints`, then drives it through `driveRig`. In `"object"`
mode the input orientation is applied to the subject object's quaternion instead
of the camera's override channel (the camera holds a fixed orbit; §4.3).

### 4.2 `InputSource` (the pluggable driver)

One interface, several implementations. It produces the **same** gesture stream
the package already understands (orbit/pan/dolly deltas) **and/or** an absolute
orientation quaternion (for `deviceorientation`/XR).

```ts
interface InputSource {
  readonly kind: "pointer" | "deviceorientation" | "webxr" | "gimbal";
  readonly dof: 3 | 6;
  start(): Promise<void> | void;   // may request permission (iOS) / an XR session
  stop(): void;
  /** Called once per frame by the rig. Return null when nothing changed. */
  sample(dt: number): InputSample | null;
}

type InputSample =
  // relative gestures → feed createOverrideInputAccumulator / override channel
  | { type: "gesture"; orbit?: [dx: number, dy: number]; pan?: [dx: number, dy: number]; dolly?: number }
  // absolute orientation → magic-window (drive camera or subject quaternion)
  | { type: "orientation"; quaternion: QuaternionLike }
  // absolute pose (6DoF) → XR: position + orientation in world/rig space
  | { type: "pose"; position: Vec3; quaternion: QuaternionLike };
```

Rig behavior by sample type:
- `gesture` → push into `createOverrideInputAccumulator`; `drain()` into the drive
  intent's `overrideInput`. (Pointer source = the existing `<CameraOverrideSurface>`.)
- `orientation` → magic-window. In `"lens"` mode, blend the camera orientation
  toward the sample (slerp with damping) while keeping the orbit radius/target; in
  `"object"` mode, slerp the subject object's quaternion toward the sample.
- `pose` → 6DoF. Position + orientation drive the camera directly (XR rig space);
  the orbit body becomes a soft framing hint rather than a hard constraint.

### 4.3 `deviceorientation` source (3DoF) — the details that bite

Implement carefully; these are the standard failure points:

- **HTTPS + user-gesture permission.** iOS 13+ requires
  `DeviceOrientationEvent.requestPermission()` from a tap; only works over HTTPS.
  `start()` must be call-from-gesture and await permission; surface a clear
  "enable motion" affordance.
- **Screen-orientation compensation.** Apply the `screen.orientation.angle` (and
  the legacy `window.orientation`) correction, plus the fixed −π/2 X correction
  that maps "device flat" to "looking at the horizon" — the same math Three.js's
  old `DeviceOrientationControls` used. Without it, portrait/landscape is 90° off.
- **Quaternion, not raw Euler apply.** Build the quaternion via the `'YXZ'`
  Tait-Bryan order → then multiply the screen-orientation quaternion → then the
  world correction. Never `camera.quaternion.copy(euler-derived)` directly (the
  throwaway snippet did; it gimbal-locks and ignores screen orientation).
- **`alpha` drift.** Prefer `deviceorientationabsolute` where available; treat
  relative `alpha` as heading-unstable and offer a "recenter/reset heading" action.
- **Map to the chosen mode.** `"lens"`: slerp camera orientation toward the
  device quaternion, keep orbit distance to the subject. `"object"`: slerp the
  subject quaternion; keep the camera on its coded orbit pose. Always damp
  (exponential slerp) so sensor jitter doesn't read as shake.

### 4.4 Gimbal source (specced, hardware-gated)

A physical motorized gimbal exposes stabilized 3-axis orientation (and can be
*scripted* for repeatable authored moves). Transport is typically BLE / Web
Serial / a small bridge. Implement `GimbalInputSource` behind the same interface
(emitting `orientation` samples, optionally `gesture` for jog wheels). **Do not
block the core work on hardware**; ship the interface + a mock source that replays
a recorded orientation track so the rest of the rig is testable. A gimbal and the
authored keyframe track are two implementations of the *same* orientation stream —
keep that symmetry.

### 4.5 WebXR source (6DoF) — the AR upgrade path

`deviceorientation` caps at 3DoF; to walk *around* the object you need WebXR
(`immersive-ar` where supported, `immersive-vr`/inline otherwise). Emit `pose`
samples from the XR viewer pose each frame. On entry, anchor the scene so the
subject sits at a comfortable real-world scale/position (plane detection /
hit-test for AR placement). The orbit body degrades to a *suggested* framing; the
user's real movement is authoritative. Gate behind `navigator.xr?.isSessionSupported`.
This is a later phase (§7) but the `InputSource.pose` shape must exist from the
start so nothing needs reshaping later.

---

## 5. Spec — layered inspection (the "climb the crate stack" case)

Use case: a human-tall stack of crates; the viewer wants to examine each *layer*.
Requirement from the design discussion: **the focus target must be a real object
in the world, not a decoupled synthetic point.**

Model:
- Each layer is (or maps to) a real scene object registered as a target
  (`crate/0…crate/n`) via `registerObjectTarget`.
- A **continuous `layerFloat`** (0…n) eases toward a selected integer layer
  (snap-to-detent — a floor-selector feel; ease rate ~6/s, settle on release).
- The orbit target is a **focus** derived from the two bracketing layer objects
  via `TargetRegistry.resolveGroup([{crate/lo, 1−frac}, {crate/hi, frac}])`, so
  the vertical travel is literally a weighted blend of *real* object positions.
  This is the "vertical dolly / pedestal" — the target rides a rail defined by the
  actual objects.

```ts
interface InspectionLayers {
  /** Ordered target ids, bottom → top. */
  targetIds: string[];
  /** "blend" = smooth pedestal across a weighted group (default);
   *  "lock"  = hard-cut framing to a single layer object. */
  travel: "blend" | "lock";
  /** Optional: auto-fit radius per layer so each layer stays framed. */
  autoFrame?: boolean;
  easeRate?: number; // per-second; default 6
}
```

Two behaviors the author picks per subject:
- `"blend"` (built in the prototype): reads as a smooth dolly up the stack; the
  focus is never any single crate. Best default for "scan the stack."
- `"lock"`: each detent re-targets the orbit to one crate object (hard framing).
  Best for "study layer 3 precisely." Coordinate the smoothing with the deferred
  position-damping channel (§2.1) rather than a bespoke lerp.

Input mappings for the pedestal (all optional per subject):
- Buttons ▲/▼ and Arrow keys (baseline).
- `deviceorientation`: map device **pitch** (`beta`) to `layerFloat` (aim higher →
  climb higher) while yaw drives orbit azimuth — so the gesture is "tilt up to
  rise, turn to circle." Do **not** map pitch to camera pitch in this mode.
- Wheel/scroll as a secondary continuous pedestal when dolly isn't bound.

`autoFrame`: for a tall thin stack, top layers blow out of frame at a fixed
radius; when enabled, ease `radius` toward a per-layer fit computed from the
layer object's bounds. Keep it optional (uniform crates don't need it).

---

## 6. Spec — authored ↔ inspect handoff (timeline integration)

Inspection must enter and leave from the authored story without popping. This is
the core UX of the whole feature.

### 6.1 Runtime handoff

- An orientation/override-driven camera **fights** an authored camera path.
  Resolve with an explicit mode on the rig: `authored-playback` vs
  `handheld-inspect`, with a **timed slerp/lerp blend** on enter and exit (never a
  hard `copy`). Reuse the timeline's existing crossfade machinery / blend curve
  where possible rather than a parallel blender.
- On **enter**: capture the current authored snapshot as the coded pose, seed the
  inspection orbit from `subject.framing`, and blend coded→inspect over
  `enterBlend` seconds. The manual override (`stepShotOverride`) then owns live
  pose; recenter axes decay back toward the seeded framing when idle.
- On **exit**: blend the live inspect pose back to the authored timeline pose at
  the (possibly advanced) playhead over `exitBlend` seconds, then resume playback.
- Because everything resolves as a pure function of `t` + the override state,
  scrubbing across an inspection window should behave predictably (the window is a
  marker; the *interaction* is live and not part of scrub — define exit-on-scrub
  semantics: scrubbing away from the window force-exits inspection).

### 6.2 Data model (timeline / RigDocument addition)

Add an **inspection segment** to the versioned timeline schema (bump
`schemaVersion`; provide a one-way import compat path like prior track additions):

```ts
interface InspectionSegment {
  id: string;
  subjectId: string;          // → InspectionSubject in the RigDocument
  /** Timeline window that offers inspection (pause playback / show affordance). */
  start: number; end: number;
  enterBlend: number;         // seconds
  exitBlend: number;          // seconds
  /** Which input sources are permitted here, in preference order. */
  inputs: InputSource["kind"][];   // e.g. ["webxr","deviceorientation","pointer"]
  /** What happens to timeline time while inspecting. */
  hold: "pause" | "continue";
}
```

`InspectionSubject`s live in the `RigDocument` (alongside targets/vcams); segments
live in the `Timeline`. Keep subjects pure data (ids + numbers), resolvable via
`TargetRegistry`, so headless/non-r3f runtimes drive them identically.

### 6.3 Second-screen / companion model (phase-gated spec)

A compelling presentation affordance: the main screen shows the scene; the
presenter's **phone is a physical lens/pointer** whose orientation drives a
viewport or a highlight on the main display, synced over WebRTC/WebSocket. Or:
**audience-held inspection** — each viewer opens a URL and independently inspects
the flagged object on their own device while the presenter narrates. Both are just
a **remote `InputSource`** (orientation/pose arriving over the wire) plus a
transport; the rig doesn't change. Spec now, build after single-device inspection
is solid (§7 phase 5).

---

## 7. Build plan (phases, each independently shippable)

Each phase: land in the package where reusable, demo in `examples/`, tests + build
green, WebGPU-safe visuals.

**Phase 1 — Inspection rig on the real drive loop.**
Replace the throwaway prototype (§11) with an `InspectionSubject` → orbit vcam +
`control`, driven via `useRigDrive`/`driveRig` and `<CameraOverrideSurface>` (not
hand-rolled listeners). Pointer input only. Both `"lens"` and `"object"` modes.
_Accept:_ mouse orbit/dolly of a live scene object with no pop on grab/release;
object-in-hand mode rotates the subject, camera fixed; runs in the demo.

**Phase 2 — Layered inspection.**
`InspectionLayers` with `blend` + `lock` travel, snap-to-detent, ▲/▼ + keys,
optional `autoFrame`. Close the demo's target-group authoring gap (§2.1) enough to
declare layers. _Accept:_ climb a 6-crate stack; blend reads as a smooth pedestal;
lock hard-frames each layer; focus is provably a real-object blend.

**Phase 3 — `deviceorientation` source.**
3DoF magic-window with permission flow, screen-orientation correction, quaternion
pipeline, damping, recenter. Both modes; pedestal-via-pitch mapping. _Accept:_ on
a real phone over HTTPS, tilt/turn inspects smoothly; portrait+landscape correct;
no gimbal-lock; recenter works.

**Phase 4 — Authored ↔ inspect handoff.**
`InspectionSegment` in the timeline schema (version bump + import compat);
enter/exit blends; scrub-exit semantics; demo authors a window in its show.
_Accept:_ playback reaches a window → enter inspect (blended) → hand-hold → exit
(blended) → playback resumes; scrubbing away force-exits cleanly.

**Phase 5 — WebXR (6DoF) + companion (stretch).**
`WebXRInputSource` emitting `pose`; AR placement; feature-gated. Then remote
`InputSource` over a transport for second-screen. _Accept:_ on an AR-capable
device, walk around the subject; graceful fallback to Phase 3 elsewhere.

---

## 8. Architecture / layering rules (respect these)

- **/core**: `InspectionSubject`/`InspectionLayers`/`InspectionSegment` *types* and
  any pure math (layer weight computation, blend scheduling). No three, no react.
- **/three**: the rig resolver/driver glue (subject → vcam def; orientation→pose
  application; pedestal focus source registration). Reuse `resolveVirtualCamera
  Definition`, `stepShotOverride`, `TargetRegistry`.
- **/r3f**: hooks/components — `useInspection(subject, source)`, pointer surface
  reuse, a debug/authoring gizmo (WebGPU-safe seams only).
- **InputSource** implementations: `/three` for the pure/DOM-light ones
  (deviceorientation, gimbal-mock, remote), `/r3f` only if they need R3F context;
  keep XR session glue where it fits without forcing XR deps on non-XR consumers
  (peer-optional, dynamic import — mirror the WebGPU peer-optional policy).
- **Determinism**: the authored parts stay pure functions of `t`; the *live*
  inspection state is an explicit stateful channel (like `RigBodyState`/composer),
  not hidden per-frame mutation. Don't break scrub.

---

## 9. Non-goals

- Not rebuilding a general 3D editor or asset pipeline — subjects reference
  existing scene objects/targets.
- Not Unity-editor UX parity.
- Not a physics/collision inspection (no "pick up and throw").
- Not shipping gimbal hardware integration in the core phases (interface + mock
  only; real transport is opt-in later).
- Not adding a second timeline UI library — if layered/segment authoring needs a
  new lane, prefer the in-house lane already flagged in ROADMAP (F3/P2.2), don't
  add another @xzdarcy-style dep.

---

## 10. Known issues & pitfalls (read before coding)

### 10.1 Rendering (WebGPU) — from the geospatial debrief
Consumers render under **WebGPU**. Any inspection debug/authoring visual (orbit
ring, focus marker, layer rail, labels) MUST route through the existing seams:
`RigLine` (`src/r3f/rig-line.tsx`), `RigLabel` (`src/r3f/rig-label.tsx`),
`RigGizmo`/vendored `PivotGizmo` (`src/r3f/pivot/`). **Never vary a mesh's geometry
`args` per interaction on a WebGPU path** (disposes/recreates GPU buffers mid-frame
→ device loss); vary `scale`/`opacity`/`color` instead. drei is peer-optional and
only touched on the WebGL branch. Rebuild the package `dist` before the example
picks up changes (a stale dist is what first surfaced the WebGPU device-loss chain).

### 10.2 The throwaway prototype's problems
- It **hand-rolled** pointer/wheel listeners and did a bespoke per-frame
  `resolve → stepShotOverride → applyVirtualCameraSnapshot` instead of riding
  `driveRig`/`<CameraOverrideSurface>`. That bypasses timeline composition and the
  handoff machinery. Phase 1 must use the real drive loop.
- It could not be shown in the chat/artifact viewer because it depends on
  React-Three-Fiber/three/drei (unsupported there). **This is a viewer limitation,
  not a code problem** — the demo is a normal Vite app; run it with `pnpm dev`.
- Its layer `blend` (real-object group) is the right idea and worth keeping; the
  `lock` alternative and `autoFrame` were not built.

### 10.3 `deviceorientation` — see §4.3 (permission, screen-orientation, quaternion
order, alpha drift). These are the top real-world failure modes; budget for them.

### 10.4 Determinism vs live input
Inspection is inherently live/stateful; don't try to make the *interaction* part
of the pure `t` evaluation. Keep it a declared stateful channel and define
enter/exit/scrub semantics explicitly (§6.1) so scrubbing never desyncs.

---

## 11. The throwaway prototype (starting point / reference)

A minimal, working-but-superseded prototype exists in the demo; treat as reference
for the concept, not as the architecture to extend:

- `examples/minimal-r3f-demo/src/crate-inspector/CrateInspector.tsx` — orbit vcam
  bound to a real-object **focus group** blended across 6 crate meshes; ▲/▼ + arrow
  pedestal; hand-rolled pointer/wheel override; per-frame resolve+apply.
- `examples/minimal-r3f-demo/src/crate-inspector/main.tsx`,
  `examples/minimal-r3f-demo/crate-inspector.html` — entry (open `/crate-inspector.html`
  under `pnpm --filter minimal-r3f-demo dev`).

It typechecks against the real package API and demonstrates the layer-blend idea.
**Phase 1 should port its concept onto `useRigDrive` + `<CameraOverrideSurface>`
and delete the bespoke input/apply code.** Keep the crate-stack as the layered-
inspection test fixture.

---

## 12. Open questions for the product owner (Steffen)

1. **Default travel mode** for layered inspection — smooth `blend` (dolly feel) vs
   `lock` (precise per-layer framing)? Prototype defaulted to `blend`.
2. **`autoFrame`** on by default for layers, or opt-in per subject?
3. **Primary device input** to prioritize after pointer — `deviceorientation`
   (broad reach) or WebXR (richer, narrower support)?
4. **Handoff hold semantics** — should timeline time `pause` during inspection
   (default) or `continue` underneath?
5. **Companion model priority** — is presenter-phone-as-lens or audience-held
   inspection the first target, or is it out of scope for now?
