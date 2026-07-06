<!--
Purpose: Handoff for Stage 3c of the "authored world" work — converge the demo
on RigDocument as the single source of truth (save/load), then extract the
per-frame drive-loop out of the demo monolith into the @huma/path-creator
package. Read alongside docs/technical/camera-system-implementation.md.
Scope: examples/minimal-r3f-demo + Packages/path-creator. Written 2026 mid-session.
-->

# Stage 3c handoff — RigDocument convergence + package extraction

## TL;DR

Two linked goals:
1. **3c — converge**: the demo's world state *becomes* a `RigDocument` (single
   source of truth) with an editor sidecar, saved/loaded from localStorage +
   JSON Export/Import.
2. **Extract**: lift the per-frame **drive-loop** (step carts → evaluate
   timeline → drive brain → apply composer → project overlays) out of the demo's
   `Scene` and into `@huma/path-creator` as a reusable hook, so the demo shrinks
   to UI + document editing and the twin/elastiq get the drive-loop for free.

Do (1) first (it makes (2) clean), then (2). Propose the concrete shapes below
to the user before coding — they want a plan per point.

## Where we are (branch `master`, tree clean)

Commits this arc (newest first):
- `4d043c1` demo: target static/cart mount + composer aim with zone overlay
- `2b4d1cf` composer(pkg): soft zone = damped working boundary; drop hard zone
- `6d949ed` demo: retire live composer preview; authored-only PiP; simple default path
- `fba2ed7` demo: authored point targets + inline-editable names
- `f23787b` demo: empty world valid — nullable editable path, no floor guards

Stages 1, 2, 3a, 3b are DONE. Composer was over-removed in 3a then restored
properly (see Lessons). This handoff is Stage 3c.

## Verify (green baseline)

```
pnpm --filter @huma/path-creator lint       # tsc --noEmit
pnpm --filter @huma/path-creator test        # 95 tests
pnpm --filter @huma/path-creator build       # tsup -> dist (demo consumes DIST)
pnpm --filter minimal-r3f-demo build         # tsc -b && vite build
```
User tests the browser manually (no Playwright). Rebuild the package before the
demo. No `noUnusedLocals` — prune unused imports by hand.

## Constraints

- No git commands without explicit permission. Never push. **No "Co-Authored-By:
  Claude" lines in commit messages** (global rule — I violated this once; a
  malformed heredoc luckily aborted before it committed). Session norm =
  commit-per-green-change, split by concern (package vs demo), reconfirm each time.
- New files get a 5-line purpose header. Match surrounding code style.
- `@huma/path-creator` is ours to change (not upstream) — package changes OK.

## Current data model (what exists now, all in examples/minimal-r3f-demo/src/App.tsx)

- `bezierPath: BezierPath | null` + `paths: DemoPath[]` + `activePathId: string | null`
  (the editable spline mirrors the active path).
- `dollies: DemoDolly[]` = `{id,name,endOfPath,pathId}`.
- `virtualCameras: DemoVirtualCamera[]` — **lossy superset** of
  `VirtualCameraDefinition`: adds `shotStart/shotEnd`, `railFrom/railTo`,
  `noisePreset`, `composerSettings`, `snapshot`, `cartOffset`, `trackTargetId`,
  `dutchDeg`, `bodyType`, `cartId`. The timeline is *derived* from these each
  render (`demoTimeline` memo). `toDemoVcamDefinition()` projects to a real def
  — and now emits **NO aim** (the composer is the aim; see below).
- `pointTargets: DemoPointTarget[]` = `{id,name,position,cartId,visibleInRender}`.
  `cartId` null = static (draggable); set = rides that dolly's cart. Maps to
  `TrackingTargetDefinition` point/cart.
- Persistence: `SHOW_STORAGE_KEY` blob `{dollies,vcams,paths,activePathId,pointTargets}`
  + legacy single-path `STORAGE_KEY`. Migrate-on-read with field defaults.
- Composer: `ComposerSettings` still has **vestigial `hardWidth/hardHeight`**
  (ignored since the hard zone was dropped) — remove in 3c.

## Composer model (settled — matches Cinemachine; do NOT re-litigate)

