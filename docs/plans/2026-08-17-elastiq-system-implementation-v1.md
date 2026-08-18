<!--
Purpose: The execution plan for building the elastiq system — Pascal (space) + path-creator
(time) + elastiq (narrative) as one product. Written to be executed by agents who did NOT
take part in the design, so it carries the reasoning, the measurements and the traps, not
just the task list. Scope: four milestones across three repositories.
Read ELASTIQ-SYSTEM.md first for what is being built and why; this doc is how.
-->

# elastiq system — implementation plan v1

**Status:** in progress. M0.4, M1.1, M1.2, M1.4, M1.5 and M1.6 are done. **M1.3 is the only
phase left in M1**; everything after is plan.
**Design:** [`../technical/ELASTIQ-SYSTEM.md`](../technical/ELASTIQ-SYSTEM.md) (what and why)
and [`../technical/INTEGRATION-DESIGN.md`](../technical/INTEGRATION-DESIGN.md) (the ownership
rules and the measurements behind them).
**Proof:** `examples/elastiq/README.md` — the spike that answered whether any of this works,
with reproducible numbers.

---

## 0. Orientation — read this before touching anything

You are building **one system out of three parts**. If you take nothing else from this document,
take these seven things.

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
undo history. The one narrow exception — a node edited *while it is being driven* snaps back for
a frame — is rule R4 in `INTEGRATION-DESIGN.md`, with `useLiveNodeOverrides` as the sanctioned
route if editing during playback ever becomes a requirement.

**5. Restoration is mandatory.** When a drive ends, every object it touched goes back to the pose
it had before. Otherwise scrubbing silently rewrites the scene document and the author's world
drifts under them.

**6. Ids are a contract.** A node id is minted by the scene layer, stable across save, load and
export, and referenced by things that cannot repair it. Never derive an id from a name, an index
or a position. The single worst defect in elastiq's current 3D prototype is that it keys part
visibility by *mesh name* in a flat namespace shared across all models — two models with a mesh
called `Cover` collide, and array clones collide with themselves.

**7. Authoring and runtime are different stacks.** The editor is a tool; the presentation is the
product. Authoring mounts `@pascal-app/core` + `/nodes` + `/viewer` + `/editor` plus our timeline
plugin and its panel. **Nothing we write in the runtime path may import from `/editor`** —
`@huma/pascal-time` keeps its authoring surface behind a separate entry for this reason. Every
phase below must state which stack it touches.

> **Corrected 2026-08-17, M1.2.** This principle originally claimed a published presentation
> mounts "core + nodes + viewer + the timeline runtime only — no editor package". That is false
> at `1.0.0-beta.4`: `@pascal-app/nodes` reaches `@pascal-app/editor` through a static import
> chain, and the editor peers `next`. Measured — `import('@pascal-app/nodes')` executes editor
> source before yielding an export, 190 of its 616 dist files import the editor, and declaring
> it as a dependency pulled in 109 packages including `next@16.3.1`. The rule about *our* code
> stands; the claim about bundle size does not. Options and their costs are recorded in
> `INTEGRATION-DESIGN.md` §11. **Nothing in M1 before M1.3 is affected** — neither M1.1 nor
> M1.2 takes `/nodes`, and Pascal's built-in node *schemas* are exported by `core`, so a real
> Pascal node can be authored and driven without the editor dependency at all.

**This is a deployment boundary, not only an import boundary** — `@pascal-app/editor` ships
unbuilt TypeScript with a `next >= 15` peer, so authoring runs as a Next app and elastiq's Vite
runtime cannot mount it. See §0b.

### The repositories

| Repo | Role | Notes |
|---|---|---|
| `pascalorg/editor` (Pascal) | the 3D editor | MIT, pre-1.0, commits daily. **M1 consumes it as packages and ships a plugin — no fork.** M2 cannot: rendering is not a plugin contribution, so it needs upstream work or a fork. See §M2.0. |
| `Path-Creator` (`@huma/path-creator`) | the time layer | Ours. Timeline schema v10, rig schema v12. |
| `humatopia-frontend` (elastiq) | the product | Ours. Presentation system under `src/features/presentation/` and `src/routes/elastiq/`. |

---

## 0a. Sizing and dependencies — read this to schedule the work

Sizes are relative, not calendar estimates: **S** = a day or less, **M** = a week or so,
**L** = multiple weeks, **XL** = a month or more with real unknowns.

