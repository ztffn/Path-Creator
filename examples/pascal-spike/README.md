<!--
Purpose: Charter and findings log for the Pascal spike — testing whether the Pascal
editor can own the scene ("what exists, where") while @huma/path-creator owns time
("when, and what happens"), instead of this library growing its own scene editor.
Scope: examples/pascal-spike only. Throwaway on purpose; the adapter is the one part
with a promotion path. Update the Findings section as each question is answered.
-->

# Pascal spike — can someone else own the scene graph?

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

So the adapter is nearly trivial (`src/pascal-binding.ts`). The spike is not about whether
that adapter compiles — it is about whether the two systems can write to the same objects
without fighting.

## Questions, in the order they should be answered

Each is falsifiable. Record the answer in **Findings** below, including the ones that fail.

- **Q1 — Does the binding hold?** Can `TransformTrackDirector` and
  `ActivationTrackDirector` drive objects registered in `sceneRegistry`, including
  restoring the pre-drive pose on leave? *Headless, cheap, decisive.*
  Run: `pnpm --filter pascal-spike test`.

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
  action" is an assumption, not a fact. Pascal's `SceneActionCapability` (per-kind
  `resolveTarget` / `activate` on click) looks like the right hook.

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

## Findings

### Q1 — Does the binding hold? **Yes.** (2026-08-17)

The adapter is four lines (`src/pascal-binding.ts`). Against a registry with Pascal's exact
contract, `TransformTrackDirector` and `ActivationTrackDirector` both drive objects by node
id, and both hand the pose back untouched when the timeline is left — which matters, because
otherwise scrubbing would silently rewrite the scene editor's idea of where things sit. A
node deleted out from under a live track does not throw, which it must not: the scene editor
owns the lifecycle, so nodes can vanish under tracks that still reference them.

Four tests, `pnpm --filter pascal-spike test`. Note this proves the *contract*, not
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

### Q2, Q3, Q4 — not yet run

`src/App.tsx` is the Q2 harness and runs today against the stand-in registry as a control,
reporting per-frame drift between what the timeline wrote and what the object holds on the
next frame. Against the stand-in that number must be zero; against Pascal, a non-zero worst
drift is the two systems fighting. Swapping `useRegistry` for Pascal's exported
`sceneRegistry` is the intended one-line change.

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
