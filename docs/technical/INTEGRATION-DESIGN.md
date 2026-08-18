<!--
Purpose: The authoritative boundary contract between the scene editor (Pascal), the time
layer (@huma/path-creator), and the products built on both (elastiq/humatopia today, a
mission editor later). Says who owns what, what each side may never do, and how a new
feature is assigned to a side. Read before adding any feature that has a position, a
lifetime, or a clock. Scope: cross-repo architecture; supersedes ad-hoc assumptions.
-->

# Integration design — space, time, and the boundary between them

> **Read [`ELASTIQ-SYSTEM.md`](./ELASTIQ-SYSTEM.md) first.** It defines the system these rules
> serve — Pascal as the editor, path-creator as time, elastiq as the product — and the build
> sequence. This document holds the detailed ownership rules and the measurements behind them.

## Status

| Section | Standing |
|---|---|
| The model, the ownership rules, the classification test | **Decided.** Change via §12. |
| Object binding, frame loop, persistence seams | **Proven** by the Pascal spike (§7). |
| Camera ownership | **Proven, and implemented** — one owner per frame; re-measured against the shipped director. §5.4, R9. |
| Hotspots as plugin node kinds | **Proven** end to end by the spike. §5.5. |
| Clone identity versus track references | **Decided and implemented** — remap on clone. §10 decision 1, R8, M1.6. |
| Time as a Pascal plugin | **Built and measured** — M1.1, M1.2. `Packages/pascal-time`. |
| Mission editor boundary | **Speculative.** No code exists. §8.2. |

Last revised 2026-08-17, after M1.1 and M1.2 built the time plugin against Pascal's real
registry and viewer (`Packages/pascal-time`, `examples/pascal-time-harness`). The spike that
preceded them, and answered the original five questions, is `examples/elastiq/README.md`.

---

## 1. Why this document exists

`@huma/path-creator` started as a spline and dolly library. It has since grown an id-to-object
registry, per-object tracks, a hierarchy panel, selection, inspectors, a transform gizmo,
document serialization with migrations, undo, nested scenes, and a trigger/action layer. None
of that was designed as an entity system. It became one by accretion.

It is still **not** a prefab system — no templates, no instancing, no entity parenting — but it
is one feature away from becoming a scene editor, and that feature was next on the roadmap.
**Interactive hotspots** are world-anchored: a hotspot has a position of its own and no
counterpart object in the host application. Building it inside this library would have made the
library own scene content rather than reference it, silently, in a change that looked routine.

This document exists so that decision is never made by accident again. The rule it encodes is
older than Pascal — the roadmap already said model loading and component lifecycle are
host-owned — but it was a convention, not a contract, and conventions lose to convenience.

---

## 2. The model

Three layers. Each owns one question.

| Layer | Owns the question | Implementation |
|---|---|---|
| **Scene** | *What exists, where, parented how, made of what* | Pascal (`@pascal-app/core`, `/viewer`, `/nodes`) |
| **Time** | *When it moves, appears, sounds, cuts, or fires* | `@huma/path-creator` |
| **Product** | *What the audience is here for* | elastiq/humatopia today; a mission editor later |

The layers meet at exactly one place: **a stable node id**. The scene layer publishes ids and
the live objects behind them; the time layer references those ids and drives the objects. No
other coupling is permitted.

```
   Pascal scene document                    RigDocument (schema v12 / timeline v10)
   ─────────────────────                    ────────────────────────────────────────
   nodes: { id -> node }                    tracks: [{ objectId: <node id>, keys… }]
   parentId hierarchy                       scenes, triggers, actions, cameras
          │                                                │
          └──────────► node id ◄───────────────────────────┘
                          │
                 sceneRegistry.nodes
                  (id -> Object3D)
                          │
                 ObjectBindingResolver
```

Neither document embeds the other. They are versioned, migrated, and released independently.

---

## 3. The ownership rules

Numbered so they can be cited in review. Each carries its reason; a rule without a reason gets
discarded the first time it is inconvenient.

