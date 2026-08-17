<!--
Purpose: The execution plan for building the elastiq system — Pascal (space) + path-creator
(time) + elastiq (narrative) as one product. Written to be executed by agents who did NOT
take part in the design, so it carries the reasoning, the measurements and the traps, not
just the task list. Scope: four milestones across three repositories.
Read ELASTIQ-SYSTEM.md first for what is being built and why; this doc is how.
-->

# elastiq system — implementation plan v1

**Status:** plan. No phase is started.
**Design:** [`../technical/ELASTIQ-SYSTEM.md`](../technical/ELASTIQ-SYSTEM.md) (what and why)
and [`../technical/INTEGRATION-DESIGN.md`](../technical/INTEGRATION-DESIGN.md) (the ownership
rules and the measurements behind them).
**Proof:** `examples/pascal-spike/README.md` — the spike that answered whether any of this works,
with reproducible numbers.

---

## 0. Orientation — read this before touching anything

You are building **one system out of three parts**. If you take nothing else from this document,
take these six things.

**1. Three layers, two seams.** Pascal owns *space* (what exists, where). path-creator owns
*time* (when it moves). elastiq owns *narrative and delivery* (slides, graph, publishing). Space
meets time at a **node id**. Time meets narrative at a **cue** (a named timestamp). Nothing else
crosses.

**2. Time binds by id and never asks what a thing is.** That is the whole reason this works. A
transform track names an object id; it does not know whether that object is a wall, an imported
model, or a node kind someone writes next year. Never special-case a kind inside the time layer.

**3. The timeline is a pure function of `t`.** No wall-clock reads, no random selection, no
hidden state inside evaluation. Scrubbing correctness depends on it today; room consensus will
depend on it later, where a violation means viewers silently see different worlds. This is rule
R7 in the integration design and it is not negotiable.

**4. Write to objects, never to node data.** The time layer drives live `Object3D`s each frame.
It must not write into Pascal's store — measured, 2220 frames of driving moved Pascal's undo
depth and dirty-node count by exactly zero, and that property is what keeps playback out of the
undo history. See §9 for the one narrow exception.

**5. Restoration is mandatory.** When a drive ends, every object it touched goes back to the pose
it had before. Otherwise scrubbing silently rewrites the scene document and the author's world
drifts under them.

**6. Ids are a contract.** A node id is minted by the scene layer, stable across save, load and
export, and referenced by things that cannot repair it. Never derive an id from a name, an index
or a position. The single worst defect in elastiq's current 3D prototype is that it keys part
visibility by *mesh name* in a flat namespace shared across all models — two models with a mesh
called `Cover` collide, and array clones collide with themselves.

### The repositories

| Repo | Role | Notes |
|---|---|---|
| `pascalorg/editor` (Pascal) | the 3D editor | MIT, pre-1.0, commits daily. Fork for our plugin; upstream what is generally useful. |
| `Path-Creator` (`@huma/path-creator`) | the time layer | Ours. Timeline schema v10, rig schema v12. |
| `humatopia-frontend` (elastiq) | the product | Ours. Presentation system under `src/features/presentation/` and `src/routes/elastiq/`. |

---

## M0 — Foundations

Small, unglamorous, and everything else is cheaper if these land first.

### M0.1 — Align three to 0.185 everywhere

**Why.** Pascal peers `three@^0.185` and the install is refused below it. This is a hard gate,
not a warning.

**The trap that will cost you a day if you miss it.** Bumping the app is not enough. A library
emits its type declarations against *its own* `@types/three`, so a consumer on a different minor
gets `Matrix4 from @types/three@0.185.4 is not assignable to Matrix4 from @types/three@0.181.0`.
Three must be a singleton at the **type** level as well as at runtime. Bump `@types/three` in
every package that ships declarations.

**Tasks.** Path-Creator is already done (see commit history). Bump `humatopia-frontend`, which
currently resolves `three@0.170.0` **transitively and does not declare it at all** — declare it
explicitly while you are there, because a transitive bump can move it under you silently.

