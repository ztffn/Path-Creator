<!--
Purpose: What @huma/pascal-time is, how a host mounts it, and the Pascal plugin contract
details that cost real time to discover — including five not recorded anywhere else. Read this
before adding a node kind or changing how registration works. Scope: the package itself; the
system it belongs to is described in docs/technical/ELASTIQ-SYSTEM.md.
-->

# @huma/pascal-time

**Time as a Pascal plugin.** Pascal is a 3D editor with 46 node kinds and no clock — no
timeline, no animation, nothing that changes with `t`. This package adds that dimension: node
kinds Pascal gains, an adapter that turns Pascal's scene registry into something
`@huma/path-creator` can drive, and a per-frame driver that moves Pascal's objects without
touching Pascal's document.

It depends on both sides. **`@huma/path-creator` must never depend on Pascal** — if that rule
ever needs breaking, the design is wrong.

Status: **all of M1 complete** — M1.3's authoring panel landed 2026-08-18. Workspace-only
(`private: true`) until the API settles; extraction to its own repo is expected, and it is a
leaf package with clean dependencies so that stays cheap.

## Mounting it

Two calls, and the first one's timing is not negotiable.

```ts
// main.tsx — at module import time, BEFORE createRoot
import { registerPascalTimeKinds } from "@huma/pascal-time";
registerPascalTimeKinds();
```

```ts
// wherever the scene is prepared
import { installPascalTimeOnScene, buildTimelineNode, createPluginNode } from "@huma/pascal-time";

installPascalTimeOnScene();                       // opts this scene into the plugin's kinds
createPluginNode(buildTimelineNode({ durationSeconds: 30 }));
```

Then drive, from inside the viewer's frame loop:

```tsx
import { useFrame } from "@react-three/fiber";
import { PascalNodeDriver, pascalSceneBinding } from "@huma/pascal-time";

const driver = useMemo(() => new PascalNodeDriver(pascalSceneBinding()), []);
useFrame((_, delta) => {
  driver.sync(timeline, { time, playing: true, driving: true });
});
// and when the timeline stops owning the scene:
driver.release();   // every object it touched goes back to its pre-drive pose
```

## What it contributes

| Kind | What it is |
|---|---|
| `huma-time:timeline` | The scene's clock — duration, loop, autoplay. One per scene. |
| `huma-time:cue` | A named moment on that clock. Parented to the timeline it is measured on. |
| `huma-time:shot` | A camera, and the moment it takes over. Static or orbiting a node by id. |

**The shot is the exception, and the exception is the rule working.** A shot *is* placed — an
author drags it, aims it and expects to see where it looks from — so under the same
classification test it is an ordinary spatial node. It therefore parents where spatial things
parent rather than under the timeline (it names its clock with a `timelineId` field instead),
carries `movable` and `rotatable`, and is the one kind here that draws anything. It is also why
the shot never meets trap 11: renderable time kinds are spatial, and spatial nodes have a home.

The clock and the cue have no position, deliberately: under the integration design's classification test a node
earns a place in space by being *placed by a person*, and neither a clock nor a moment is. They
are organisational nodes of the same class as Pascal's own site, building, level and zone, which
is why both declare `dirtyTracking: false` and a `hitVolume` of `none`.

**Why a cue is a scene node at all**, when it is pure timeline data: because an author creates
it, names it, retimes it, deletes it and expects Ctrl+Z to bring it back. Pascal already does
every one of those for any registered kind. A cue kept only in a timeline document would need
all of it rebuilt. `readCues()` hands the time layer plain `{ id, name, time }`, so the timeline
never learns that a scene document exists.

The cue's **node id is the cue id**. Ids are a contract, Pascal mints them, and a hotspot that
navigates to a cue therefore stores a node id like every other reference in the system rather
than a second class of identifier needing its own stability rules.

Tracks are persisted on the timeline node — see below.

## Pascal plugin contract — every one of these fails silently

The first four are recorded in `docs/plans/…-elastiq-system-implementation-v1.md`. The rest were
found building this package and are not written down anywhere else.