**R1 — Two documents, never nested.** The scene graph is Pascal's file. The timeline is ours.
They reference each other by node id and nothing else.
*Why:* they have different release cadences and different migration histories. Embedding one in
the other couples every schema bump on either side.

**R2 — The time layer never changes scene structure.** No creating, deleting, reparenting, or
renaming nodes. It reads the registry and drives objects.
*Why:* undo. Pascal owns the structural undo stack. A second writer makes "what does Ctrl+Z do
now" unanswerable.

**R3 — The time layer writes to `Object3D`, never to node data.** Per-frame output goes to the
live three object. Node data is Pascal's.
*Why:* measured — 2220 frames of driving moved Pascal's undo depth by zero and its dirty-node
count by zero. Writing node data instead would make every frame of playback an undo entry.

**R4 — A node under timeline control is not edited in the scene store during playback.**
*Why:* measured — editing the driven node forces a React commit that reapplies `position` from
node data, snapping the object back (1.98 m in the test) for one frame. Editing any other node
is harmless. If editing during playback becomes a requirement, use Pascal's
`useLiveNodeOverrides`, which exists for exactly this.

**R5 — Restoration is mandatory.** Leaving the timeline hands every driven object back in the
pose it had before the drive.
*Why:* otherwise scrubbing a timeline silently rewrites where things are, and the scene
document diverges from what the author placed. This is already how the track directors behave
and it is covered by tests.

**R6 — Anything with an authored position is a scene node.** If a person places it, drags it, or
expects to find it in a hierarchy, it belongs to Pascal — even if only a timeline uses it.
*Why:* this is the rule the whole document exists for. Hotspots, trigger zones, spawn points,
markers with a location: all scene nodes.

**R7 — Anything that is a pure function of `t` is ours.** Evaluators stay pure and scrub-safe.
No stateful selection, no wall-clock reads inside evaluation.
*Why:* determinism under scrubbing is the property the entire timeline design rests on.

**R8 — Node ids are a contract, not an implementation detail.** They must be stable across save,
load, and export. A change that re-mints ids breaks every timeline referencing them.
*Why:* the timeline holds ids it did not create and cannot repair. Pascal's `cloneNodesInto`
mints *fresh* ids by design — exactly what a prefab needs and exactly what a timeline reference
cannot survive. **Resolved 2026-08-17: remap tracks on clone.** See §10, decision 1.

**R9 — The camera has exactly one owner per frame.** With no camera controller mounted, the time
layer writes the camera. With a controller mounted, the controller writes it and the time layer
feeds it a pose. Never both.
*Why:* measured — writing the camera past a mounted `camera-controls` loses 1229 frames of 1230
and settles the camera on a different shot entirely (radius 16.76 against an authored 12.0).
Feeding the same pose through the controller is indistinguishable from owning the camera. §5.4.

---

## 4. The classification test

For any new feature, ask in order. The first "yes" assigns the owner.

1. **Does a human place it in space?** → scene node (Pascal).
2. **Does it still exist when no timeline is playing?** → scene node.
3. **Is it a template instantiated more than once?** → scene node. Pascal already has the
   primitive (`getSubtree` + `cloneNodesInto`); do not build a second one.
4. **Is its value a function of `t`?** → timeline track (path-creator).
5. **Does it only change what is on screen during playback?** → timeline track.
6. **Is it input → effect?** → *split*. Pascal owns the node and the hit test; path-creator owns
   the action and anything it does to time.

### Worked example — the hotspot

A hotspot is placed by a person (1: yes). It exists in the scene with no timeline loaded
(2: yes). It will be templated across scenes (3: yes). **It is a Pascal node.** Its *action* —
seek the timeline, enter a scene, start an inspection — is a function of time and is
**ours** (6: split). The authoring UI for placing it is Pascal's; the authoring UI for choosing
what it does is ours.

This is the answer the roadmap could not give, and it costs this library nothing it had.

---

## 5. Seam contracts

### 5.1 The node id — the only shared vocabulary