**Done when:** all three repos build and test green on 0.185, and `three` is a declared
dependency in each.

### M0.2 — A version field in elastiq's stored decks

**Why.** Stored presentations have **no version marker of any kind** today. Migration is
inference-based (`src/lib/migrate-slide-data.ts` sniffs for a legacy chart shape). Every later
phase changes this format. A version field costs nothing now and is expensive to retrofit.

**Tasks.** Add `format: "elastiq"` and `version: 1` to the saved payload in
`src/lib/react-flow-playground.server.ts`. Treat a missing version as `0` and run existing
inference. Nothing else changes yet.

**Done when:** decks save with a version, old decks load as version 0, round-trip is lossless.

### M0.3 — Close the security holes *(independent, but do not defer)*

**Why.** Not part of this system design, but elastiq's own codebase audit says
*"Blocks external launch: Yes."* The room milestone makes this urgent rather than theoretical.

**Tasks.** Presentation server functions in `src/lib/react-flow-playground.server.ts` have no
`getAuthContext()` call and no tenant filter on a single global store — any caller can enumerate,
download, overwrite or delete every deck. Separately, the upload API key is a literal string
committed to the repo and appears in docs; and `.claude/skills/upload-presentation/SKILL.md`
contains unresolved git merge-conflict markers that leak it.

**Done when:** presentations are owner-scoped and auth-checked, the key is rotated out of git
history and into env, and the skill file is repaired.

---

## M1 — Time, as a Pascal plugin

**The milestone goal:** an author opens Pascal, places objects, keyframes them, scrubs, and gets
deterministic playback. Every existing node kind becomes animatable, and so does every kind
anyone adds later.

**Deliverable:** a plugin package (working name `@huma/pascal-time`) providing node kinds,
tracks, and timeline authoring UI.

### Pascal plugin traps — read before writing a single kind

These are measured, and each one fails **silently**. All were hit during the spike.

1. **`def.renderer` must be a `RendererSource`**, i.e. `{ kind: 'parametric', module: () =>
   import('./x') }` where the module has a **default export**. A direct component reference is
   dropped by `getRegistryRenderer` with no warning — the kind registers, the scene stays empty,
   and nothing tells you why.
2. **Register through `loadPlugin`, not `registerNode`.** `loadPlugin` records the kind → plugin
   id mapping, which is what makes the per-project install gate (`isNodeKindEnabled`) apply.
   Registering a definition directly *bypasses* the gate rather than satisfying it. Then call
   `setInstalledPlugins([pluginId])` on the scene.
3. **Register at module import time**, before any React tree renders. Doing it in an effect
   leaves the viewer resolving every node to null on first render; it does warn about this.
4. **`useRegistry(node.id, kind, ref)` inside your renderer is the binding seam.** It is what
   puts the object into `sceneRegistry.nodes`, and therefore what makes a node drivable.
5. **`process.env.NODE_ENV` needs a shim outside Next** — Pascal's published bundles read it at
   module scope and throw before first render without it.
6. **Only the `1.0.0-beta.4` line is coherent** across `@pascal-app/core`, `/viewer` and
   `/nodes`. Latest-stable `nodes` is 0.1.1 against core 0.9.2.
7. **`@pascal-app/nodes` is bundler-only** — directory imports, unusable from plain Node ESM.
8. **Nodes may be roots.** `parentId` is optional and nothing validates parent kinds, so a kind
   with no architectural home does not need one.
9. If your workspace uses `exactOptionalPropertyTypes`, Pascal's published definition types will
   not satisfy it. Cast once at the boundary and comment why.

### M1.1 — Plugin skeleton

Manifest, one trivial node kind, registered and rendering. Proves the loop before anything
depends on it. Reference implementation: `examples/pascal-spike/src/document/scene-plugin.ts`.

**Done when:** the kind appears in Pascal's registry, places, renders, selects and deletes.

### M1.2 — The binding adapter and track driving

