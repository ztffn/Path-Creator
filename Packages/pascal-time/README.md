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

Status: **M1.1 and M1.2 complete.** Workspace-only (`private: true`) until the API settles;
extraction to its own repo is expected, and it is a leaf package with two clean dependencies so
that stays cheap.

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

It has no position, deliberately: under the integration design's classification test a node
earns a place in space by being *placed by a person*, and a clock is not. It is an
organisational node of the same class as Pascal's own site, building, level and zone, which is
why it declares `dirtyTracking: false` and a `hitVolume` of `none`.

Track data is not on the node yet — the host supplies the timeline. Persistence is M1.6.

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

## The ownership rule this package exists to keep

**Write to the live `Object3D`, never to Pascal's node data.** That is what keeps playback out
of the undo history, and it is asserted rather than assumed:

| Measurement | Headless (`pnpm test`) | Browser (`pnpm --filter pascal-time-harness verify`) |
|---|---|---|
| Frames driven | 2000 | 560 at 43.8 fps |
| Undo depth grown by driving | 0 | 0 (5 → 5) |
| Dirty-node count grown by driving | 0 | 0 (3 → 3) |
| Frames where our write was overwritten | — | 0 |
| Worst drift | — | 0.00000 m |
| Pre-drive pose restored on release | exact | exact (0 m) |

Both suites include a **control**: one ordinary `updateNode` must move undo depth by exactly 1
and put the node in the dirty set. Without it the zeros above are indistinguishable from a
broken instrument, which is not hypothetical — the first version of the dirty assertion passed
for that exact reason.

## Known, expected, not a gap

Pascal has no runtime `AnimationMixer` for its nodes, so `resolveAnimation` returns null and
**every transform track over a Pascal node is absolute**. Additive mode exists to layer
corrections over mixer output; here there is nothing to layer over. Skinned GLB clip playback
stays `@huma/path-creator`'s job, on objects it registers itself.

## Layout, and where M1.3's panel goes

```
src/plugin/kinds.ts        node schemas — what Pascal persists
src/plugin/definitions.ts  the Pascal-facing definitions and the manifest
src/plugin/install.ts      registration and per-scene install
src/plugin/scene-ops.ts    the store boundary, cast once (trap 7)
src/render/                renderers — default export, lazy module (trap 1)
src/bind/scene-binding.ts  Pascal's registry as an ObjectBindingResolver
src/drive/node-driver.ts   the per-frame drive
```

The single `.` entry is framework-agnostic: it imports `@pascal-app/core` and never
`@pascal-app/editor`, so Vite and Next can both consume it. The timeline authoring panel (M1.3)
is editor-coupled and therefore Next-coupled, and must ship as a **separate
`@huma/pascal-time/host-panel` entry** — never from `src/index.ts`. A single entry that
conditionally imports the panel will not survive a bundler. See the plan's §0b for the two-app
topology this serves.

One thing to know before planning that: `@pascal-app/nodes` reaches `@pascal-app/editor` through
a static import chain, so "runtime = core + nodes + viewer, no editor" is not achievable at
`1.0.0-beta.4` however cleanly this package is split. Evidence and the three ways out are in
`docs/technical/INTEGRATION-DESIGN.md` §11.