A string, minted by Pascal, stable for the life of the node. The time layer stores it in
`TransformTrack.objectId`, `ActivationTrack.objectId`, and trigger bindings. It must never be
derived from position, index, or display name.

### 5.2 Object binding — **proven**

Pascal exports a module-level `sceneRegistry` whose `nodes` is a `Map<string, Object3D>`,
documented in its source as *"Master lookup: ID -> Object3D"*. This library consumes exactly
that shape:

```ts
export interface ObjectBindingResolver {
  resolve(id: string): Object3D | null;
  resolveAnimation(id: string): ObjectAnimationBinding | null;
}
```

The adapter is four lines (`examples/elastiq/src/render/scene-binding.ts`). `resolveAnimation`
returns null against Pascal: Pascal has no runtime `AnimationMixer` for its nodes, so every
transform track over a Pascal node is absolute. **Consequence:** additive transform tracks —
which exist to layer corrections over mixer output — have nothing to layer over on a Pascal
node. Skinned GLB clip playback stays this library's job, on objects it registers itself.

> **The viewer is one shell of two, not a requirement.** A host can mount Pascal's `<Viewer>`
> for a technical read (WebGPU, SSGI, inked edges, outlines) and its own canvas for a polished
> one (HDRI, shadows, bloom, depth of field) — over the SAME document, with the same node kinds
> and the same timeline, because the kinds ship their own renderers and the look lives in the
> shell. Demonstrated both ways in `examples/elastiq` (`?mode=reading`). The cost is one
> discipline: a node renderer must stay renderer-agnostic, or it breaks under the WebGPU shell.
>
> **The viewer is also optional entirely.** §5.3 and §5.4 describe
> what happens when a host mounts Pascal's `<Viewer>`. It does not have to. `@pascal-app/core`
> carries the registry, schemas, store, undo, hierarchy and the id-to-object map with no WebGPU
> and no viewer dependency, so a host can render the document itself — about twenty lines of
> dispatch — and keep its own renderer, frame loop, camera and look. For a presentation product
> that is the right trade: Pascal's renderer is tuned for architectural legibility (SSGI, inked
> edges, outlines) and has no bloom, depth of field, HDRI environment or transmission. Taking
> core alone also retires the frame cap and the camera contest below. Demonstrated in
> `examples/elastiq`.

### 5.3 The frame loop — **proven, and constrained** (only when Pascal's viewer is mounted)

Pascal's viewer owns the canvas, runs `frameloop="never"`, and advances frames itself. A driver
must mount **inside** the viewer (it accepts `children`) and use `useFrame`, so it shares that
loop rather than racing it from a separate animation callback.

**The cap:** the viewer renders `<FrameLimiter fps={50} />` with 50 hardcoded, not exposed as a
prop, so a timeline hosted in Pascal's viewer is capped at 50 fps. Upstreamed as a `maxFps` prop
in [pascalorg/editor#671](https://github.com/pascalorg/editor/pull/671) (defaults to 50, so it
changes nothing until asked). Until that merges, treat 50 as the ceiling and do not design
around 60; if it is rejected, the fallback is driving `advance` ourselves.

### 5.4 The camera — **proven** (contest applies only when a controller is mounted)

The viewer does *not* contest the camera: `<ViewerCamera>` is a drei camera with `makeDefault`
and a fixed initial position, and writes nothing per frame. Camera **motion** lives in
`@pascal-app/editor`, which mounts drei's `<CameraControls>`.

That gives two supported configurations, and they are not interchangeable:

- **No controller mounted** — a published presentation, a viewer-only surface. The time layer
  owns the camera and writes the resolved snapshot directly.
- **A controller mounted** — authoring inside Pascal's editor. The controller owns the camera.
  The time layer hands it the resolved pose (`setLookAt(...)` then `update(0)`) instead of
  writing past it.

Measured over 1230 frames per configuration: writing directly with a controller mounted loses
1229 frames out of 1230 and parks the camera at radius 16.76 against an authored 12.0 — not
jitter, a different shot. Going through the controller is indistinguishable from owning the
camera outright: same drift, same radius, to the digit. `camera-controls` re-derives the pose
from its own position/target state every update, which is why there is no middle ground.

