<!--
Purpose: The presentation prototype — a Pascal-owned scene of GLBs and hotspots driven by
a path-creator timeline where slides are timestamps — plus the findings log from the spike
that established the boundary it is built on.
Scope: examples/elastiq. The scene kinds, the cue transport and the binding adapter
have promotion paths; the probe harness that answered Q1-Q5 has been removed now that the
answers are recorded below.
-->

# Presentation prototype, on the scene/time boundary

## What this runs

`pnpm --filter elastiq dev`. Three GLBs placed in a Pascal scene, a hotspot marker beside
each, and four cues. **Arrow keys or the buttons move between slides; clicking a marker jumps to
its slide.**

The interaction model is the whole point: a presentation is ONE timeline, a slide is a named
timestamp on it, and "next slide" is not a cut — it **rides the clock** from where it is to where
the cue sits, eased. Because the timeline is a pure function of `t`, animating `t` moves the
camera and everything else for free. There is no separate transition system to build.

| File | What it holds |
|---|---|
| `scene-kinds.ts` | The product's node vocabulary: a GLB at a transform, and a hotspot. |
| `scene-plugin.ts` | Those kinds as one Pascal plugin manifest. |
| `model-renderer.tsx` / `hotspot-renderer.tsx` | Their renderers; `useRegistry` is what makes them timeline-drivable. |
| *(cues)* | Slides as timestamps and the ride between them — **promoted into `@huma/path-creator/timeline` in M1.5**; this example now imports them. |
| `presentation.ts` | The authored content — scene above the line, cues and shots below it. |
| `src/render/scene-binding.ts` | Pascal's registry as a path-creator `ObjectBindingResolver`. |

## Two shells, one document — `?mode=reading`

The product wants a polished look sometimes and clear visual reading other times. Those are two
renderers, not one renderer with a switch, and the scene document does not care which is mounted.
Both are running:

| Shell | What it is | For |
|---|---|---|
| **polished** (default) | Our own R3F canvas — HDRI environment, contact shadows, room for bloom and depth of field | Presentation |
| **reading** (`?mode=reading`) | Pascal's `<Viewer>` — WebGPU, SSGI, denoise, inked edges, merged outlines | Inspection, technical read |

**Identical in both:** the scene document, the node kinds, *their renderers*, the cues, the shots
and the timeline. Verified — six nodes, six rendered, same navigation, no errors either way. Only
the shell around them differs.

That works because our node renderers are contributed by the plugin, so Pascal's dispatch and our
twenty-line `scene-renderer.tsx` both mount the same components. The look comes from the shell —
lights, environment, post — not from the kinds.

**The discipline this imposes:** node renderers must stay renderer-agnostic. No WebGL-only
materials inside a kind, or it breaks under the WebGPU shell. That is the same lesson this
library already learned the hard way, and why it ships `RigLine`, `RigLabel` and `TransformGizmo`.

**What Pascal contributes either way, and it is the valuable half:** the node registry, Zod
schemas with migrations, the store, undo, hierarchy, plugin kinds with their install gate, and
the id-to-`Object3D` registry the timeline binds to. That is the part you would otherwise build
by accretion — exactly how this library grew an entity system nobody designed.

**What it does not contribute:** any of its 46 architectural kinds. Nodes are created as roots;
`parentId` is optional and nothing in core validates parent kinds, so site/building/level is
simply unused. The scene is six nodes, all of them ours.

Shots bind to models **by node id**, so moving a model re-frames its slide with no timeline edit.
That is the boundary paying for itself rather than just being documented.

---

# The spike that established this — can someone else own the scene graph?

## Why this exists

`@huma/path-creator` has grown an entity system by accretion: an id-to-object registry,
per-object tracks, a hierarchy panel, selection, inspectors, a gizmo, serialization with
migrations, undo, nested scenes, and a trigger/action layer. It is not a prefab system —
it has no templates, no instancing, and no entity parenting — but it is close enough to one
that the next roadmap item would quietly turn it into a scene editor.

