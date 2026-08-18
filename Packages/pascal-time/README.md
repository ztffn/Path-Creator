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

## Known, expected, not a gap

Pascal has no runtime `AnimationMixer` for its nodes, so `resolveAnimation` returns null and
**every transform track over a Pascal node is absolute**. Additive mode exists to layer
corrections over mixer output; here there is nothing to layer over. Skinned GLB clip playback
stays `@huma/path-creator`'s job, on objects it registers itself.

## The authoring panel (M1.3), and the two-entry split

The timeline panel is the editor-facing half: transport (play/pause/stop and a **preview/edit
toggle** — preview scrubs the animation, edit mode parks the playhead WITHOUT driving so a
tracked object can be posed with Pascal's own tools and then keyed), keyframe capture for the
viewport selection (full TRS, one `putTrack`, one undo entry per press), the reused
`KeyframeCurveEditor` over the selected track with **per-gesture write batching** (the editor
fires onChange per pointer-move; edits buffer in a draft and pointerup commits once), a clip
editor for visibility (an object is visible inside any activation clip and hidden outside all
of them), cue and shot lists ("+ shot from view" captures the viewport camera through the
scene driver's per-frame snapshot), and `def.parametrics` inspectors for all three kinds.

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
src/render/                renderers — default export, lazy module (trap 1)
src/bind/scene-binding.ts  any id->Object3D map as an ObjectBindingResolver
src/drive/                 node driver, camera director, the viewerSceneSlot scene driver
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