Wrap `sceneRegistry` as path-creator's `ObjectBindingResolver` (four lines — see
`examples/pascal-spike/src/render/scene-binding.ts`) and drive transform and visibility tracks
over Pascal nodes.

**Known and expected:** Pascal has no runtime `AnimationMixer` for its nodes, so
`resolveAnimation` returns null and every transform track over a Pascal node is absolute.
Additive mode has nothing to layer over. Skinned GLB clip playback stays path-creator's job on
objects it registers itself.

**Done when:** a keyframed track moves a Pascal-authored object, scrubs deterministically, and
restores the pre-drive pose on leave. Assert undo depth and dirty-node count are unchanged.

### M1.3 — Timeline authoring UI inside the editor

The lane editor, keyframes, curves. path-creator already ships `/timeline-ui` with a shared
curve engine and a keyframe curve editor; reuse rather than rebuild.

**Frame-rate note.** Pascal's viewer runs `frameloop="never"` and advances through
`<FrameLimiter fps={50} />` with 50 **hardcoded**. A `maxFps` prop is proposed upstream as
[pascalorg/editor#671](https://github.com/pascalorg/editor/pull/671). If it has not merged, either
carry the patch or drive `advance` yourself. Do not design around 60fps until it lands.

**Done when:** an author can keyframe from the timeline panel and see it play in the viewport.

### M1.4 — Camera and shot kinds

Virtual cameras as node kinds — path-creator already has the bodies (static, cart, orbit), blends,
and manual override.

**The camera rule, measured.** Exactly one owner per frame. With no controller mounted, the time
layer writes the camera directly. With Pascal's editor mounted — it uses drei's `CameraControls` —
you **must** hand the pose to the controller (`setLookAt(...)` then `update(0)`) rather than
writing past it. Writing directly with a controller mounted lost **1229 of 1230 frames** and
parked the camera at radius 16.76 against an authored 12.0. Going through the controller is
indistinguishable from owning the camera outright. `camera-controls` re-derives its pose from its
own state every update; there is no middle ground.

**Done when:** a shot is authorable in the editor, plays back through the timeline, and the
viewport camera does not fight it.

### M1.5 — Cues

Named timestamps as first-class data, plus the transport that rides the clock between them.

A working implementation with tests exists at `examples/pascal-spike/src/document/cues.ts` —
cue lookup at, before and after a time, and a ride that lands exactly on the cue, replaces a ride
in flight **from the current clock rather than the old origin**, and treats zero duration as an
immediate seek. Promote it into `@huma/path-creator/timeline`.

**Done when:** cues are authorable, navigable, and the ride is covered by tests at those edges.

### M1.6 — Persistence

The timeline lives in the scene document alongside the nodes. Schema-versioned, migrating.

**The unsolved problem, and it lands here.** Pascal's `cloneNodesInto` mints **fresh ids** — which
is exactly what a prefab needs and exactly what a timeline reference cannot survive. Duplicating an
animated object will break its tracks. Options not yet evaluated: remap ids on clone, per-instance
track binding, or relative addressing within a subtree. **Do not close this milestone without a
decision recorded in `INTEGRATION-DESIGN.md` §10.**

---

## M2 — Rendering

**The milestone goal:** a scene authored in Pascal looks like elastiq's current output. One
renderer, so author and audience see the same picture.

Do these in order — the first is mechanical and the rest are not.

### M2.1 — Post-processing chain *(mechanical)*

three 0.185 ships the whole suite as TSL nodes under `three/examples/jsm/tsl/display/`:
`BloomNode`, `GTAONode` (replaces N8AO), `DenoiseNode`, `SSGINode`, `SSRNode`,
`DepthOfFieldNode`, `FXAANode`, `SMAANode`, `OutlineNode`, `GodraysNode`, motion blur.

Elastiq's chain is Bloom + N8AO + ToneMapping (`3d-scene-editor.tsx` around line 4524). Each has a
direct equivalent. Pascal's existing pipeline (screen-space GI, denoise, inked edges, merged
outlines) stays — this is addition, not replacement, and both looks need to coexist because §M2.6
makes them authorable.