That item is **interactive hotspots**. A hotspot is *world-anchored*: it has a position of
its own and no counterpart object in the host application. Building it here would be the
moment this library starts owning scene content rather than referencing it, which breaks
the boundary the roadmap states deliberately ("GLTF fetching and component lifecycle are
host-owned"). This spike tests the alternative before that line gets crossed.

**The intended end state:** [Pascal](https://github.com/pascalorg/editor) becomes the scene
editor for elastiq/humatopia, replacing the flat `ModelViewerSceneConfig` (a list of model
URLs with hardcoded positions, instanced by a `for` loop). This library supplies the layer
Pascal has none of: time.

## What each side already has

| | Pascal | path-creator |
|---|---|---|
| Owns | space — what exists, where, parented how | time — when things move, cut, sound, fire |
| Entities | flat node dict keyed by id, `parentId` for hierarchy | ids only; the host registers the real objects |
| Templates | `getSubtree` + `cloneNodesInto` (a prefab primitive) | none |
| Extensibility | plugin node kinds: schema, renderer, tool, inspector | fixed track kinds |
| Timeline | none | versioned schema, pure evaluator, scrub-safe |
| Camera | viewer/walkthrough controllers | virtual cameras, blends, dollies, orbit, override |

The two are close to complementary. MIT licensed, actively developed, React 19 + three +
React Three Fiber + drei, WebGPU renderer — the same stack this library was made safe for.

## The seam

`@pascal-app/core` exports a module-level `sceneRegistry` whose `nodes` field is documented
as *"Master lookup: ID -> Object3D"* — a `Map<string, THREE.Object3D>`. That is the same
shape as this library's `ObjectBindingResolver`:

```ts
export interface ObjectBindingResolver {
  resolve(id: string): Object3D | null;
  resolveAnimation(id: string): ObjectAnimationBinding | null;
}
```

So the adapter is nearly trivial (`src/render/scene-binding.ts`). The spike is not about whether
that adapter compiles — it is about whether the two systems can write to the same objects
without fighting.

## Questions, in the order they should be answered

Each is falsifiable. Record the answer in **Findings** below, including the ones that fail.

- **Q1 — Does the binding hold?** Can `TransformTrackDirector` and
  `ActivationTrackDirector` drive objects registered in `sceneRegistry`, including
  restoring the pre-drive pose on leave? *Headless, cheap, decisive.*
  Run: `pnpm --filter elastiq test`.

- **Q2 — Does Pascal fight us?** With the real viewer mounted, does writing an
  `Object3D`'s transform every frame survive Pascal's own render pass, and does it leave
  Pascal's node data and undo history untouched? Pascal tracks a dirty-node set and exposes
  `pauseHistory` / `resumeHistory` and a `useLiveNodeOverrides` store described as the path
  for "transient animation frames" — so there is a sanctioned route if direct writes lose.
  **This is the question that decides the whole approach.**

- **Q3 — Who owns the camera?** Can a path-creator virtual camera drive Pascal's viewer
  camera, or does the viewer hold it exclusively? A shared scene with two camera owners is
  the most likely place this falls apart.

- **Q4 — Can a hotspot be a Pascal plugin node kind?** This is the question that started the
  spike. Pascal's vocabulary is architectural (site, building, level, wall, slab), so
  whether its plugin API generalises to "a clickable annotated point bound to a timeline
  action" is an assumption, not a fact. **Answered: yes** — see Findings.

- **Q5 — Do the dependencies reconcile?** Pascal peers `three@^0.185`; this workspace is on
  `0.181.2`. Three must be a singleton, so two copies in one app will break. Either the
  workspace bumps or the spike is a lie.

## Kill criteria

Abandon the approach — and go back to planning a first-party entity model — if **either**:

1. Q2 fails in a way `useLiveNodeOverrides` cannot fix, meaning per-frame animation costs a
   React render per frame or corrupts undo. A timeline that cannot drive at 60fps without
   dirtying the document is not a timeline.
2. Q4 needs a fork of Pascal rather than a plugin. Plugin-shaped is sustainable; forked is
   a second product to maintain.

Q3 and Q5 are cost, not viability — they change how much work this is, not whether it works.

## Not in scope

Migrating elastiq, the mission editor for the Delta Force project, replacing the demo, and
anything about persistence or multiplayer. Those depend on the answers, and one of them is
"do not do this".

## Status — all five questions answered

Q1 yes · Q2 yes (1 drifted frame in 2220) · Q3 yes with a rule · Q4 yes end to end · Q5 yes at
the cost of one aligned version bump. **Neither kill criterion fired.**

## Findings

### Q1 — Does the binding hold? **Yes.** (2026-08-17)

The adapter is four lines (`src/render/scene-binding.ts`). Against a registry with Pascal's exact
contract, `TransformTrackDirector` and `ActivationTrackDirector` both drive objects by node
id, and both hand the pose back untouched when the timeline is left — which matters, because
otherwise scrubbing would silently rewrite the scene editor's idea of where things sit. A
node deleted out from under a live track does not throw, which it must not: the scene editor
owns the lifecycle, so nodes can vanish under tracks that still reference them.

Four tests, `pnpm --filter elastiq test`. Note this proves the *contract*, not
coexistence — it runs against a stand-in map, so nothing else is competing for the objects.

**Caveat found while writing it:** Pascal has no runtime `AnimationMixer` for its nodes (its
only animation surface bakes clips into an exported GLB), so `resolveAnimation` returns null
unconditionally. Every transform track over a Pascal node is therefore absolute — the
additive mode, which exists to layer corrections over mixer output, has nothing to layer
over. Not a blocker; it does mean GLB clip playback stays this library's job, on objects it
registers itself, not Pascal's.

### Q5 — Do the dependencies reconcile? **Yes, at the cost of one aligned version bump.**

Pascal peers `three@^0.185`; this workspace was on `0.181.2`. npm refuses the install
outright at 0.181, so this is a hard gate, not a warning.

Bumping the examples alone is **not** enough, and the failure is worth recording because it
would bite any consumer. This library emits its type declarations against its own
`@types/three`, so an example resolving 0.185 while the library declared 0.181 produced
errors like *"Matrix4 from @types/three@0.185.4 is not assignable to Matrix4 from
@types/three@0.181.0"* across `activatables.tsx`, `camera-pip.tsx`, `demo-scene-viewport.tsx`
and the crate inspector. Three has to be a singleton at the type level too.

Aligning `@types/three` in the package as well clears it completely: **233 package tests, 77
demo tests, 4 spike tests all pass, and the package plus all three examples build clean.**
The runtime peer range (`>=0.181.0 <0.190.0`) already allowed 0.185, so nothing about the
library's declared support changed. That bump is applied on this branch.

### Q2 — Does Pascal fight us? **No. 1 drifted frame in 2220.** (2026-08-17)

Measured against the real `<Viewer>` in system Chrome on WebGPU, with the probe mounted as a
Viewer child so it shares Pascal's own frame loop. `pnpm --filter elastiq dev`, then
read the panel or `window.__spike`.

| | |
|---|---|
| frames sampled | 2220 (~45s) |
| sustained rate | 49.7 fps |
| frames where our write was overwritten | **1** — frame 1, the mount |
| worst drift on the clean path | 0.02 m, self-healed the next frame |
| mid-playback edits to *other* nodes (frames 200/400/600) | **0** drift |
| Pascal undo depth grown by driving | **0** (only explicit edits moved it) |
| Pascal dirty-node count while driving | **0** |

Writing straight to the `Object3D` that `sceneRegistry` hands back survives Pascal's render
loop, costs no React render, and leaves its document and undo history untouched. Both kill
criteria for Q2 are clear.

**The one conflict, and it is narrow.** Run with `?pokeDriven` and the harness updates *the
node being driven* mid-playback. That forces the React commit which reapplies `position` from
node data, and the object snaps back to its authored pose for exactly one frame (1.98 m of
drift, recovered on the next frame). Editing any *other* node never does this. So the rule is:
a node under timeline control should not be edited in Pascal's store while the timeline runs —
and if that becomes necessary, `useLiveNodeOverrides` is Pascal's sanctioned path for it.

**The real constraint is the frame rate, not the conflict.** The Viewer runs
`frameloop="never"` and advances frames itself through `<FrameLimiter fps={50} />` — and that
50 is **hardcoded, not a prop**. So a timeline hosted in Pascal's viewer is capped at 50 fps
today. Fixing it means upstreaming an `fps` prop (small, plausibly welcome) or driving
`advance` ourselves. Worth deciding early; it is a product-visible ceiling.

### Integration costs found while getting there

Each of these cost real time and would cost it again:

- **Three must be 0.185 everywhere, `@types/three` included.** Already applied — see Q5.
- **`process.env.NODE_ENV` needs a shim outside Next.** Pascal's published bundles read it at
  module scope; without the shim in `index.html` the viewer throws before first render.
- **`@pascal-app/nodes` is bundler-only.** Its dist uses directory imports, which plain Node
  ESM rejects, so it cannot be probed headlessly outside Vite.
- **`Viewer` is a named export in the published beta**, not a default, unlike the repo source.
- **The published line is `1.0.0-beta.4`.** `@pascal-app/nodes` latest-stable is 0.1.1 while
  core/viewer are 0.9.2; only the beta line is coherent across all three.
- **The viewer owns its Canvas** but accepts `children` inside it, which is what lets a driver
  share its frame loop rather than race it from a separate animation callback.
- **Pascal's default scene is site/building/level only** — no geometry. Content has to be
  created. `item` needs a catalog asset; `column` is parametric and asset-free, so it is the
  cheap thing to drive in a test.

### Q3 — Who owns the camera? **Whoever is mounted. There is a cooperative path.** (2026-08-17)

`<ViewerCamera>` turned out to be twelve lines — a drei camera with `makeDefault` and a fixed
initial position. It writes nothing per frame, so the viewer does not contest the camera at all.
Pascal's camera *motion* lives in `@pascal-app/editor`, which mounts drei's `<CameraControls>`.
The probe therefore mounts the same component, so this is the real contest, not a proxy.

1230 frames per mode, measured the same way as Q2 — read what the camera holds, then write.
`?camera=solo|contested|cooperative`.

| Mode | Frames with drift | Worst drift | Radius actually held (authored 12.0) |
|---|---|---|---|
| **solo** — no controls, direct write | 1 of 1230 (the initial jump) | 11.0 | **12.000** |
| **contested** — controls mounted, direct write | **1229 of 1230** | 25.7 | **16.76** |
| **cooperative** — controls mounted, pose pushed via `setLookAt` | 1 of 1230 | 11.0 | **12.000** |

Read the last column, not the drift column. Under contention the camera does not merely
jitter — it sits at a completely different radius from the one the shot authored. Every frame
is a tug of war that the controller wins, because `camera-controls` re-derives the camera pose
from its own position/target state on every update. Writing the camera directly past a mounted
controller is not degraded, it is broken.

Handing the same resolved pose to the controller instead — `setLookAt(...)` then `update(0)` —
is **indistinguishable from owning the camera outright**. Same drift, same radius, to the digit.

**So the rule is one owner per frame:** with no controller mounted the time layer writes the
camera; with a controller mounted the controller writes it and the time layer feeds it. Both
paths are supported and neither needs anything from Pascal that does not already exist.

The one drifted frame in the clean modes is frame 1, where the camera moves from the viewer's
default `[10, 10, 10]` to the first resolved pose of the shot. That is the shot taking over, not
a conflict.

### Q4 — Can a hotspot be a Pascal plugin node kind? **Yes, end to end.** (2026-08-17)

Built as a real third-party plugin (`src/document/scene-plugin.ts`, `scene-kinds.ts`,
`src/render/hotspot-renderer.tsx`) — its own manifest, its own Zod schema extending `BaseNode`, its own
renderer — loaded through the documented `loadPlugin`, not a shortcut. Measured in the running
viewer:

| | |
|---|---|
| Registered as a kind | **yes** — 47 kinds, 46 built-in plus `huma:hotspot` |
| Rendered by Pascal's generic dispatch | **yes** |
| Present in `sceneRegistry.nodes` | **yes** — so the object binding applies unchanged |
| Driven by a path-creator transform track | **yes** |
| Click dispatches its action payload | **yes** — 5 clicks captured |

**The hierarchy objection was wrong.** There is no parent-kind validation anywhere in core;
`parentId` is optional and the hierarchy is convention, not schema. The hotspot parents straight
to the **site** — no building, no level — lands in the site's `children`, and both the site and
level renderers dispatch every child generically without filtering on kind. A world-anchored node
is not a special case.

**The `action` field is the boundary in one object.** Pascal round-trips it as opaque node data,
exactly as it round-trips a wall's thickness. Only the time layer reads it. Space and time stay in
separate documents while one object carries both halves.

#### Contract details that cost time, and would again

- **`def.renderer` must be a `RendererSource`**, i.e. `{ kind: 'parametric', module: () =>
  import('./x') }` with a **default export**. A plain component reference is dropped silently by
  `getRegistryRenderer` — the node registers, the scene stays empty, and nothing warns.
- **Namespaced kinds are gated per project.** `isNodeKindEnabled` refuses a plugin kind unless its
  plugin id is in the scene's `installedPlugins`. The mapping from kind to plugin id is recorded
  by `loadPlugin`, *not* by `registerNode` — so registering a definition directly bypasses the
  gate rather than satisfying it. Use `loadPlugin` plus `setInstalledPlugins`.
- **Registration must happen at module import time**, before any React tree renders. Doing it in
  an effect leaves the viewer resolving every node to null on first render; it warns, clearly.
- **`category` is one of five architectural buckets** (`site`, `structure`, `furnish`,
  `analysis`, `utility`). A hotspot is not really any of them; `analysis` is the closest fit.
  Cosmetic, but it is where the domain mismatch shows.
- **`exactOptionalPropertyTypes`** in this workspace rejects Pascal's published definition types.
  The shapes match exactly at runtime; one cast at the boundary, documented in place.

#### Not a finding, but worth knowing

Pascal's `<ViewerCamera>` sets a position and no target, so with no camera controls mounted it
looks down −Z and the scene sits out of frame. That is consistent with Q3: camera motion lives in
the editor package. The harness aims the camera itself, which R9 permits when nothing else owns it.

### Context gathered while scaffolding

Reading Pascal's source turned up three things that change the shape of the later questions:

- **Pascal already has the prefab primitive.** `SceneApi` exposes `getSubtree` and
  `cloneNodesInto` — clone a subtree with fresh ids and rewired parents. The thing this spike
  exists to avoid building, the other side already has.
- **There is a sanctioned transient-write path.** `useLiveNodeOverrides` plus `markDirty` is
  documented as the route for "transient animation frames … commit once at the end", and
  `SceneApi` exposes `pauseHistory` / `resumeHistory`. If direct `Object3D` writes lose Q2,
  this is the fallback — but it is a zustand store, so it costs a React notification per
  tick, which is the thing to measure rather than assume.
- **Click actions already exist per node kind.** `SceneActionCapability` gives a kind a
  `resolveTarget` / `activate` pair driven by the editor's generic pointer dispatch. That is
  the natural hook for Q4's hotspot, and it means the trigger half may not need inventing.