| Phase | Size | Stack | Blocked by | Notes |
|---|---|---|---|---|
| M0.1 three alignment | S | both | — | Do first; everything installs behind it. |
| M0.2 version field | S | runtime | — | An hour. Expensive to retrofit. |
| M0.3 security + authoring app auth | **L** | both | — | Blocks external launch. Now also covers the separate editor app's identity — §0b. |
| M0.4 typecheck gap | S | — | — | Two lines per example. Hid a broken commit for four commits. |
| M0.5 asset pipeline | M | both | M0.2 | M3.1 cannot ship without it. |
| M1.1 plugin skeleton | S | authoring | M0.1 | **Done** 2026-08-17. |
| M1.2 binding + tracks | M | both | M1.1 | **Done** 2026-08-17. |
| M1.3 timeline UI + host panel | **L** | authoring | M1.2 | **Largest single chunk.** Includes standing up the Next dev loop — see §0b. |
| M1.4 camera + shots | M | both | M1.2 | **Done** 2026-08-17. R9 re-measured against drei's real CameraControls. |
| M1.5 cues | S | both | M1.2 | **Done** 2026-08-17. |
| M1.6 persistence | M | both | M1.2 | **Done** 2026-08-18, camera tracks included. |
| M2.0 delivery mechanism | S | — | — | A decision, not code. Gates all of M2. |
| M2.1 post-processing | M | both | M0.1, M2.0 | Mechanical. Direct TSL equivalents. Includes seam PRs if (c). |
| M2.2 environment + lighting | **XL** | both | M2.1, M2.0 | A re-authoring. The biggest risk in the plan. |
| M2.3 materials | **L** | both | M2.1 | |
| M2.4 shadows | M | both | M2.2 | |
| M2.5 splats | M | both | M2.1 | Implementation exists elsewhere; integrate. |
| M2.6 look authorable | M | both | M2.2, and an open decision | See §M2.6 — schema question first. |
| M3.1 document format | M | runtime | M0.2, M0.5 | |
| M3.2 worlds + one canvas | M | runtime | M3.1, M1.6 | |
| M3.3 riding on navigation | S | runtime | M3.2, M1.5 | Small, because the ride already exists. |
| M3.4 embedded authoring | M | both | M1.3, M3.2 | Iframe + postMessage, not a React mount. Smaller than first sized — see §0b. |
| M3.5 steps as sub-cues | S | runtime | M3.3 | |
| M3.6 AI schema doc | S | — | M3.1 | Otherwise AI decks stay 2D forever. |
| M4.0 transport | **L** | runtime | M0.3 | Backend. Not free. |
| M4.1 clock sync | M | runtime | M4.0, M3.3 | |
| M4.2 ownership + permissions | M | runtime | M4.1 | |
| M4.3 live viewer route | M | runtime | M4.1 | |

### Three tracks run in parallel

The milestones are **not** strictly sequential. After M0.1 lands, three streams are independent
and can be staffed separately:

- **Time** — M1 entire. Touches Pascal and path-creator. Does not need rendering work.
- **Rendering** — M2 entire. Touches Pascal's viewer. Does not need the timeline to exist.
- **Format and product** — M0.2, M0.5, M3.1. Touches elastiq. Does not need either of the above.

They converge at **M3.2**, which is the first phase requiring all three. Schedule backwards from
there. M2.2 is the long pole; start it early even though it is not blocking anything yet.

---

## 0b. Deployment topology — two apps, one document

**Discovered during M1.1, and it constrains M1.3 and M3.4.** `@pascal-app/editor@1.0.0-beta.4`
does not ship a built bundle. It ships **438 raw `.tsx` files** with `next >= 15` as a peer
dependency, `next` imported in 26 of them, plus Tailwind and roughly twenty Radix, dnd-kit and
pdfkit dependencies. Elastiq is Vite with TanStack Router. The editor cannot be mounted there.

**We are not changing that.** Pascal is a large project with many contributors and a deliberate
Next choice; opening that as an upstream architecture debate is not a fight we can win or should
pick. We contain the coupling instead.

```
   editor.elastiq.<domain>              elastiq (existing, Vite)
   ───────────────────────              ────────────────────────
   Next app                             presentation runtime
   @pascal-app/core + nodes             @pascal-app/core + nodes
                 + viewer + editor                    + viewer
   @huma/pascal-time  (manifest         @huma/pascal-time  (manifest
                       + host panel)                       only)
   @huma/path-creator (authoring)       @huma/path-creator (runtime)
              │                                    │
              └────────  one document  ────────────┘
```

**Authoring is a separate Next app.** All Next coupling lives there and stops there. It mounts
Pascal's editor with our plugin loaded through their `setPluginDiscovery` hook — the mechanism
their plugin docs describe for exactly this — rather than us standing up bespoke Next scaffolding.

**Presentation stays elastiq unchanged** — Vite, mounting the timeline runtime over Pascal's
renderer.

> **Correction, measured during M1.1.** An earlier version of this section claimed the runtime
> escapes Next by simply not importing the editor. **It does not.** Importing `@pascal-app/nodes`
> executes editor source before it returns an export — **190 of its 616 built files import the
> editor**, the chain is static so no lazy-loading on our side avoids it, and declaring the
> dependency pulls in 109 packages including Next 16. The cause is by design: a Pascal node
> definition bundles its authoring affordances (placement tools, floorplan move targets, inspector
> parametrics) with its runtime shape, so importing a kind imports the editor.
>
> **The two-app topology above is unaffected and still correct.** What fails is only the idea that
> the runtime stays Next-free by keeping the editor out of its own import list.
>
> **Unresolved — decided at M1.3, deliberately not before.** Two candidate answers, and the
> measurement that settles them needs a real baked scene, which needs the nodes package installed,
> which is M1.3 work. Do not reason about it earlier:
>
> - **Bake.** Pascal's GLB export stamps node identity into glTF `name` and `extras` expressly so
>   *"selection/hover survive the bake with no in-memory registry"*, and it has a `BakePolicy` of
>   `static | strip | replace` plus a baked-viewer concept. That drops `nodes`, the editor and Next
>   out of the runtime entirely; the binding adapter resolves ids against a map built from the
>   baked glTF instead of `sceneRegistry` — same interface, different source. **The cost is that
>   animation on a baked mesh is limited to transform and visibility.** No parametric animation: a
>   wall can move into place, but it cannot build itself.
> - **Ask upstream to split `nodes`** into runtime (schema, renderer, geometry) and authoring
>   (tools, affordances, parametrics) halves. Same shape as the frame-rate seam, much larger
>   refactor on their side, real latency.
>
> **The product question underneath, and it is Steffen's:** does the vision need parametric
> animation, or is transform-and-visibility enough? That decides bake versus split.
>
> **Also still unmeasured:** whether `@pascal-app/viewer` statically reaches the editor too. If it
> does, the runtime cannot mount Pascal's renderer at all and this cascades into M2's one-renderer
> decision, collapsing it toward the two-renderer fallback. Measure it alongside the bake test.