**Done when:** bloom, ambient occlusion and tone mapping are available in Pascal's viewer with
parity against elastiq's current output.

### M2.2 — Environment and lighting *(a re-authoring, not a port)*

**Be honest about this one.** Elastiq's visual identity is drei-shaped in load-bearing ways:
`Environment` + `Lightformer` *are* studio mode; HDRI ground projection is drei wrapping
three-stdlib. There is no drop-in equivalent under a WebGPU node renderer. Budget accordingly.

**Already solved, reuse them.** path-creator ships three WebGPU-safe replacements built for
exactly this class of problem: `RigLine` (fat lines), `RigLabel` (text — troika renders a garbage
quad on the node renderer), and `TransformGizmo` (a vendored PivotControls fork with the fat-line
material swapped out).

### M2.3 — Materials

`MeshReflectorMaterial` *is* glossy mode; `MeshTransmissionMaterial` is the glass and the wax.
Elastiq renders transmission/wax/molten/water as **proxy meshes outside the primitive with their
world matrix synced per frame** — a real pattern worth preserving, and a real cost worth knowing.

**Worth porting rather than reinventing** (all independent of the data model, all hard-won): the
stencil-buffer section plane with per-mesh cap fills, the explosion-direction algorithm with
ground clamping, auto-scaling everything off the scene diagonal, the splat bounding-box
extraction and reveal shader patch, the specular-glossiness glTF polyfill, the MaterialX import,
and the orthographic `gl.render` intercept.

### M2.4 — Shadows

`AccumulativeShadows`, `SoftShadows`, PCSS. Note elastiq needs a module-level singleton guard
because drei's `SoftShadows` patches `THREE.ShaderChunk` globally.

### M2.5 — Splats

A WebGPU splat implementation exists in another project — integrate rather than port drei's.

### M2.6 — The look becomes authorable

Lighting, environment and post move into the scene and onto the timeline. Then "polished" and
"technical" stop being modes and become positions in a look-space that can **transition as you
ride** — a slide can dissolve from a rendered view into an inked technical read.

**Done when:** a look change is keyframable and rides with the clock.

---

## M3 — First-class in elastiq

**The milestone goal:** an author builds a world, lays slides across it, and presents a continuous
journey — inside elastiq, not linked out to a separate tool.

### What you are replacing, and why

Elastiq's current 3D authoring is `src/routes/elastiq/3d-scene-editor.tsx`, 6,062 lines in one
component. Its rendering work is good and much of it is worth porting (see M2.3). **Its state
architecture is not salvageable and should not be extended**: roughly thirty `useState` hooks plus
fifteen Leva control blocks, with mutable Three.js `userData` as the real source of truth for
transforms; a React-side node tree that mirrors the scene graph and drifts from it (reparenting
moves the React node but not the Three object, and following is emulated by writing world
positions every frame, one level deep, translation only); and hand-maintained forty-entry
dependency arrays that are exactly how **materials ended up never being saved**.

Two live bugs to fix or drop on migration: mesh-attached annotations round-trip to world origin
because `attachTo` is written and restored but never read when rendering; and two of the three
save paths write `blob:` URLs straight into slides, dead on the next load.

### M3.1 — The document format

Implement §7 of the design: one versioned document with `worlds`, `deck` and `assets`.

Worlds are **normalised, not externalised** — slides reference a world by id and the worlds sit in
the same document, so one id still loads everything. Self-containment is preserved; that is a
requirement, not a preference, because the room hands every viewer one document.

**Migration.** An existing 3D slide becomes a **single-slide world** and behaves identically. The
migration is not all-or-nothing, and a deck may mix shared worlds and private ones.

**Assets** become content-addressed references. This kills the dead-`blob:`-URL class of bug and
lets two slides share one model instead of fetching it twice.

### M3.2 — Worlds and one canvas each

Today: one canvas per 3D slide, all eagerly mounted and warmed. Ten 3D slides means ten live
scenes. After: **one canvas per world, alive across the deck**, with HTML compositing over it.