1. **`def.renderer` must be `{ kind: 'parametric', module: () => import('./x') }`** and the
   module must have a **default export**. A direct component reference is dropped by
   `getRegistryRenderer` with no warning: the kind registers, the scene stays empty, nothing
   says why. `test/plugin.spec.ts` asserts the shape *and* awaits the module, because the
   assertion is cheap and discovering it in a browser is not.
2. **Register through `loadPlugin`, never `registerNode`.** Only `loadPlugin` records the
   kind-to-plugin mapping that `isNodeKindEnabled` consults. Registering directly *bypasses* the
   per-project install gate rather than satisfying it — the kind then works in every project,
   including ones that never opted in.
3. **Register at module import time**, before any React tree renders. From an effect, every
   node of the kind resolves to null on the viewer's first pass.
4. **Nodes may be roots.** `parentId` is optional and nothing validates parent kinds, so a kind
   with no architectural home does not need one.
5. **`loadPlugin` is declared `async` but registers synchronously** — its body has no `await`
   before the registration loop. So callers need not await it, but an `apiVersion` mismatch
   throws *inside the returned promise*: unawaited, it surfaces as an unhandled rejection with
   nothing pointing back at the plugin. `registerPascalTimeKinds` attaches a handler.
6. **`setInstalledPlugins` replaces the list, it does not append.** Two plugins that each call
   it with only their own id leave the second installed and the first silently uninstalled.
   `installPascalTimeOnScene` merges, which is the behaviour any shipped plugin needs.
7. **A third-party kind's node id cannot type-check against the store.** Pascal types
   `createNode` / `deleteNode` / `nodes` against `AnyNodeId`, a template-literal union of
   `` `${builtinKind}_${string}` `` over its own 46 kinds. A plugin kind is in none of them, so
   every store call from a plugin is a type error. It is only a compile-time artefact —
   `BaseNode.id` is a plain `z.string()` at runtime, and Pascal's own schema file carries a
   comment explaining that a narrower type would break `.extend()` for downstream kinds.
   `src/plugin/scene-ops.ts` holds that cast once, for everyone. **Worth upstreaming.**
8. **`@pascal-app/core` is bundler-only, not just `@pascal-app/nodes`.** Its `dist/index.js`
   uses directory imports (`./events/bus`), which plain Node ESM rejects. Under Vitest this is
   one line of config — `server: { deps: { inline: [/@pascal-app\//] } }` — and it is what lets
   this package's tests run against Pascal's **real** store and **real** registry instead of a
   stand-in shaped like them.
9. **Dirty marking is deferred to `requestAnimationFrame`.** `updateNodesAction` batches marks
   into one frame callback, so in Node nothing is ever marked and any test asserting "driving
   left the dirty set alone" passes while measuring nothing. `test/setup.ts` supplies the shim;
   `test/driving.spec.ts` carries a control that fails if the counters stop moving.
10. **`Viewer` and `useViewer` are named exports** in the published beta, not defaults, unlike
    the repo source.
11. **A container kind must render its own children, or they never mount.** Pascal's
    `<NodeRenderer>` renders the node's *own* renderer and does not dispatch children — that is
    why its site and level renderers dispatch theirs explicitly. A kind that accepts children
    and does not is a silent hole: the nodes exist in the document, behave correctly in the
    store, and are invisible. Measured here — three cues parented to the timeline node leave the
    scene at 7 nodes and 4 registered objects. It costs nothing today because cues have no
    geometry, and `huma-time:cue` therefore ships **no renderer at all** rather than an
    unreachable one. **M1.4 has to decide it properly**, because a shot or a camera parented to
    the timeline may well want to draw something: either the timeline renderer dispatches
    children (which means depending on `@pascal-app/viewer` for `<NodeRenderer>`, or
    reimplementing its install gate and lazy-module contract), or renderable time kinds are
    parented at the scene root instead.
    **Resolved in M1.4: the second.** A kind that draws something is a kind an author places, and
    a placed thing is spatial under the classification test — so it parents where spatial things
    parent and names its clock with a field. `huma-time:shot` does exactly that and renders
    normally. The container hole is real but nothing needs to sit in it, so the timeline renderer
    stays a leaf. Revisit only if a time kind ever needs to both draw and be non-spatial.

## The ownership rule this package exists to keep

**Write to the live `Object3D`, never to Pascal's node data.** That is what keeps playback out
of the undo history, and it is asserted rather than assumed:

| Measurement | Headless (`pnpm test`) | Browser (`pnpm --filter pascal-time-harness verify`) |
|---|---|---|
| Frames driven | 2000 | ~400-600 at ~43 fps |
| Undo depth grown by driving | 0 | 0 (5 → 5) |
| Dirty-node count grown by driving | 0 | 0 (3 → 3) |
| Frames where our write was overwritten | — | 0 |
| Worst drift | — | 0.00000 m |
| Pre-drive pose restored on release | exact | exact (0 m) |

Both suites include a **control**: one ordinary `updateNode` must move undo depth by exactly 1
and put the node in the dirty set. Without it the zeros above are indistinguishable from a
broken instrument, which is not hypothetical — the first version of the dirty assertion passed
for that exact reason.

## Where tracks live, and why — decided against my own first recommendation

Tracks are **one versioned field on the timeline node**, not a node per track. I argued the
opposite first, on three claims that measurement then killed. They are recorded here so nobody
re-derives the same wrong answer:

| Claim I made for track-as-node | What measurement showed |
|---|---|
| Per-track undo granularity | **False.** Pascal's undo is granular over store *operations*. Two edits to two nodes and two edits to one node both push two entries; one batched call pushes one. |
| Schema migration for free | **False.** `NodeDefinition.schemaVersion` is validated as a positive integer at registration and never read again. There is no migration hook in the contract; Pascal's own migrations are two hand-written functions. |
| Inspector derived from the schema | **False.** The inspector comes from `def.parametrics`, a hand-declared `groups` descriptor. You write it either way. |

Since the migrator is ours regardless, one versioned payload is the smaller thing to migrate,
and the outliner presence that nodes would have bought largely duplicates the timeline panel
M1.3 delivers anyway. What track-as-node genuinely still offers is a better substrate for
concurrent editing — which matters at M4, not now — and that is the one reason to revisit.

**The hazard this API exists to prevent.** Pascal's undo snapshot holds the nodes map **by
reference**, not as a deep copy. Measured: mutating a stored array in place and then undoing
does *not* restore it, because the past state was mutated too. So every editing function here
returns a new array and never mutates, and a test enforces it.

```ts
import { readTimeline, putTrack, remapTracksAfterClone } from "@huma/pascal-time";

const timeline = readTimeline(clockId);      // a genuine path-creator Timeline
putTrack(clockId, track);                     // one updateNode, one undo entry
remapTracksAfterClone(clockId, idMap);        // R8: the duplicate keeps its animation
```

`readTimeline` builds through `createTimeline`, so the result carries the library's own schema
version rather than being a lookalike. The stored payload carries `trackPayloadVersion`, and a
missing value reads as **0** rather than as current — which is precisely the trap elastiq's own
decks fell into, where a migrator has to sniff the shape and guess.

Only transform and activation tracks are persisted, because those are the two the driver
applies. Persisting a shape nothing reads is a promise the document does not keep.

## Shots, and the camera rule

`readShotDefinitions(timelineId)` turns authored shot nodes into a map of `@huma/path-creator`
virtual camera definitions keyed by node id — which is what a camera block's `vcamId` names.
`PascalCameraDirector.sync(camera, { timeline, vcams, time, controls })` applies whatever the
timeline resolves. In a gap it writes **nothing**, leaving the host's camera alone rather than
snapping it somewhere; a gap is a deliberate state, not an error.

**Resolution is the library's, not this package's.** Which shot is live at `t` and how it blends
is `evaluateTimeline`, which already does it — with blend curves, per-block overrides and an
animated lens. This package first shipped its own resolver, which worked but was the weaker
implementation: it snapped the field of view at a cut instead of blending it, and it was a
second copy of logic that could drift. It was replaced. What is left here is the half the
library cannot do: obeying R9 against whatever controller the host has mounted.

**Where a shot's timing comes from.** A camera track in the persisted payload, if there is one.
Otherwise `synthesiseCameraTrack` builds one at **read** time from the shot nodes' own
`timeSeconds` and `blendSeconds`, so a document written before camera tracks existed still plays
its shots — and loading it does not rewrite it. An authored track always wins. That also lifts
M1.4's carried limitation: a camera track can name the same shot in two blocks, so one shot can
be used at two times.