> **This paragraph does not hold as written, measured 2026-08-17 during M1.2.** Mounting
> `@pascal-app/nodes` *does* bring `@pascal-app/editor`, and therefore Next, into the Vite
> bundle. `import('@pascal-app/nodes')` executes editor source before yielding a single export;
> 190 of its 616 dist files import the editor; `column/definition.js` statically imports
> `./floorplan`, `./floorplan-affordances` and `./floorplan-move`, and all three import the
> editor; declaring the dependency pulled in 109 packages including `next@16.3.1`. It is a
> static graph, so no amount of lazy-loading on our side avoids it.
>
> The two-app topology above is unaffected — it is still right, and for the reasons given. What
> fails is only the claim that the *runtime* app escapes the editor dependency by leaving
> `/editor` out of its own imports. Three ways out, none chosen:
>
> 1. **The runtime does not mount `/nodes`.** Correct today for a product whose scene vocabulary
>    is its own — the elastiq prototype and the pascal-time harness both do exactly this and pay
>    nothing. It costs Pascal's 46 architectural kinds, so a *Pascal-authored building* would not
>    render. Fine for M1; not fine for the buildings this system is for.
> 2. **Publish through Pascal's bake.** Pascal already has a runtime path that does not need the
>    `/nodes` renderers: `def.bake` (`static` / `strip` / `replace`), `exportSceneToGlb`, and the
>    `GlbScene` / `buildGlbReferenceNodes` surface `@pascal-app/viewer` exports for exactly this.
>    The published artifact becomes baked geometry plus live nodes for the kinds that need them.
>    **This is probably the answer** — it is Pascal's own, it needs no upstream change, and it
>    suits a presentation runtime better than shipping a parametric editor. It also interacts
>    with M1.6 and M3.1: what gets baked, and what the timeline still binds to by id afterwards.
>    Nobody has measured it.
> 3. **Upstream the split** — move `tool`, `panel`, `floorplan*`, `move-tool` and `preview` in
>    `/nodes` behind lazy boundaries so schemas and renderers can be imported alone. General
>    enough to be welcome upstream, but it is a change to someone else's package on their
>    schedule, so it cannot be depended on.
>
> **The viewer is clean — measured, and it bounds the blast radius.** `@pascal-app/viewer`
> imports the editor in 0 of its 92 dist files, imports `/nodes` in 0 (the textual hits are
> comments), and imports `next` in 0. Its entire external surface is core, drei, fiber, react,
> three, two three-mesh libraries and zustand. End to end: `examples/pascal-time-harness`
> resolves only core and viewer, has no `next` in the lockfile at all, and still runs Pascal's
> real `<Viewer>` on WebGPU for 560 frames. **`/nodes` is the only offender**, so the runtime
> keeps Pascal's renderer and loses only Pascal's parametric kinds — which means **M2's "one
> renderer" premise is not threatened by this** and the two-renderer fallback is not forced.
>
> Full evidence in `INTEGRATION-DESIGN.md` §11. **Decide before M3.2**, which is the first phase
> where a published presentation has to render a Pascal-authored scene.

**In-product, the editor is an iframe — and this is not a compromise.** Elastiq already does it:
its 3D scene editor opens in a separate tab and rounds its config back over a `BroadcastChannel`
keyed by session, and it runs sandboxed micro-apps in iframes with a postMessage bridge that
forwards arrow keys so deck navigation keeps working. Pointing that existing, load-bearing pattern
at a deployed editor app is an upgrade to something that already ships, not a new architecture.

### What this requires of the plugin package

**Two entry points, split at the package boundary** — which is the shape Pascal already expects:

- **`@huma/pascal-time`** — the manifest: node kinds, tracks, evaluation. Framework-agnostic,
  consumable by Vite and Next alike. Loaded by **both** apps.
- **`@huma/pascal-time/host-panel`** — the `EditorHostPanel` (timeline UI). Editor-coupled and
  therefore Next-coupled. Loaded **only** by the authoring app.

Split them from the start so the runtime half can never drag the panel — and the whole Next
dependency tree — into elastiq's bundle. A single entry point that conditionally imports the panel
will not survive a bundler.

### Consequences elsewhere in this plan

- **M1.3** builds the host panel against Pascal's own `apps/editor` (with our plugin injected via
  `setPluginDiscovery`), not against a Vite harness. Re-size accordingly: standing up that loop is
  part of the phase.
- **M3.4** "embedded authoring" means **iframe plus postMessage document handoff**, not mounting
  the editor in elastiq's React tree. Reuse the existing session-keyed round-trip pattern.