Note the existing code documents "NEVER change the eager portal creation … Do not make it lazy."
That instruction exists to avoid a mount flash. A shared world removes the reason for it — entering
3D stops being a mount and becomes a reveal. Retire the instruction deliberately, with a comment
saying why, rather than silently violating it.

**Revives two dead fields.** `sceneGroup` and `focus` on `SlideNodeData` have been declared and
unread since the first commit. They become `worldId` and `cueId`.

### M3.3 — Riding on navigation

Following an edge rides the clock from this slide's cue to the target's. The graph decides where
you can go; the timeline decides what the journey looks like.

**Authoring convention to document for users:** lay the primary path out monotone in time, so the
main narrative plays as one continuous forward motion and branches jump. In a graph deck the
timeline is an address space, not a playback order.

### M3.4 — Embedded authoring

The Pascal-based editor inside elastiq, reading as one product. Note the current dependency runs
backwards — `src/features/presentation/*` imports `ModelViewerPage` from a **route file**. Do not
reproduce that.

### M3.5 — Steps as sub-cues

`buildStep` exists in the presentation store, is reset on navigation, is broadcast across windows,
and **nothing reads it**. A step is a cue at finer grain: advance-slide and advance-step become one
verb at two granularities. Fill the hook rather than replacing it.

### M3.6 — Unblock AI authoring

`.claude/skills/presentation-generator/system/node-schema.md` calls itself the authoritative
reference and documents the `type` enum that was **deleted in March**. It has no `modelViewerConfig`
field at all, so the agent pipeline cannot author a 3D slide. Update it to the new format or
AI-generated decks stay 2D forever.

---

## M4 — The room

**The milestone goal:** send a link, people join, and they *are there* — their own client, their
own view where permitted, not a 720p video of someone's window.

Most of this was specified in `humatopia-frontend/plans/2026-03-13-model-viewer-slide-and-remote-sync-v1.md`
and shelved. Read it — its transport reasoning is sound (BroadcastChannel same-device, WebSocket
remote, CRDTs rejected as overkill for a presenter-authoritative model). It stalled because there
was no clock to conduct and no stable identity to grant permissions against. M1 and M3 supply both.

### M4.1 — Clock sync

Replicate `t`, the cue, and ownership. **Nothing else.** Every client evaluates the same `t` against
the same document and derives identical state. Object state is computed, never transmitted.

Late-join is free: hand the newcomer the document and the current time. No replay.

### M4.2 — Ownership and permissions

`t` is presenter-owned. A viewer's camera may be locally owned when the slide permits. The ride
reclaims it on advance — "diverge and snap back", the same code path as any transition. Permissions
(orbit, inspect, explode, section) attach per slide.

### M4.3 — Live viewer route

Shareable URL, QR handoff, viewer role. Specified in the March plan; build it as written.

---

## Working agreements for every phase

- **Read `ELASTIQ-SYSTEM.md` and `INTEGRATION-DESIGN.md` before starting.** The rules there are
  numbered so they can be cited in review.
- **Keep the seams.** If a change requires the time layer to know about a specific node kind, or a
  slide to reference scene contents, stop and escalate — that is the architecture eroding.
- **Prove it with a measurement, not an assertion.** The spike's pattern: instrument the thing,
  drive it headlessly in real Chrome, report a number. `examples/pascal-spike` has the harness.
- **Upstream what is general.** Pascal is MIT and moves fast. A patch we carry is a cost forever;
  a merged PR is not.
- **Record reversals.** If evidence overturns a rule, change the rule *and* write down what
  overturned it. Do not edit a rule silently.

## Open decisions, owned by the product owner

1. **Clone versus timeline references** (M1.6) — the hardest unsolved problem on the boundary.
2. **Deck schema** (M3.1) — keep React Flow's node/edge shape verbatim, or give the deck its own
   schema with React Flow as a view over it.
3. **Fork policy for Pascal** — how much divergence is acceptable before upstreaming becomes
   mandatory.