An orbit shot names the node it frames. **That is the seam paying for itself:** move the subject
and the shot re-frames it, with no timeline edit at all. Covered headlessly, and measured in the
browser as an orbit radius of exactly 5.0 held against the node it tracks.

**R9 — the camera has exactly one owner per frame.** With no controller mounted the director
writes the camera outright. With one mounted, the *controller* owns the camera and the director
feeds it the same resolved pose through `setLookAt` followed by `update(0)`; `camera-controls`
re-derives its pose from its own state on every update, so a pose handed to it without an update
is a pose it has not applied. The director still sets the lens either way, because a camera
controller has no opinion about field of view.

Measured against drei's **real** `CameraControls` — the same component Pascal's editor mounts —
in system Chrome on WebGPU:

| | |
|---|---|
| Frames where the camera did not hold the resolved pose | **0 of 451** |
| Worst positional error | **0 m** |
| Orbit radius held against the framed node (authored 5.0) | **5.0** |

The headless suite carries the control that makes those zeros mean something: a direct write
past the same controller is shown to be *lost* on its next update. Without that, "feeding the
controller works" would also be true of a controller that did nothing.

## Cues, and what the ride demonstrates

`readCues(timelineId?)` reads the authored cue nodes out of the scene document as the plain data
`@huma/path-creator/timeline` takes. Navigation is then the library's: `rideToNext`,
`rideToPrevious`, `rideToCue`.

A ride is not a cut. It animates `t` itself, so the camera, the transforms, the visibility and
the audio all follow from one number and there is no separate transition system to build. The
harness makes that falsifiable rather than decorative: it rides to a cue named `peak` over ~46
frames and checks not only that the clock landed on 4.0 exactly, but that the driven marker was
at y = 3.4 — the pose the transform track specifies for that instant. Landing on the number
without the scene matching it would pass a weaker test and fail this one.

The ride **seeks rather than plays**, so arriving at a cue is scrub-exact and does not fire the
events it passed over. Skipping to slide five must not trigger every sound between here and
there. That is covered in the library's own suite.

## A shot owns a BLOCK, and the overlap is the crossover

A shot's block has a start and an end, and **where a block reaches past the next one's start, the
excess is the blend between them**. So the thing an author drags is the thing that shapes the
hand-off, and two shots crossing on the lane look like what they are.

This replaced a model where `blendSeconds` was a number on the shot and blocks abutted. Three
things were wrong with it and only the first is cosmetic: the lane drew a hard seam over a real
ramp, the crossover was editable only by typing, and the lane's drag handler *kept* blocks
abutting — pushing one block over the next just pushed the next along in front of it, so an
overlap could not exist. `@huma/path-creator`'s own demo has always done it the other way
(`scene-io.ts` derives `overlap = previous.end - shot.start`), and the library was already on that
side: `evaluateCameraTrack` takes the last block whose start has passed, so overlapping blocks
blend correctly, and `gapMode` defaults to `hold`, so an explicit end does not release the camera.

**A document written before spans still plays, and loading it does not rewrite it.** `endSeconds`
of 0 (or anything at or before the start) reads as unset, and `readShotBlocks` reconstructs the old
layout *as an overlap*: blocks abut, and the next shot's legacy `blendSeconds` becomes the overlap
that produces the crossover it used to describe. A spec drives the same moment both ways and
checks the camera lands in the same place. `blendSeconds` survives in the schema for exactly that
reconstruction — nothing authors it, and it is deliberately not an inspector field, because the
blend's duration now has one home.

What the demo leaves on the table is the curve: it hardcodes `easeInOut`. That is the one part of
the crossover authored here (see below), so the overlap gives the blend its LENGTH and
`blendCurve` gives it its SHAPE.

## Rails (M1.7)

The library's oldest strength, and the last part of it a Pascal document could not say.

**`huma-time:path` is a rail.** Its field names mirror `SerializedBezierPath` exactly, because
`BezierPath.fromJSON` takes that shape and a translation layer between two identical shapes is a
place for them to drift. **Its points are LOCAL to the node**, and that is load-bearing: the reader
folds the node's world matrix into them, so the library always receives a world-space path and
every cart frame comes out in world space. That is what lets *Pascal's own move gizmo* drag a whole
rail, with Pascal's own undo, instead of this package inventing a rig transform and threading it
through the library's resolve context.