In `Packages/path-creator/src/r3f/index.ts`, `applyScreenComposerAim` +
`getScreenCorrection`:
- target inside **dead zone** → no correction (roams free; camera still)
- **dead→soft** band → damped correction easing it back toward the dead zone
- beyond **soft** edge → clamped (the "no-pass"; no separate hard zone)

Damping is a **rate** (`1 - e^(-damping·dt)`), so larger = snappier. Cinemachine's
damping is a **time** (larger = heavier/slower) — inverted. **OPEN DECISION**:
user may want it flipped to `1 - e^(-dt/damping)` (small pkg change + update the
"damping is based on delta seconds" / "independently" tests in r3f.spec.ts).
Confirm before doing.

Composer wiring in the demo (Scene): the composer OWNS orientation and must
PERSIST it across frames to damp — kept in `composedQuatRef`; the brain supplies
only position (+ throwaway orientation). There is NO look-at pre-step (a look-at
pins the target in the dead zone and defeats the composer). `applyPreviewComposer`
restores composedQuat → `applyComposerAim` → saves composedQuat; reseeds on vcam
change. Applied in preview (selected/activated) AND timeline playback (through
blends). This is the reference behavior to preserve when extracting.

## Target model for 3c

Persist ONE versioned blob under a NEW key (e.g. `path-creator:minimal-demo:scene`):
```ts
{ schemaVersion, document: RigDocument, editor: EditorSidecar }
```
- **document** = the package `RigDocument` (portable contract for twin/elastiq):
  `paths`, `carts`, `vcams` (real `VirtualCameraDefinition[]`), `targets`
  (`TrackingTargetDefinition[]`), one `timeline`. Runtime via `buildRigRuntime`
  (validates cross-refs at load).
- **editor** = app-only authoring extras keyed by id: per-target
  `{ visibleInRender }`, per-vcam `{ noisePreset }`, `activePathId`. Selection is
  transient (not persisted).

### Screen-composer aim must become a first-class package aim
The blocker: screen-composer aim isn't a pure `VirtualCameraDefinition` concept
today (aim only has look-at). Since the composer is now THE aim and the twin will
need it, **extend the package** `VirtualCameraDefinition.aim` with a
`{ type: "screen-composer", target: {targetId}, settings: ComposerSettings }`
variant (move `ComposerSettings` into the package core, drop hard fields).
- Pure resolution keeps producing a deterministic snapshot (treat composer aim as
  body orientation, or look-at for the pure fallback — pick one and document it).
- The live **drive-loop** applies the composer as a stateful stage for
  composer-aim vcams (persisted orientation, as in `composedQuatRef`).
This makes the composer authored + reusable and lets `toDemoVcamDefinition` stop
being lossy for aim.

### Block timing → authored timeline
Invert today's derive: `shotStart/shotEnd` → camera-track blocks;
`railFrom/railTo` → cart-track keys. Blocks/keys become authored data in
`document.timelines[0]`, not recomputed from `DemoVirtualCamera`. This is the
QA-flagged refactor.

### Storage seam (cheap file support, decided)
Pure `serializeScene()`/`deserializeScene(json)` boundary + a thin `Storage`
adapter. localStorage adapter for autosave + **Export/Import JSON** buttons +
**New scene**. Keep the schema USD-mappable (stable ids, explicit transforms,
asset refs by URI) but do NOT build USD. Migrate old `SHOW_STORAGE_KEY` +
legacy `STORAGE_KEY` on read; stop writing them.

## The extraction (goal 2)

The per-frame orchestration currently in `Scene`'s `useFrame` is the reusable
part. Lift it into the package (e.g. `@huma/path-creator/r3f` hook
`useRigDrive(runtime, player, registry, options)` or a plain
`driveRig(state, dt)` in `/three`). Each frame it must:
1. step live carts (or take timeline-evaluated cart frames),
2. evaluate the timeline,
3. drive the brain (cut/blend) for the active/selected vcam,
4. apply the composer stage for composer-aim vcams (persisted orientation),
5. return `{ camera snapshot, cartFrames, activeVcamId, composerTarget }` for the
   host to render + draw overlays.
The demo's `Scene` then becomes a thin caller. Keep the editor-only bits (gizmos,
glyphs, PiP chrome, panels) in the demo.