- **A deployment and auth story is now in scope** for the authoring app: where it runs, how it
  authenticates against the same documents, and how the handoff carries identity. Folded into
  M0.3, which is already the auth phase.

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

### M0.4 — Close the typecheck gap in CI

**Why.** Only `Packages/path-creator` declares a `lint` script, so `pnpm -r lint` silently skips
all three examples and exits zero. The examples are typechecked only by `pnpm -r build`, and
`vitest` never typechecks at all. A commit with six unresolvable import specifiers therefore
passed lint and passed tests, and survived four commits before an agent caught it by building.

**Tasks.** A `lint` script (`tsc -b --noEmit` or equivalent) in every example package, so
`pnpm -r lint` covers the workspace. Confirm CI runs it.

**Done when:** deliberately breaking an import in an example fails `pnpm -r lint`.

### M0.5 — Asset pipeline

**Why.** M3.1 says assets become content-addressed references, and the format cannot ship without
somewhere for them to live. Today two of three save paths write `blob:` URLs straight into slides,
which are dead on the next page load — so this also fixes a live data-loss bug.

**Tasks.** Content-address by hash on upload. Store through elastiq's existing `@/lib/storage`
abstraction (S3-compatible in production, local filesystem in development). Return a stable asset
id that the document references. Deduplicate on hash so two slides using the same model store one
copy. Decide and record a retention policy — an asset referenced by no document is otherwise
immortal.

**Note for the room (M4).** Content addressing is what makes a returning viewer, or a second
viewer on the same network, avoid re-downloading the world. Cache headers matter here.

**Done when:** uploading a GLB twice stores it once; a document survives a reload with its models
intact; no `blob:` URL can reach persisted data.

---

## M1 — Time, as a Pascal plugin

**The milestone goal:** an author opens Pascal, places objects, keyframes them, scrubs, and gets
deterministic playback. Every existing node kind becomes animatable, and so does every kind
anyone adds later.

**Deliverable:** a plugin package (working name `@huma/pascal-time`) providing node kinds,
tracks, and timeline authoring UI.

**Where it lives.** `Packages/pascal-time` in the Path-Creator workspace to begin with, then
extracted to its own repository once the API stabilises.

Start there because the plugin is the first real consumer of the timeline as an *authoring*
surface and will expose gaps in path-creator's API — the two will change together constantly
during M1, and cross-repo version coordination through that would be friction for nothing. It is
safe because in a pnpm workspace a sibling package's dependency on Pascal does **not** propagate
to `@huma/path-creator`; consumers of the published library never see Pascal in their tree.

Extract later for a reason beyond tidiness: a widely used 3D editor with no animation is a gap
someone will fill, and a cleanly packaged time plugin is contributable to Pascal's ecosystem in a
way a package inside our monorepo is not.

**The rule that keeps this honest: `@huma/path-creator` must never import from Pascal.** It is a
renderer-agnostic time library with other consumers. If that rule ever needs breaking, the design
is wrong, not the rule.

### Pascal plugin traps — read before writing a single kind

These are measured, and each one fails **silently**. 1-9 were hit during the spike; 10-14 were
found building `Packages/pascal-time` in M1.1/M1.2 and are recorded nowhere else.

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
10. **A plugin kind's node id cannot type-check against the store.** `AnyNodeId` is a
    template-literal union of `` `${builtinKind}_${string}` `` over Pascal's own 46 kinds, so
    every `createNode` / `deleteNode` / `nodes[id]` call from a plugin is a type error. Runtime
    is unaffected — `BaseNode.id` is a plain `z.string()`. Cast once; see
    `Packages/pascal-time/src/plugin/scene-ops.ts`. **Worth upstreaming.**
11. **`loadPlugin` is declared `async` but registers synchronously** (no `await` before the
    registration loop), so callers need not await it — but an `apiVersion` mismatch throws
    *inside the returned promise* and, unawaited, becomes an unhandled rejection pointing
    nowhere. Attach a handler.
12. **`setInstalledPlugins` replaces the list; it does not append.** Two plugins that each call
    it with only their own id leave the first silently uninstalled. Merge.
13. **`@pascal-app/core` is bundler-only too**, not just `/nodes` — same directory-import
    problem. Under Vitest, `server: { deps: { inline: [/@pascal-app\//] } }` fixes it, and the
    payoff is large: tests then run against Pascal's **real** store and registry rather than a
    stand-in. Take this route; it is strictly better evidence than the spike had.
14. **Dirty marking is deferred to `requestAnimationFrame`.** Headlessly nothing is ever marked,
    so "driving left the dirty set alone" passes while measuring nothing. Shim rAF and keep a
    control assertion that fails when the counters stop moving.

### M1.1 — Plugin skeleton — **DONE** (2026-08-17)

Manifest, one trivial node kind, registered and rendering. Proves the loop before anything
depends on it. Reference implementation: `examples/elastiq/src/document/scene-plugin.ts`.

**Done when:** the kind appears in Pascal's registry, places, renders, selects and deletes.

**Delivered** as `Packages/pascal-time`, contributing `huma-time:timeline` — the scene's clock.
It has no position deliberately: under the classification test a node earns a place in space by
being placed by a person, and a clock is not, so it is an organisational kind in the same class
as Pascal's own site/building/level (`dirtyTracking: false`, `hitVolume: 'none'`).