**Re-measured 2026-08-17 against the shipped implementation** (`PascalCameraDirector`, M1.4),
with drei's real `CameraControls` mounted inside Pascal's viewer on WebGPU: **0 of 451 frames**
failed to hold the pose the shot resolved to, worst positional error 0 m, and an orbit shot held
its authored radius of 5.0 against the node it frames. The rule holds in code, not only in
principle. The director sets the lens on both paths, because a camera controller has no opinion
about field of view.

### 5.5 Input and triggers — **proven**

Built and measured: a hotspot ships as a third-party plugin node kind with its own manifest,
schema and renderer, registers through `loadPlugin`, renders through Pascal's generic dispatch,
lands in `sceneRegistry` (so the object binding of §5.2 applies unchanged), is driven by a
transform track, and dispatches its action payload on click.

**The action payload is the boundary in one object.** Pascal stores it as opaque node data, the
same way it stores a wall's thickness, and never interprets it. Only the time layer reads it. That
is what lets space and time live in separate documents while a single authored object carries both
halves.

Four contract details, each of which fails silently if missed:

- `def.renderer` must be `{ kind: 'parametric', module: () => import('./x') }` with a **default
  export**. A direct component reference is dropped without a warning.
- Namespaced kinds are gated per project by `installedPlugins`. The kind-to-plugin mapping is
  recorded by `loadPlugin`, not `registerNode` — registering directly bypasses the gate instead of
  satisfying it.
- Registration must run at module import time, before any React tree renders.
- `category` is one of five architectural buckets; a hotspot fits none of them well. Cosmetic.

**The hierarchy objection was wrong.** Core has no parent-kind validation, `parentId` is optional,
and both the site and level renderers dispatch every child generically. A world-anchored hotspot
parents straight to the site — no building, no level — and renders. R6 costs nothing structurally.

### 5.6 Persistence

Each side saves its own document. The product layer (§8) is responsible for storing the pair and
for keeping them consistent — including detecting a timeline that references a node id the scene
no longer has. The time layer already tolerates a missing id at runtime (it skips, it does not
throw); it does **not** repair the reference.

---

## 6. What each side must not do

| Side | Must not | Failure it causes |
|---|---|---|
| Time layer | Create, delete, or reparent scene nodes | Two undo stacks, ambiguous Ctrl+Z |
| Time layer | Write to Pascal's node data during playback | Every frame becomes an undo entry |
| Time layer | Own anything with an authored position | Becomes a second scene editor (the whole point) |
| Time layer | Read wall-clock time inside an evaluator | Breaks scrub determinism |
| Time layer | Write the camera while a controller is mounted | Camera settles on a different shot (R9) |
| Scene layer | Re-mint node ids on save, load, or migration | Silently breaks every timeline reference |
| Scene layer | Edit a driven node mid-playback | One-frame snap-back to authored pose |
| Product layer | Reach into either document's internals | Couples the product to two schemas it does not own |
| Product layer | Duplicate scene description in its own config | This is exactly what `ModelViewerSceneConfig` does today (§8.1) |

---

## 7. Evidence

From `examples/elastiq`, measured in system Chrome on WebGPU against Pascal's real viewer,
probe mounted inside the viewer's frame loop.