**`huma-time:cart` rides one, naming it by id.** It has no position and is not movable, which is
the interesting case: a cart IS placed by a person, but placed *along a path by distance* rather
than in space. Its world position is derived every frame, so storing one would be a second,
always-stale answer to where it is. It still draws, so it parents where spatial things parent —
trap 11 applies to anything that draws, not only to anything with a position.

**A shot's `body: "cart"` names a cart**, and where the cart is at time `t` is a **cart track's**
business, not the shot's. So a shot says only which rail it is on, and a dolly run is a track like
any other track.

**The rig is built tolerantly, where the library's own builder throws.** `buildRigRuntime` rejects
a cart naming an unknown path, which is right for a finished document loaded whole and wrong
mid-edit: a cart exists for a moment before its path is chosen, and a path can be deleted while a
cart still names it. Throwing would take the viewer down during authoring. Such a cart is skipped,
the library resolves no frame for it, a cart-bodied shot resolves to nothing, and the director
already handles that by writing nothing at all. A path with fewer than two anchors is skipped for
the same reason — an author's first click has one point.

**Viewport shaping is the library's `PathEditor`, injected twice.** It is already controlled
(`onMovePoint`, `onTransformingChange`), so what a Pascal host has to supply is two things, and
both are silent failures if missed:

- **`gizmo={TransformGizmo}`** — drei's `PivotControls` draws fat lines, which three's WebGPU
  backend cannot auto-map, and it loses the device. The library ships the fork for exactly this.
- **`helpersLayer={PASCAL_OVERLAY_LAYER}`** — Pascal's post-processing composes the frame from
  passes with **fixed layer sets** (`scenePass.setLayers`, `overlayPass.setLayers`), so a subtree
  on the library's own reserved helper layer is in no pass and is **never drawn**, however the
  camera's mask is configured. With post-processing disabled it renders fine, which is what makes
  it a trap rather than a bug. The handles belong on Pascal's `OVERLAY_LAYER` — where its own
  gizmos live — and a spec pins that number against the real export.

Reading the whole point list back out of the live `BezierPath` after each move is not optional
either: in `automatic` control mode `movePoint` also recomputes the neighbouring CONTROL points
(and ignores a direct move of one), so persisting just the dragged index would save a shape the
editor is not showing.

**Found while building it, in the library:** `perAnchorNormalsAngle` is a parallel array to the
anchors, and a length mismatch does not fail — it produces NaN normals that propagate into every
sampled frame's up/right and then into any cart offset, while `VertexPath.length` still reads
correctly. So the symptom is a camera at NaN on a rail that measures 10 m. `toJSON` always emits
the right length, so this only bites a hand-authored document — which is exactly what node data
is. `BezierPath.fromJSON` now normalizes, with the NaN case kept as a regression test.

## The camera language (M1.8)

The library evaluates far more of a camera than the panel could say, so this phase is **exposure,
not implementation**: every behaviour below already worked in `@huma/path-creator` and was simply
unreachable from a Pascal document.

**Where it lives, and why the shot node.** `synthesiseCameraTrack` maps one shot to one camera
block, so a field on the shot node *is* that block's field. That keeps the shot list the single
authoring surface an author already uses, and it means none of this needed a new concept. The
persisted block schema carries the full shapes regardless — see the widening note below.

| What | Authored where | Reaches the library as |
|---|---|---|
| Blend curve (preset or hand-shaped) | panel, `EasingEditor` | `blendIn.curve` |
| FOV push | panel + inspector | `block.lensAnimation.fov` |
| Rotation-key easing | panel, `EasingEditor` | `TransformKey.easing` |
| Aim target (instant look-at) | panel, from the selection | `aim: { type: "track", target }` |
| Damped composer | inspector (`Composer` group) | `aim.settings` |
| Seeded noise | inspector (`Noise` group) | `definition.noise` |