Note: `evaluateTimeline` stays pure in `t`; the composer is a live post-stage the
drive-loop owns (documented package boundary — composer is stateful, outside pure
resolution).

## Suggested sub-commits (each green + build + user in-browser check)

- **3c-1 (pkg)**: move `ComposerSettings` into package core (drop hard fields);
  add the `screen-composer` aim variant to `VirtualCameraDefinition`; teach
  `buildRigRuntime` to validate its target ref. Tests.
- **3c-2 (demo)**: replace lossy `DemoVirtualCamera` with `VirtualCameraDefinition`
  + authored timeline blocks + `editor` sidecar (noisePreset). Vcams stored as
  real defs. Keep panels working.
- **3c-3 (demo)**: converge all state on `{document, editor}`; derive runtime via
  `buildRigRuntime`; serialize seam + localStorage adapter + Export/Import/New +
  migration from old keys. Drop vestigial hard fields end-to-end.
- **3c-4 (pkg+demo)**: extract the drive-loop into the package hook; `Scene`
  becomes a thin caller.
- (optional, confirm) **damping inversion** to a time-constant.

## Key files

- `examples/minimal-r3f-demo/src/App.tsx` — the monolith: `Scene` (drive-loop +
  editor JSX), `DemoVirtualCamera`/`toDemoVcamDefinition`, `applyPreviewComposer`
  + `composedQuatRef`, `PointTargets`/`TargetView`, `VirtualCameraPanel`,
  `RigSettingsPanel`, `DollyPreviewChrome` (zone overlay), persistence.
- `Packages/path-creator/src/core/rig.ts` — `RigDocument` v2 + `buildRigRuntime`.
- `Packages/path-creator/src/core/virtual-camera.ts` — `VirtualCameraDefinition`
  (add the composer aim variant here).
- `Packages/path-creator/src/core/targets.ts` — `TrackingTargetDefinition`.
- `Packages/path-creator/src/r3f/index.ts` — composer (`applyScreenComposerAim`,
  `getScreenCorrection`), follower/cart hooks, `EditorHelpers`.
- `Packages/path-creator/src/three/index.ts` — brain, resolution, snapshots,
  `markEditorHelpers`/`EDITOR_HELPERS_LAYER`.
- `Packages/path-creator/src/timeline/index.ts` — `evaluateTimeline`
  (`sample.activeBlock.block.vcamId`, `blendProgress`), player.
- `docs/technical/camera-system-implementation.md` — full system reference.

## Lessons from this session (don't repeat)

- **Don't over-remove in a refactor.** 3a cut the whole composer (aim + zone/
  marker overlays) as "furniture"; only the 3D props (follower sphere, look-ball,
  cart-rider) were furniture. Restoring cost many round-trips. Separate furniture
  from core features; keep/retarget rather than delete-then-restore.
- **Composer aims relative to current orientation** — persist orientation
  (`composedQuatRef`), never pre-look-at.
- **`markEditorHelpers` sets the layer on ALL descendants** — a target's visible
  sphere (layer per `visibleInRender`) and its gizmo/ring (editor-only) must be
  SIBLINGS, not nested, or the wrap forces the sphere to the editor layer.
- **Editor vs render visibility** rides the editor-helpers layer (30): playback/
  PiP cameras never see it; the authoring viewport does. `visibleInRender=false`
  puts a target's sphere on layer 30 (invisible aim point).
- **UX naming is not internal jargon** — the user rejected "PiP" as a toggle
  label; use conventions (eye icon for visibility), consistent seed names, and
  make authored entities user-renamable.
- `BezierPath` requires ≥2 anchors. New paths seed a simple 2-anchor start→stop.
- Demo consumes the package **dist** — rebuild the package before the demo.

## First moves for the fresh session

1. Read `docs/technical/camera-system-implementation.md` and this file.
2. Run the four verify commands for a green baseline.
3. Read `App.tsx` (`Scene` drive-loop, `DemoVirtualCamera`/`toDemoVcamDefinition`,
   persistence) and `core/rig.ts` + `core/virtual-camera.ts`.
4. Propose the concrete shapes (composer-aim variant, document+sidecar,
   drive-loop hook signature, storage/migration) to the user BEFORE coding.