| Measurement | Result |
|---|---|
| Frames sampled | 2220 (~45 s) |
| Sustained rate | 49.7 fps (Pascal's hardcoded 50 cap) |
| Frames where a timeline write was overwritten | 1 — frame 1, the mount |
| Worst drift, clean path | 0.02 m, self-healed the next frame |
| Mid-playback edits to *other* nodes | 0 drift |
| Editing the *driven* node mid-playback | 1 frame, 1.98 m, recovered next frame |
| Camera, no controller, direct write (1230 frames) | 1 drifted frame; radius 12.000 as authored |
| Camera, controller mounted, direct write | 1229 drifted frames; radius 16.76 vs authored 12.0 |
| Camera, controller mounted, pose via `setLookAt` | 1 drifted frame; radius 12.000 as authored |
| Hotspot as a third-party plugin kind | registers, renders, binds, is track-driven, dispatches clicks |
| Pascal undo depth grown by driving | 0 |
| Pascal dirty-node count while driving | 0 |
| Track directors over a Pascal-shaped registry | 4 tests green, including restore-on-leave |

Reproduce: `pnpm --filter elastiq dev`, read the panel or `window.__spike`. Append
`?pokeDriven` for the R4 failure case.

---

## 8. Product boundaries

### 8.1 elastiq / humatopia — the intended end state

Today `ModelViewerSceneConfig` is a flat list of model URLs with optional positions, a large
environment block, and a camera. It has no node ids, no hierarchy, and no per-object behaviour;
the Calora building scene instantiates its repeated units with a `for` loop in TypeScript,
capped at 24. That config is a scene description doing a scene editor's job.

The target: **Pascal replaces it as the scene editor**, this library supplies time, and elastiq
becomes the product layer that composes both and owns presentation concerns (slides, narrative,
navigation, publishing). Migration is not designed yet and is out of scope here; the boundary
above is what it must migrate *to*.

### 8.2 Mission editor (Delta Force / r3f-webgpu-starter) — speculative

Same stack (React 19, three `WebGPURenderer`, R3F v9, drei v10), so the layering transfers on
paper: Pascal places the mission's objects, this library sequences objectives and camera work,
the game is the product layer. Nothing has been built or measured. The open question is whether
a game's runtime needs — spawning, authority, netcode — sit inside the scene layer or beside it,
and that is not answered by anything here. Treat §8.2 as intent, not design.

---

## 9. Known constraints and costs

Each measured while integrating; each will be paid again by the next person.

- **Three must be 0.185 everywhere, `@types/three` included.** This library emits declarations
  against its own three types; a consumer on a different minor gets errors like *"Matrix4 from
  0.185 is not assignable to Matrix4 from 0.181"*. Three is a singleton at the type level too.
- **`process.env.NODE_ENV` needs a shim outside Next.** Pascal's published bundles read it at
  module scope and throw before first render without it.
- **`@pascal-app/core` is bundler-only too, not just `/nodes`.** Its `dist/index.js` uses
  directory imports (`./events/bus`), which plain Node ESM rejects. Under Vitest this is one
  line — `server: { deps: { inline: [/@pascal-app\//] } }` — and it is worth knowing because it
  turns Pascal's real store and real registry into things a headless test can drive, which is
  strictly better evidence than a stand-in. Measured while building `Packages/pascal-time`.
- **`@pascal-app/nodes` statically reaches `@pascal-app/editor`, which peers `next`.** Taking
  Pascal's 46 built-in kinds means taking the editor package and Next 16 with them. Measured:
  `import('@pascal-app/nodes')` executes `@pascal-app/editor/src/components/tools/select/
  box-select-tool.tsx` before it yields a single export, 190 of the 616 files in its dist
  import the editor, and adding it to a workspace package pulled in 109 further packages
  including `next@16.3.1`. It is not tree-shakeable: `column/definition.js` statically imports
  `./floorplan`, `./floorplan-affordances` and `./floorplan-move`, and all three import the
  editor. **This contradicts the implementation plan's "a published presentation mounts core +
  nodes + viewer + the timeline runtime only — no editor package"** — see §11.
- **Node schemas live in core, definitions live in `/nodes`.** `@pascal-app/core` exports
  `ColumnNode`, `WallNode` and every other built-in schema, so a genuine Pascal node can be
  authored into the document without `/nodes` at all. Only its renderer, tool and panel need
  the heavier package. This is what lets a test drive a real `column` while staying clear of
  the editor dependency above.
- **A third-party kind's node id does not type-check against the store.** `AnyNodeId` is a
  template-literal union of `` `${builtinKind}_${string}` `` over Pascal's own kinds, so every
  `createNode` / `deleteNode` / `nodes[id]` call from a plugin is a type error. Runtime is
  unaffected — `BaseNode.id` is a plain `z.string()`, with a comment in Pascal's schema file
  explaining that a narrower type breaks `.extend()` downstream. Cast once at the boundary;
  `Packages/pascal-time/src/plugin/scene-ops.ts` is where ours lives. **Worth upstreaming** —
  widening the store's id parameter to `string` would remove the shim for every plugin author.
- **Dirty marking is deferred to `requestAnimationFrame`.** `updateNodesAction` batches marks
  into one frame callback, so headlessly nothing is ever marked and a test asserting "driving
  left the dirty set alone" passes while measuring nothing. Shim rAF and keep a control that
  fails when the counters stop moving.
- **`Viewer` and `useViewer` are named exports in the published beta**, defaults in the repo
  source.
- **Pascal supplies no per-kind schema migration.** `NodeDefinition.schemaVersion` is validated
  as a positive integer when a kind registers and is never read again; there is no migration
  hook anywhere in the definition contract. Pascal's own migrations are two hand-written
  functions (`healSceneNodes`, `removeRetiredDrawingSheetNodes`), neither version-driven. A
  plugin that changes its stored shape writes and runs its own migrator. Do not plan on
  inheriting one.
- **The undo snapshot holds the nodes map by reference, not as a deep copy.** Safe while every
  write replaces the map immutably, which the store does — but it means mutating node data *in
  place* silently corrupts the past state, and undo will not restore it. Measured. Anything
  editing an array or object inside node data must produce a new one.
- **The inspector is not derived from the Zod schema.** It comes from `def.parametrics`, a
  hand-declared `groups` descriptor. A kind with a schema and no descriptor has no inspector.
- **Only the `1.0.0-beta.4` line is coherent** across core, viewer, and nodes.
- **Pascal's default scene carries no geometry.** `item` needs a catalog asset; `column` is
  parametric and asset-free, which makes it the cheap thing to drive in a test.
- **Pascal is pre-1.0 and moves daily.** Churn on this boundary is a running cost, not a
  one-time one.

---

## 10. Open decisions

1. ~~**Prefab instancing versus timeline references (R8).**~~ **DECIDED 2026-08-17 — remap on
   clone.** `cloneNodesInto` mints fresh ids, which is correct for a prefab and fatal for a
   timeline referencing the originals. When a subtree is duplicated, the tracks referencing
   nodes inside it are duplicated too and their `objectId`s rewritten to the new ids, so the
   copy animates like the original. It lives entirely in our plugin — no upstream change, no
   new document concept.

   *Accepted limitation:* N copies means N track sets, so re-animating a duplicated object
   means editing it N times. That bites only at authoring scale, and the upgrade when it does
   is **binding indirection** — tracks name a slot, instances map slots to ids, one track set
   drives N instances. Remapping does not foreclose it. **Implemented in M1.6**
   (`remapTracksAfterClone`), verified by driving an original and its duplicate together.

   *Ruled out, do not revisit without new evidence:* relative addressing within the subtree
   (`root/child/grandchild`). It resolves clones without remapping, but it breaks on rename and
   on reparent — which is to say it reintroduces exactly the failure R8 exists to prevent, in a
   form that looks like a feature. Full reasoning in the implementation plan's §M1.6.
2. **Frame-rate ceiling.** `maxFps` prop proposed upstream as
   [pascalorg/editor#671](https://github.com/pascalorg/editor/pull/671). Until it merges, 50 fps
   is the design constraint. Fallback if declined: drive R3F's `advance` ourselves.
3. **Where the product layer lives.** elastiq composing two libraries, versus a thin shared
   host package both products consume. Not urgent until the second product is real.

---

## 11. Recorded reversal — the runtime stack cannot exclude the editor package

**Overturned:** implementation plan §0 principle 7, *"A published presentation mounts core +
nodes + viewer + the timeline runtime only — no editor package, no gizmos, no placement tools,
no inspector."*

**What overturned it,** measured 2026-08-17 while building `Packages/pascal-time`:

| Evidence | Result |
|---|---|
| `import('@pascal-app/nodes')` under Vitest | executes `@pascal-app/editor` source before returning any export |
| Files in `@pascal-app/nodes/dist` importing `@pascal-app/editor` | 190 of 616 |
| Static path from the package entry | `index.js` → `column/definition.js` → `column/floorplan.js` → `@pascal-app/editor` |
| Packages added by declaring `@pascal-app/nodes` as a dependency | 109, including `next@16.3.1` |

`@pascal-app/editor` also ships raw TypeScript source rather than a build — 438 `.tsx` files,
`next >= 15` as a peer and imported in 26 of them — so a consumer's bundler compiles it, with
the automatic JSX runtime, or the import fails.

**Why it is like this, and why lazy-loading cannot help.** A Pascal node definition bundles a
kind's authoring affordances with its runtime shape — placement tool, floorplan move target,
inspector parametrics and renderer all hang off one definition object. Importing the kind
therefore imports the editor. That is coherent for Pascal and hostile to a runtime-only
consumer, and because the references are static there is nothing to defer.

### The viewer is clean — measured 2026-08-17

The question that decides whether the runtime has a path at all: does `@pascal-app/viewer`
reach the editor too? **It does not.**

| Measurement | Result |
|---|---|
| Files in `@pascal-app/viewer/dist` importing `@pascal-app/editor` | **0** of 92 |
| Files importing `@pascal-app/nodes` | **0** — the five textual hits are comments and one warning string |
| Files importing `next` | **0** |
| Viewer's complete external import surface | `@pascal-app/core`, `@react-three/drei`, `@react-three/fiber`, `react`, `three`, `three-bvh-csg`, `three-mesh-bvh`, `zustand` |

End to end rather than by inspection: `examples/pascal-time-harness` declares only
`@pascal-app/core` and `@pascal-app/viewer`, resolves neither `@pascal-app/nodes` nor
`@pascal-app/editor` — and `next` appears nowhere in the lockfile — yet it builds and runs
Pascal's real `<Viewer>` on WebGPU for 560 frames.

**So `/nodes` is the only offender.** The runtime keeps Pascal's renderer; what it cannot keep
is Pascal's parametric *kinds*. That confines the problem to the scene vocabulary and, crucially,
keeps M2 out of it: the "one renderer" premise survives, and the two-renderer fallback is not
forced by this finding.

*Packaging wart, noted in passing:* the viewer ships 15 `.test.js` files in its dist that import
`bun:test`. None is reachable from `index.js`, so they are dead weight rather than a load path.

**What stands.** The *intent* behind the principle is sound and unchanged: the timeline runtime
must not import `@pascal-app/editor`, and `@huma/pascal-time` does not. Its authoring surface
(the M1.3 panel) goes behind a separate `./editor` entry for exactly this reason.

**What changes.** The claim that a published presentation carrying Pascal's built-in kinds pays
no editor cost is false at `1.0.0-beta.4`. Three options, none yet chosen:

1. **Don't ship Pascal's built-in kinds in the runtime.** Products whose scene vocabulary is
   their own — which is what the elastiq prototype already does, and what the pascal-time
   harness does — never import `/nodes` and pay nothing. Cheapest, and it costs the 46
   architectural kinds.
2. **Upstream the split.** Move the authoring-only files (`tool`, `panel`, `floorplan*`,
   `move-tool`, `preview`) behind lazy boundaries or a separate entry so `/nodes` can be
   imported for schemas and renderers alone. This is a Pascal-side change and the plan's own
   working agreement says to upstream what is general rather than carry a patch.
3. **Accept the bundle.** Measure it before choosing it; nobody has.

Nothing in M1.1 or M1.2 depends on the answer — neither takes `/nodes`. **M1.3 onward does**,
because a published presentation of a Pascal-authored building needs walls to render.

## 12. Changing this document

The rules in §3 and the test in §4 are the stable part. Change them by recording, here, what new
evidence overturned the reason attached to the rule — not by editing the rule silently. Sections
marked open or proposed are expected to move as the remaining spike questions land; update the
Status table when they do.