**The persisted schema was narrower than the library, and that was a latent bug.**
`BlendInSchema.curve` was `z.string()`, but the library's `TimelineBlendIn.curve` is an `Easing`
— a preset name **or** a curve. A hand-shaped blend would not merely have lost its curve: the
block would have failed to parse and `migrateTrackPayload` would have dropped the whole track,
silently. It is now the full `EasingSchema`, plus `lensAnimation` and an opaque `overrides`
record. A spec keeps the pre-M1.8 declaration as a **control** and shows it rejecting the same
payload. Widen, never narrow.

**Rotation easing needed a library change, not a panel one.** Rotation slerps with one shared
`easing` per key and the curve canvas deliberately disables tangent handles there, so the curve
has no on-canvas handle to drag — and the panel had no way to learn which key an author meant.
`KeyframeCurveEditor` now reports its primary selection through an optional `onSelectKey`, and
the panel mounts an easing editor for whatever is selected.

**The composer is the one stage that is not a pure function of `t`.** It damps from the previous
frame, which is why the library keeps it out of `resolveVirtualCameraDefinition` and leaves it to
a drive-loop stage (`stepComposerAim`). The director runs that stage — and resolves the conflict
with scrub-exactness rather than accepting it: **when the clock is not running, the carried state
is dropped and delta is 0**, which reduces the correction to the soft-edge clamp with no damping
term, a pure function of the current frame. So scrubbing to a time always gives the same frame
and only playback damps. Measured both ways, with a control: 30 played frames at the same `t`
move the pose, and the same `t` reached by three different scrub routes does not.

`lens.dutchDeg` is deliberately **not** exposed. With a controller mounted the director hands
over a position and a look-at pivot, and a pivot cannot express roll — so a dutch authored here
would be a silent no-op in Pascal's editor specifically. It stays available to hosts that own the
camera outright.

**The PiP** renders what the selected shot sees into a scissored inset while the author keeps
their working view. Two things make it work:

- It runs at `useFrame` priority **2**. Pascal's post-processing pass renders at priority 1, and
  any positive-priority subscriber disables R3F's own render — so 2 is the only place a second
  draw lands *on top of* the composited frame instead of being overwritten by it. It restores the
  scissor and the full viewport in a `finally`: a scissor left set clips the next frame's main
  render to one corner, and that failure looks like the editor went blank.
- It owns a **second camera** (R9). Measured: turning the PiP on moves the viewport camera by 0 m.
  It also prefers the pose the director actually applied when the previewed shot is the one in
  force, so the inset agrees with the viewport rather than deriving a second answer.

Standing at a shot's lens is standing inside its own marker, so the pass hides that shot's
registered group for its own draw and restores it — the same trap the marker's proximity rule
solves for the main camera, and the measure checks the restore.

**Measured in the browser (system Chrome, WebGPU), all through the panel's own controls:**

| | |
|---|---|
| Custom blend curve, node → camera block | authored as a `curve`, arrives as a `curve` |
| Undo cost of one curve gesture | **1 entry** (10 → 11) |
| Live lens across a shot's window | **46.91° → 20.10°** |
| A tracked aim's forward vs. the node it names | dot **1.000000** |
| Composed shot, same time via three scrub routes | **0.00e+0** drift |
| PiP pose vs. the shot it names | **0 m** |
| Viewport camera drift when the PiP turns on | **0 m** |
| Seeded noise, same time twice | moves the camera 1.19e-2 m, repeats **0.00e+0** |

**Rails and the span model add another 27:** a rail samples at 8.00 m the moment it exists, all 28
handle objects sit on Pascal's overlay layer, a real mouse drag reshapes the document by 0.227 m at
no more undo cost for 24 pointer moves than for 6, a cart travels 10.87 m with no position anywhere
in the document, a cart-bodied shot sits on its cart to **1.99e-15 m**, moving the rail moves the
shot by exactly the 5 m the rail moved, and mid-crossover the camera is 1.55 m from one shot and
4.44 m from the other across a 5.99 m gap.

The suite is **113 checks**, up from 59 before M1.8. Reproduce with
`pnpm --filter pascal-editor-host verify`.

## Known, expected, not a gap

Pascal has no runtime `AnimationMixer` for its nodes, so `resolveAnimation` returns null and
**every transform track over a Pascal node is absolute**. Additive mode exists to layer
corrections over mixer output; here there is nothing to layer over. Skinned GLB clip playback
stays `@huma/path-creator`'s job, on objects it registers itself.