*Reading of the done-criterion, agreed with the product owner:* "in Pascal's editor" means the
lifecycle works through **Pascal's machinery**, not that `@pascal-app/editor` is mounted. That
package ships raw TSX source (438 files, `next >= 15` peer, imported in 26 of them), so mounting
it would front-load all of M1.3's integration cost into a phase sized at a day. Exercised
instead through the scene store and the viewer's selection state, with the capability flags the
editor's chrome reads asserted directly.

**Evidence** — 15 headless tests against Pascal's real registry and store, plus 13 browser
checks in `examples/pascal-time-harness` (system Chrome, WebGPU, Pascal's real `<Viewer>`):
registry contains the kind; the node renders through Pascal's own dispatch (proven by its
appearance in `sceneRegistry`, which only a mounted renderer writes); `useViewer` selection
accepts it and resolves 2 live objects; delete unmounts the renderer and clears the registry
entry; undo remounts it and puts the object back.

### M1.2 — The binding adapter and track driving

Wrap `sceneRegistry` as path-creator's `ObjectBindingResolver` (four lines — see
`examples/elastiq/src/render/scene-binding.ts`) and drive transform and visibility tracks
over Pascal nodes.

**Known and expected:** Pascal has no runtime `AnimationMixer` for its nodes, so
`resolveAnimation` returns null and every transform track over a Pascal node is absolute.
Additive mode has nothing to layer over. Skinned GLB clip playback stays path-creator's job on
objects it registers itself.

**Done when:** a keyframed track moves a Pascal-authored object, scrubs deterministically, and
restores the pre-drive pose on leave. Assert undo depth and dirty-node count are unchanged.

**Delivered.** `pascalObjectBinding` / `pascalSceneBinding` and `PascalNodeDriver`.

| Measurement | Headless | Browser (Pascal's viewer, WebGPU) |
|---|---|---|
| Frames driven | 2000 | 560 at 43.8 fps |
| Undo depth grown by driving | 0 | 0 (5 → 5) |
| Dirty-node count grown by driving | 0 | 0 (3 → 3) |
| Frames where our write was overwritten | — | 0 |
| Worst drift | — | 0.00000 m |
| Pre-drive pose restored on release | exact | exact (0 m) |

Determinism is asserted directly rather than implied: poses sampled forward across the timeline
equal poses sampled backward, key for key. A marker named by no track never moved.

Both suites carry a **control** — one ordinary `updateNode` must move undo depth by exactly 1
and put the node in the dirty set. It is not ceremony: the first version of the dirty assertion
passed while measuring nothing, because Pascal defers marking to an animation frame that Node
does not have (trap 14), and the control is what caught it.

The headless suite drives a genuine Pascal `column`, authored from Pascal's own schema. Built-in
node *schemas* are exported by `@pascal-app/core`; only their renderers and tools live in
`/nodes`, so a real Pascal kind can be driven without the editor dependency of §0 principle 7.

### M1.3 — Timeline authoring UI inside the editor

The lane editor, keyframes, curves. path-creator already ships `/timeline-ui` with a shared
curve engine and a keyframe curve editor; reuse rather than rebuild.

**How it mounts — do not guess this.** Panels are deliberately *not* a core plugin contribution.
Pascal's plugin contract states that panels and sidebar UI are host-specific and that a plugin
exports an **`EditorHostPanel`** separately, for hosts using `@pascal-app/editor`. So the plugin
package ships two entry points: the node kinds through the manifest, and the timeline panel
through the host-panel export, registered with `registerEditorHostPanel`. The upstream
`plugin-bones`, `plugin-trees` and `plugin-streetscape` packs all do this — read one before
starting.

**Where you develop it.** Not in a Vite harness — the editor package is unbuilt TSX with a Next
peer (§0b). Run against Pascal's own `apps/editor`, injecting our plugin through their
`setPluginDiscovery` hook, which their plugin docs describe for this purpose. Standing that loop up
is part of this phase, not preparation for it.

**Package split.** The panel is `@huma/pascal-time/host-panel`, a separate entry point from the
manifest, so elastiq's runtime can never pull the editor — and therefore Next — into its bundle.
See §0b.

**Why this is the long pole.** `/timeline-ui` is DOM and React with its own theme; Pascal's editor
has its own chrome and design language. Expect real work reconciling them, and expect the
@xzdarcy lane dependency to be the thing you end up replacing (path-creator's roadmap already
flags it as unmaintained, with an in-house lane as the intended replacement).

**Frame-rate note.** Pascal's viewer runs `frameloop="never"` and advances through
`<FrameLimiter fps={50} />` with 50 **hardcoded**. A `maxFps` prop is proposed upstream as
[pascalorg/editor#671](https://github.com/pascalorg/editor/pull/671). If it has not merged, either
carry the patch or drive `advance` yourself. Do not design around 60fps until it lands.

**Done when:** an author can keyframe from the timeline panel and see it play in the viewport.

### M1.4 — Camera and shot kinds — **DONE** (2026-08-17)

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

**Delivered.** `huma-time:shot` is a node kind carrying a camera and the moment it takes over,
with two bodies: `static`, and `orbit` which **names the node it frames**. `readShots()` turns
those into `@huma/path-creator` virtual camera definitions; `PascalCameraDirector` resolves which
shot is in force and applies it. A shot holds until the next takes over and takes over across its
own `blendSeconds`, so a cut is `blendSeconds: 0` and there is one code path rather than two.
Before the first shot the director writes nothing at all, leaving the host's camera alone rather
than snapping it.

**R9, re-measured against the real controller.** drei's `CameraControls` — the same component
Pascal's editor mounts — was mounted in the harness, because a rule about what happens when a
controller is present cannot be tested against a stand-in.

| | |
|---|---|
| Frames the camera did not hold the resolved pose | **0 of 451** |
| Worst positional error | **0 m** |
| Orbit radius held against the framed node (authored 5.0) | **5.0** |

The headless suite carries the control that gives those zeros meaning: a direct write past the
same controller is shown to be lost on its next update. Without it, "feeding the controller
works" would be equally true of a controller that did nothing.

**This also answers M1.5's open container question.** A kind that draws something is a kind an
author places, and a placed thing is spatial under the classification test — so it parents where
spatial things parent and names its clock with a `timelineId` field rather than by `parentId`.
The timeline renderer stays a leaf, and the hole Pascal leaves for container kinds is real but
has nothing in it. Revisit only if a time kind ever needs to both draw and be non-spatial.

**Carried limitation, for M1.6.** `timeSeconds` lives on the shot, so one shot cannot be reused
at two times. The alternative is a camera track referencing shots by id — which is what
`@huma/path-creator` already models and what a shot list eventually wants — but tracks are not
persisted until M1.6, and inventing a second unpersisted concept to avoid this would be the
worse trade today.

### M1.5 — Cues — **DONE** (2026-08-17)

Named timestamps as first-class data, plus the transport that rides the clock between them.

A working implementation with tests existed at `examples/elastiq/src/document/cues.ts` (now
promoted, and deleted from the example) —
cue lookup at, before and after a time, and a ride that lands exactly on the cue, replaces a ride
in flight **from the current clock rather than the old origin**, and treats zero duration as an
immediate seek. Promote it into `@huma/path-creator/timeline`.

**Done when:** cues are authorable, navigable, and the ride is covered by tests at those edges.

**Delivered in three parts.**

*The library* now owns cues (`@huma/path-creator/timeline`): `Cue`, the three lookups, the
transport, and `rideTo` / `rideToNext` / `rideToPrevious` / `rideToCue`. The spike's nine tests
became **19**, adding the edges the phase names plus: no cue before the first; reversing
mid-ride turns around from where it is; a ride never seeks below zero; the same total delta
lands in the same place however many frames it arrived in; and — the one that states what a ride
*is* — **a ride does not fire the events it passed over**, because it seeks rather than plays.
Skipping to slide five must not trigger every sound between here and there.

The lookups are generic over the cue type, so a product's own per-cue fields survive the round
trip. The elastiq example proves it: its cues carry a `renderMode` the timeline layer knows
nothing about, and it now consumes the library rather than its own copy.

*The plugin* makes cues **authorable**: `huma-time:cue` is a Pascal node kind, parented to the
timeline whose clock its `timeSeconds` is measured on. A cue is timeline data, so the reason it
is a scene node is worth stating — an author creates, names, retimes, deletes and undoes it, and
Pascal already does all of that for any registered kind. `readCues()` hands the time layer plain
`{ id, name, time }`. **The node id is the cue id**, so a hotspot's reference is a node
reference like every other in the system.

*The harness* proves it in Pascal's real viewer. It rides to a cue named `peak` over ~46 frames
and checks not only that the clock landed on 4.0 exactly but that **the driven marker was at
y=3.4** — the pose the transform track specifies for that instant. That is the phase's whole
thesis made falsifiable: animating `t` moves everything, and there is no separate transition
system.

**Found while building it, and M1.4 has to decide it.** Pascal's `<NodeRenderer>` renders a
node's *own* renderer and does **not** dispatch children — which is why its site and level
renderers dispatch theirs explicitly. A container kind that does not is a silent hole: children
exist in the document, behave correctly in the store, and never mount. Measured: three cues
under the timeline node leave the scene at 7 document nodes and 4 registered objects. It costs
nothing while the children are moments, so `huma-time:cue` ships **no renderer** rather than an
unreachable one. A shot or camera parented to the timeline in M1.4 will want to draw something,
and then it is a real choice: dispatch children from the timeline renderer (depending on
`@pascal-app/viewer` for `<NodeRenderer>`, or reimplementing its install gate and lazy-module
contract), or parent renderable time kinds at the scene root. Recorded as trap 11 in
`Packages/pascal-time/README.md`.

### M1.6 — Persistence — **DONE** (2026-08-18)

The timeline lives in the scene document alongside the nodes. Schema-versioned, migrating.

**The unsolved problem, and it lands here.** Pascal's `cloneNodesInto` mints **fresh ids** — which
is exactly what a prefab needs and exactly what a timeline reference cannot survive. Duplicating an
animated object will break its tracks. **DECIDED 2026-08-17: remap tracks on clone** (§ decision 1).

**Delivered.**

*Tracks are one versioned field on the timeline node*, not a node per track — and that reverses the
recommendation this phase started with. Three claims were made for track-as-node and measurement
killed all three: undo is granular over store *operations*, not nodes; `schemaVersion` is validated
at registration and **never read again**, so Pascal supplies no migration; and the inspector comes
from a hand-declared `parametrics` descriptor, not from the Zod schema. Since the migrator is ours
either way, one versioned payload is the smaller thing to migrate, and the outliner presence nodes
would have bought largely duplicates the panel M1.3 delivers. The surviving argument for nodes is
concurrent editing, which matters at M4 — that is the one reason to revisit.

*The hazard the API is shaped around.* Pascal's undo snapshot holds the nodes map **by reference**,
not as a deep copy. Measured: mutating a stored array in place and then undoing does not restore
it, because the past state was mutated too. Every editing function returns a new array, and a test
enforces it.

*Versioning is ours.* The payload carries `trackPayloadVersion`; a missing value reads as **0**, not
as current, so a document written before versioning still migrates instead of being misread. That is
the trap elastiq's decks are in today, avoided here by construction. The migrator drops entries that
never validated rather than carrying them forward.

*The clone remap is implemented.* Every track bound to a node inside a cloned subtree is duplicated
and rebound to the copy, so the duplicate animates like the original — verified by driving both and
seeing both move. The accepted cost stands: N copies means N track sets, with binding indirection as
the named upgrade if authoring at scale demands it.

**Evidence.** 18 headless tests, plus three browser checks confirming the harness now reads its
timeline *out of the document* rather than building one in code — 2 tracks, payload version 1. The
harness fails loudly if persistence breaks rather than falling back to a fixture.

**Camera tracks landed too, and removed a duplicate implementation.** Checking before building
found that `evaluateTimeline` already resolves the camera from blocks — so M1.4's director was a
second, weaker copy of library logic: it snapped the field of view at a cut where the library
blends it. The director now defers resolution to the library and keeps only the half the library
cannot do, obeying R9 against the host's controller. Camera blocks join the persisted payload,
and `synthesiseCameraTrack` builds one at READ time from the shot nodes when a document has none,
so old documents play back without being rewritten on load. A camera track can name the same shot
in two blocks, which lifts M1.4's carried limitation. Re-measured after the refactor: still 0
contested frames, orbit radius still exactly 5.0.

## M2 — Rendering

**The milestone goal:** a scene authored in Pascal looks like elastiq's current output. One
renderer, so author and audience see the same picture.

Do these in order — the first is mechanical and the rest are not.

### M2.0 — Decide how this ships *(before any M2 code)*

**M1's "no fork" rule does not extend to M2.** Rendering is not a plugin contribution: Pascal's
plugin contract explicitly lists materials as *not* a contribution point, and there is no hook for
replacing or extending the post-processing pipeline. Changing the look means changing
`@pascal-app/viewer` itself.

So M2 ships one of three ways, and the choice materially changes its cost:

**(a) Upstream the look.** Propose the additions to Pascal directly. No carrying cost if accepted.
But it is an architectural editor and this is a presentation-grade aesthetic — their roadmap may
simply not want bloom and transmission materials, and PR latency would gate our schedule.

**(b) Fork `@pascal-app/viewer`.** Total control, and a recurring rebase cost against a pre-1.0
package that commits daily. This is the expensive option and it compounds.

**(c) Upstream the *seam*, keep the look. — recommended.** Contribute the extensibility rather
than the aesthetic: a pluggable post-processing pipeline, an environment provider hook, a material
registry. Then our look lives in our own code on top of a supported extension point, and Pascal
gains a capability its ecosystem wants regardless of what we do with it.

This is exactly the shape of [#671](https://github.com/pascalorg/editor/pull/671), already open:
we did not upstream our frame rate, we upstreamed the ability to configure it. Same move, larger
surface.

**Cost note.** (c) is more work than (b) up front — a seam has to be designed and accepted — and
far less work than (b) over any horizon longer than a few months. Budget the seam PRs as part of
M2.1 rather than treating them as overhead.

**Interaction with the M2 fallback.** If Pascal will not take a seam and a maintained fork is
judged unacceptable, the two-renderer fallback below stops being a contingency and becomes the
plan. Establish this before M2.2, not after.

**Done when:** the delivery mechanism is chosen and recorded here, and if (c), at least one seam
proposal is open upstream.

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

### M2.6 — The look becomes authorable *(schema decision required first)*

**Do not start this as a task. It is a design question wearing a task's clothes**, of the same
kind as "what is a slide", and it needs a recorded answer before code:

> Where does the look live — as scene nodes with animatable properties, as timeline tracks, or
> split between them?

The trade. **Nodes**: lights and environment become first-class scene objects, placeable and
inspectable with everything else, and the timeline animates their properties like any other node —
consistent, but "post-processing intensity" is not a thing in space. **Tracks**: the look is
purely temporal, which fits post but makes a light something you cannot select in the viewport.
**Split** is probably right — lights and environment probes are scene nodes, post-processing is a
timeline track — but that is an assertion, not a decision, and it must be written into
`INTEGRATION-DESIGN.md` before M2.6 begins.

Once decided: "polished" and "technical" stop being modes and become positions in a look-space
that can **transition as you ride** — a slide can dissolve from a rendered view into an inked
technical read.

**Done when:** the decision is recorded, and a look change is keyframable and rides with the clock.

### M2 kill criterion and fallback *(not a phase — read before starting M2.2)*

M2.2 is the largest risk in this plan and it is a *quality* risk, not a technical one: the port may
work and still not look as good.

**Kill criterion.** If environment, materials and shadows have not reached parity with elastiq's
current output after a genuine attempt, stop and take the fallback rather than grinding.

**The fallback is two renderers** — Pascal's viewer for authoring, elastiq's existing WebGL stack
for publishing. It was rejected in the design because it means author and audience see different
pictures and a preview button becomes load-bearing. It is not rejected as unworkable, and it is
what every mainstream 3D tool does. Both were built and measured during the spike, so the path
back is short.

**What that costs if taken:** the look stops being authorable on the timeline (M2.6 dies), and the
scene must render under two renderers, which imposes the discipline that no node kind may use a
renderer-specific material.

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

**Migration, and it is lossy — say so to users.** An existing 3D slide becomes a **single-slide
world**, and structurally that is clean: a deck may mix shared worlds and private ones, so the
migration is not all-or-nothing.

But it cannot be faithful, because the old data is genuinely ambiguous. Part visibility is keyed
by **mesh name** in one flat record shared across every model in the scene. Where two models
contain a mesh called `Cover`, or where an array clone duplicated every mesh name, the stored
`hidden`/`ghost` flags do not identify which object they meant. Minting stable ids cannot recover
information that was never captured.

**Required policy, to decide and record before writing the migrator:**
- Ambiguous name matches — apply to all matching meshes, apply to the first, or drop and warn.
- Whether a migration report is surfaced to the author, listing what could not be resolved.
- What happens to `attachTo` on annotations, which is written and restored today but never read
  when rendering, so mesh-attached annotations are *already* landing at world origin. Migrating
  the broken behaviour faithfully is probably wrong.

Also note what the old format never captured at all and therefore cannot be migrated: material
assignments, material tweaks, imported MaterialX materials, and per-model scale. Authors will lose
these regardless. Warn them before they migrate, not after.

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

### M3.4 — Embedded authoring *(iframe, not a React mount)*

The authoring app is a separate Next deployment (§0b), so this is **not** mounting an editor
component in elastiq's tree — it is an iframe plus a postMessage document handoff.

**Reuse what exists rather than inventing.** Elastiq already opens its 3D scene editor in a
separate tab and rounds the config back over a `BroadcastChannel` keyed by session, and already
runs sandboxed iframes with a postMessage bridge that forwards arrow keys so deck navigation keeps
working. Point that pattern at the deployed editor and carry the document instead of a config blob.

**Make it read as one product**, not a linked-out tool: same chrome, same auth session, no visible
navigation away. That is a presentation concern and it is where the effort goes.

**Do not reproduce the current inversion** — `src/features/presentation/*` imports
`ModelViewerPage` from a **route file** today. The runtime must not import from an authoring
surface at all.

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

### M4.0 — Transport and rooms *(backend; not free)*

**Why this is called out.** The rest of M4 describes what to replicate and reads deceptively cheap.
The infrastructure under it is ordinary backend work that appears nowhere else in this plan.

**Tasks.** A WebSocket relay with room lifecycle, join and leave, late-join snapshot, presenter
election and hand-off, reconnection, and a deployment story with a scaling and cost model. The
March plan's transport reasoning stands — BroadcastChannel same-device, WebSocket remote, CRDTs
rejected as overkill for a presenter-authoritative model — but reasoning is not an implementation.

**Depends on M0.3.** Rooms without auth and tenant isolation is the launch-blocking hole made
worse, not better.

**Done when:** two browsers on different networks join a room, one drops and rejoins, and both
converge without a reload.

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
  drive it headlessly in real Chrome, report a number. `examples/elastiq` has the harness.
- **Upstream what is general.** Pascal is MIT and moves fast. A patch we carry is a cost forever;
  a merged PR is not.
- **Record reversals.** If evidence overturns a rule, change the rule *and* write down what
  overturned it. Do not edit a rule silently.

## Open decisions, owned by the product owner

1. ~~**Clone versus timeline references** (M1.6)~~ — **DECIDED 2026-08-17: remap tracks on clone.**
   Binding indirection is the upgrade at scale; relative subtree paths ruled out on principle. Full
   reasoning and the implementation risk are in §M1.6.
2. **Parametric animation, or transform-and-visibility?** (§0b) — decides bake versus asking
   upstream to split `@pascal-app/nodes`. Baking gives a Next-free runtime and costs parametric
   animation: a wall can move into place but cannot build itself. Answer at M1.3, with a real baked
   scene in hand.
3. **Where the authoring app lives and how it authenticates** (§0b) — subdomain, path, or
   same-origin route; and how it shares identity with elastiq's documents. Blocks M1.3's
   deployment story, not its code.
4. **How M2 ships** (M2.0) — upstream the look, fork the viewer, or upstream the seam and keep the
   look. Recommendation is (c). This gates all of M2 and changes its cost by a large factor.
5. **Where the look lives** (M2.6) — scene nodes, timeline tracks, or split. Blocks M2.6 and
   shapes M2.2. A recommendation is written there; it needs a decision.
6. **Migration policy for ambiguous part references** (M3.1) — apply to all, apply to the first,
   or drop and warn; and whether authors see a migration report. Some data cannot be recovered
   either way, so this is about what users are told, not only what the code does.
7. **Fork policy for Pascal** — M1 needs no fork. M2 does unless decision 3 lands on upstreaming a
   seam. Set the threshold at which divergence must be upstreamed rather than carried, and who
   owns rebasing if a fork is taken.