## The authoring panel (M1.3), and the two-entry split

The panel has two surfaces. **The lane dock** — path-creator's real `TimelineLanes` editor,
docked over the viewport bottom while the panel is open — is the timeline: a draggable shot
lane (dragging the seam between two shots retimes both, one undo entry), a pinned cue lane,
one lane per transform track whose block carries the motion sparkline and a marker per
keyframe and retimes the whole track on drag/resize (tangent time-components scale with it),
and clip lanes for visibility. Double-click a motion lane to key the object's current pose at
that moment; double-click the cue lane to drop a cue. **The sidebar** keeps what a sidebar is
good at: transport (play/pause/stop and the **preview/edit toggle** — preview scrubs the
animation, edit mode parks the playhead WITHOUT driving so a tracked object can be posed with
Pascal's own tools and then keyed), keyframe capture for the viewport selection (full TRS, one
`putTrack`, one undo entry per press), the `KeyframeCurveEditor` over the selected track with
**per-gesture write batching** (the editor fires onChange per pointer-move; edits buffer in a
draft and pointerup commits once), naming and blend/target fields, and `def.parametrics`
inspectors for all three kinds. Both surfaces share one clock: the lanes drive a
`TimelinePlayer` facade over the same transport store.

A host using Pascal's editor mounts it in two lines next to the manifest registration:

```ts
import { registerPascalTimeHostPanel } from "@huma/pascal-time/host-panel"; // bootstrap
registerPascalTimeHostPanel();
// and inside the page:
<Editor viewerSceneSlot={<PascalTimeSceneDriver />} />
```

`PascalTimeSceneDriver` (runtime entry) rides `EditorProps.viewerSceneSlot`, shares the
viewer's frame loop, finds the mounted CameraControls through R3F's default-controls slot (R9
with zero wiring), and rebuilds its evaluation inputs whenever the document changes — so undo
and redo just work. The panel and the driver meet in `pascalTimeTransport`, a shared ephemeral
store; playback intent never touches the scene document, which is why scrubbing and playback
leave Pascal's undo history alone **by construction**.

## Layout

```
src/plugin/kinds.ts        node schemas — what Pascal persists
src/plugin/definitions.ts  definitions, parametrics, presentation, the manifest
src/plugin/install.ts      registration and per-scene install
src/plugin/scene-ops.ts    the store boundary, cast once (trap 7)
src/plugin/timeline-io.ts  document <-> Timeline: read, putTrack, writeTracks, clone remap
src/plugin/keying.ts       keyframe + visibility capture (pure cores, one-write impure halves)
src/plugin/rails.ts        pure rail/run arithmetic: starter shape, add/remove anchor, new run
src/render/                renderers — default export, lazy module (trap 1)
src/bind/scene-binding.ts  any id->Object3D map as an ObjectBindingResolver
src/drive/                 node driver, camera director (+ composer stage), scene driver, PiP
src/transport/store.ts     the shared playback transport (preview/edit semantics live here)
src/host-panel/            the panel — the SEPARATE entry, editor-coupled
```

The single `.` entry is framework-agnostic: it imports `@pascal-app/core` and never
`@pascal-app/editor`, so Vite and Next can both consume it. The panel is editor-coupled and
therefore Next-coupled, and ships as the **separate `@huma/pascal-time/host-panel` entry** —
never from `src/index.ts`. A single entry that conditionally imports the panel will not survive
a bundler; nor will two entries without shared chunks, which would give each entry its OWN COPY
of the transport store — a panel scrubbing a clock no driver reads. Both properties are
asserted in `test/host-panel.spec.ts`, along with the tsconfig-`paths` trick that type-checks
against a local editor contract while the built JS imports the real package. See the plan's
§0b for the two-app topology this serves.

One thing to know before planning that: `@pascal-app/nodes` reaches `@pascal-app/editor` through
a static import chain, so "runtime = core + nodes + viewer, no editor" is not achievable at
`1.0.0-beta.4` however cleanly this package is split. Evidence and the three ways out are in
`docs/technical/INTEGRATION-DESIGN.md` §11.
