<!--
Purpose: Living backlog of remaining/known work for @huma/path-creator and the
reference demo, beyond what's already shipped. Not a task tracker for a single
session — a durable list of deferred features, refactors, and known gaps so they
aren't rediscovered. Update as items land or new ones surface.
Scope: Packages/path-creator + examples/minimal-r3f-demo (+ twin integration).
-->

# Roadmap / backlog

Ordered roughly by priority. "Deferred from" notes where the decision was made.

> **2026-07-06 — first real consumption happened.** The twin integration below
> was executed (and shipped: server persistence + visitor cinematic, deployed).
> It surfaced blockers this roadmap did NOT anticipate — WebGPU renderer
> incompatibility, packaging, georeferencing, handle sizing. Those, plus the
> reconciled items here, now live in the authoritative
> **`GEOSPATIAL-INTEGRATION-DEBRIEF.md`** (P0–P3). Read it before picking up
> reuse work.

> **2026-08-17 — the scene/time boundary is now a written contract.** Interactive hotspots
> (Tier 1 below) would have been the first entity this library owns outright rather than
> references. Rather than build it here, the boundary between a scene editor and this library
> is specified in **`INTEGRATION-DESIGN.md`**, and a spike against the Pascal editor
> (`examples/pascal-spike/`) has proven the object-binding and frame-loop seams. Read the
> design doc before adding anything with a position, a lifetime, or a clock.

## Active / next

### ✅ Audio bake + additive transforms (DONE — 2026-08-08)
Four gaps found by dogfooding the package from an external consumer (a weapon
audio tuning tool that stacks sounds over a long reload animation, and needs
corrective bone offsets over baked animation). Full plan, with the decisions and
their reversals recorded:
**`docs/plans/2026-08-08-audio-bake-and-additive-transforms-v1.md`**.

The consumer's pipeline is author-here, bake-to-files, ship-the-files — the game
never runs the timeline. That reframes the timeline as a project file consumed by
a baker, not a runtime format, and it is what makes pitch-preserving stretch cheap
(everything is offline anyway) while removing the case for a runtime onset API.

- **Per-clip `rate` + `stretch`** on `AudioClip` (timeline v9 / rig v11). Constant
  per clip, not animatable — an animatable rate makes source position the integral
  of a curve, so every seek integrates rather than multiplies.
- **One audio graph builder, two contexts.** The per-frame reconciler is retired
  for a scheduler shared by live preview and the offline bake, so they cannot
  drift. Fixes a real defect: `source.start(0, offset)` (`audio-player.ts:160`)
  starts clips *now*, seeking in by however far the frame overshot, so 0–16.7ms
  (60fps) of every attack never plays and by a varying amount each time.
- **Mixdown-per-scene bake** — offline render, WSOLA stretch, WAV encoder. Demo-owned
  until proven, matching how audio tracks were introduced.
- **Additive `TransformTrack` mode** (timeline v10 / rig v12) so keyframed
  corrections layer over an `AnimationMixer` instead of erasing it. Director call
  order is already correct (`demo-scene-viewport.tsx:813-816`).
- **`extractPeaks` / `slicePeaksToWindow` to `core`** — pure and dependency-free,
  currently stranded in the demo. Lowest priority.

Landed as `AudioClip.rate` / `AudioClip.stretch` (timeline v9, rig v11),
`TransformTrack.additive` (timeline v10, rig v12), `core/audio-peaks.ts`, and four
demo modules: `audio-graph.ts` (the shared builder), `audio-stretch.ts` (WSOLA),
`audio-bake.ts` (offline render + WAV), and a rewritten `audio-player.ts`. Package
tests 216 → 230, demo 46 → 74. Measured in Chrome: onsets land sample-exact with the
attack intact, mixdown RMS matches prediction to four decimals, stretch holds 440Hz
through the whole path, and an additive track over a real `AnimationMixer` reads
`[5, 3]` where the same track without the flag reads `[0, 3]`.

Deferred with reasons: **glTF animation export** (corrections became authorable and
visible; how they leave the tool is a separate piece) and **alternate sources**
(random or cursor selection is stateful, so it cannot live in `evaluateAudio`
without breaking the pure-function-of-`t` guarantee scrubbing rests on — if it
returns, selection sits outside the evaluator).

Still open: WSOLA versus a phase vocoder is provisional and wants a listening test on
real gunshots and foley; the mixdown defaults to the source rate at 16-bit PCM, which
may want revisiting for a mixed-rate library.

### ✅ Demo timeline tracks — GLB clips, keyframed transforms, gizmo, portability (DONE — 2026-07)
Four authorable track kinds, now promoted into the package's versioned timeline
schema alongside camera/cart/event. Each has a package-owned pure `evaluate(t)`;
the object-bound kinds also have reusable Three.js directors:
- **Activation** — object visibility over clip windows (`ActivationTrackDirector`).
- **Audio** — 2D clips, forward-play only (`AudioTrackPlayer`, `audio-player.ts`).
- **Animation (GLB)** — a loaded GLB's baked clips (`GltfActivatable` + `AnimationTrackDirector`).
  Loads via drei `useGLTF`; a bundled CC0 Fox lives in `public/Fox.glb`. Per-clip loop/once;
  overlapping clips crossfade with complementary weights. Actions remain playing while
  explicit local times are applied before `mixer.update(0)`, keeping blends scrub-safe.
- **Transform** — keyframed position/rotation/scale for any object, no baked clip
  (`TransformTrackDirector`). Position/scale eased-lerp; rotation shortest-arc **slerp** from
  Euler-degree keys. Composes with GLB clips (a clip walks the skeleton while a transform
  track moves the root).

Authoring: the shared combined move/rotate/scale **`TransformGizmo`** (Shots mode only) →
"key pose @ playhead" snapshots the pose into keyframes. Placement lives on each
activatable's registered **group** so the gizmo, director, and registry all drive the same node
(selection bounds measure in that group's local frame). Both mesh + transform directors restore
to base/bind pose on leave; new-key defaults seed from the current pose (so keying never jumps).

**Portability DONE (2026-07):** timeline schema v4 and RigDocument schema v4 carry
`activation`, `audio`, `animation`, and `transform` tracks directly. Pure evaluators
ship from `/core` and `/timeline`; `ActivationTrackDirector`, `AnimationTrackDirector`,
`TransformTrackDirector`, and `ObjectBindingRegistry` ship from `/three`. The demo now
consumes those APIs and exports typed tracks inside its show timeline. Import retains a
one-way compatibility path for legacy `x-demo-tracks` files.

Intentionally host-owned: GLTF fetching/component lifecycle, Web Audio asset decoding,
waveform generation, inspectors, hierarchy, and selection UI. These depend on application
loading and authoring policy rather than timeline/runtime semantics.

### ✅ Twin integration (DONE — exceeded the spike)
Consumed `@huma/path-creator` from the geospatial twin's `/author` route as a
dolly+timeline scenario type; went past the spike to in-scene editing, server
persistence, and a visitor cinematic (deployed `twin.humatopia.ai`). Friction
captured in `GEOSPATIAL-INTEGRATION-DEBRIEF.md`. **Key learning: the /core edit
model + /timeline reused cleanly; the /r3f editor UI could NOT render in the
consumer's WebGPU renderer (drei fat lines) — the #1 thing to fix (debrief P0).**

### P0 — WebGPU-safe rendering (the `RigLine` seam)  ·  = debrief P0
**First step DONE.** All package line rendering now routes through `RigLine`
(`src/r3f/rig-line.tsx`), which picks the material by backend: WebGL → drei fat
line (thick); WebGPU → core `LineBasicMaterial` (thin, auto-maps, no
`LineMaterial` device-loss). Wired into `PathVisual` (rails/ties/centre) and
`PathEditor` (sibling dashed); `CartGizmo` uses core `EdgesGeometry` instead of
drei `<Edges>`. Policy this pass (decided with the user): **thin-but-safe on
WebGPU, thick on WebGL.** drei stays an *optional* peer, touched only on the
WebGL branch — the seam localizes every follow-up below to one file.

Follow-ups:
- **Node-material thickness on WebGPU (DEFERRED — not a small change).** RigLine's
  WebGPU branch + the gizmo's `PivotLine` render thin. Fat lines need
  `Line2NodeMaterial`, which lives in `three/webgpu` — a renderer-agnostic package
  can't import it without pulling the WebGPU build into every consumer (breaks
  WebGL-only consumers and the CJS build). Needs a conditional/dynamic-import seam or
  a peer-optional `three/webgpu` split first. Thin-but-safe is the consistent policy
  until then. Dashed lines are likewise dropped on the WebGPU branch.
- **Drop drei for lines entirely.** Replace the WebGL branch's drei `<Line>` with
  `three/addons` `Line2` so lines need *zero* drei (drei fully optional, not just
  peer-optional) — the "graceful fallback with no drei" goal.
- **Pluggable, WebGPU-safe gizmo (debrief P0.2).** *DONE — full combined gizmo.*
  `RigGizmo` (`src/r3f/rig-gizmo.tsx`) — `RigGizmoComponent` interface + `PivotGizmo`
  (drei, WebGL default) + `TransformGizmo`. **First tried stacking two three
  `TransformControls` (translate+rotate); abandoned** — the rotate gizmo's invisible
  free-rotate sphere (`XYZE`) overlaps the translate arrows and mis-grabs constantly.
  `TransformGizmo` is now a **vendored fork of drei PivotControls** (`src/r3f/pivot/`)
  with the one WebGPU liability swapped out: its fat `LineMaterial` axis/ring lines
  (drei `<Line>`/three-stdlib) are replaced by `PivotLine` (a thin `THREE.Line` +
  `LineBasicMaterial` via `<primitive>`), and the rotator's fat invisible hit-line by
  an invisible `TubeGeometry` proxy. Everything else (per-handle mesh pickers → no
  mis-grab, `fixed` screen-constant px sizing, `onDrag(local, deltaLocal)`,
  disable* props) is drei's, unchanged. Gives the full move+rotate+(plane)+scale
  gizmo. Both `PathEditor` and `PointTargets` inject it; validated on WebGPU (Metal-3):
  arrow=translate / arc=rotate cleanly isolated, anchor-rotate swings control handles,
  screen-constant, no device loss. WebGL keeps drei PivotControls (fat lines).
  Notes: lines are thin on WebGPU — see the deferred fat-line item below. When drei v11
  (WebGPU) ships stable, this fork can be dropped for `@react-three/drei/webgpu`.
  Midpoint normal-rotation pivot now also routes through the seam (rotation-only via a
  new `disableTranslation` prop → `disableAxes`+`disableSliders`); its WebGPU gate is
  removed, so rotation works on WebGPU everywhere. That closes the last gizmo gate.
- **Glyph-geometry churn on WebGPU — FIXED.** Clicking an anchor lost the WebGPU
  device (`DrawIndexed(168)`, "vertex buffer slot 0 not set"). Root cause: PathEditor's
  handle rings/circles changed their `ringGeometry`/`circleGeometry` **args** (and
  mounted/unmounted the highlight ring) on selection, so three's WebGPU backend
  disposed/recreated GPU buffers mid-frame and drew with an unbound vertex buffer.
  Fix: constant geometry args for every glyph; selection/scale now via mesh `scale` +
  material `opacity` (matrix/uniform updates, no buffer churn). Rule for this package:
  **never vary a mesh's geometry `args` per-interaction on a WebGPU render path — vary
  scale/opacity/color instead.**
- **WebGPU-safe text/labels (RigLabel).** *DONE.* troika `<Text>` doesn't crash on
  current three but renders a silent garbage white quad on the WebGPU node renderer
  (its SDF atlas doesn't sample there). `RigLabel` (`src/r3f/rig-label.tsx`) draws the
  text to a 2D canvas on a camera-facing Sprite (SpriteMaterial auto-maps both
  backends); PathEditor anchor numbers, CartGizmo, and VirtualCameraGlyph all route
  through it, and the WebGPU label gates are removed. Validated rendering real glyphs
  on WebGPU (Metal-3) and no WebGL regression. (PointTargets has no label; its gizmo
  routing is the remaining seam item below.)
- **WebGPU validation example (debrief P0.3).** *DONE.* `examples/webgpu-check` now
  mounts the full `PathEditor` under `WebGPURenderer` and is render + select + drag
  interactive (validated headless & headed on Apple Metal-3 via a Playwright oracle
  driving system Chrome). Labels/midpoint pivot gated off pending RigLabel. Note: the
  package DIST must be rebuilt for the example to pick up changes (a stale dist with
  ungated troika text is what first surfaced the device-loss chain).

### 3c-4 — extract the drive-loop into the package  ·  = debrief P1.1
**DONE.** The per-frame orchestration is extracted and framework-agnostic:
`driveTimeline` (`/timeline`) steps the player → `evaluateTimeline` → publishes cart
frames → parks the pose + runs the composer; `driveActivation` + `createRigDriveState`
(`/three`) hold the shared brain + composer state; and **`driveRig(state, camera,
intent, dt)` (`/timeline`)** dispatches idle/timeline/activation with one call. The
r3f `useRigDrive` (`/r3f`) is now a thin `useRef`+`useCallback` wrapper over `driveRig`
— so a non-r3f runtime (headless render, elastiq) drives the rig identically with its
own camera + loop, no r3f. The demo consumes `useRigDrive`; the twin can drop its
hand-written `PathRigDriver.useFrame`. `applyScreenComposerAim`/`getScreenCorrection`
already moved to `/three`; `vcamTrackTargetId` already in `core/virtual-camera.ts`.

Remaining 3c-4 cleanup: *none.* The composer-config reconciliation is DONE —
`ScreenComposerOptions` is gone; the composer consumes flat `ComposerSettings`
throughout (no consumer-side flat→nested mapping).

### Camera bodies — orbit + manual override DONE; follow / positionCompose deferred
**Orbit body DONE.** A pure `orbit` body (`azimuth/elevation/radius`
+ `autoOrbitDegPerSec` advanced from the resolve clock, so scrub-safe) with three
binding modes — `world` (compass-anchored), `lockYaw` (follows target heading, level
horizon), `lock` (welded) — resolving in `resolveVirtualCameraDefinition` (`/three`).
Target orientation flows through `getTargetOrientation` on the resolve context, backed
by `TargetRegistry.resolveOrientation` + `registerObjectTarget` (pulls world quaternion);
target-relative binding degrades to `world` when orientation is absent. Shared placement
helpers (`orbitOffset`/`orbitParamsFromLocalOffset`/`orbitBindingQuaternion`/
`buildOrbitRingPoints`) back both resolution and the `OrbitVcamGlyphRig` authoring/debug
gizmo (ring + radius arm + binding-frame triad + camera glyph + translate handle). The
minimal demo authors orbit bodies against a spinning turbine target. Covers the twin's
overview (world) and detail (lockYaw) wind-turbine views. Model = body (position) + aim
(orientation) independent, per Cinemachine's Position/Rotation-Control split.

**Manual override DONE — unified pivot-orbit, any vcam** (the twin's OrbitControls model).
`control: CameraOverrideSettings` lives on the vcam **definition** (not the body), so any
shot — `static`/`cart`/`orbit` — can be flown: **LMB** orbit azimuth/elevation around a
pivot, **RMB** pan the pivot (re-frames), **wheel** damped dolly (min/max clamp), per-axis
`locked`/`free`/`recenter`. The pivot is the aim target → orbit target → a synthesized
point-in-front. Resolution stays pure: `stepCameraOverride` + `resolveCameraPivot` are a
stateful post-stage (`RigBodyState` in `RigDriveState`, mirroring `stepComposerAim`) that
decomposes/recomposes the coded pose around the pivot; exact passthrough when idle, owns
pose+aim (composer skipped) when live. **Both** drivers apply it — `driveActivation` and
`driveTimeline` (on the active block, skipped mid-blend) — so piloting works under an
activated shot and under timeline playback. Input mapping is **promoted to the package**:
`createOverrideInputAccumulator` (`/three`, framework-agnostic pointer/wheel → override) +
`<CameraOverrideSurface>` (`/r3f`, transparent capture layer owning pointer/wheel). The twin
mounts the surface while a vcam is live, disables its own OrbitControls, and passes
`accumulator.drain()` as the drive intent's `overrideInput` — no re-implementation. Matches
the twin's manual-override + return-to-coded orbit, not a regression of it.

**Deferred (planned):** the `follow`/third-person body, the `positionCompose` body, and
binding-frame **position damping** (smoothing the camera toward a *moving coded target* —
distinct from the manual override; the `RigBodyState` channel can host it). Research
synthesis, architecture, task breakdown, risks, and alternatives:
[the deferred-camera-bodies plan](../plans/2026-07-06-deferred-camera-bodies-v1.md).

**Not promoted (deliberate):** the demo's edit/play `viewMode` + camera-swap compositor +
OrbitControls gating are app-shell — the twin has its own shell (OrbitControls, PiP,
path-rig gating), so imposing one isn't wanted. The reusable seam is the override + input
surface + drive `overrideInput`, which *is* in the package.

### F3 — dolly motion as an editable speed curve
Replace discrete dolly move-blocks with a per-dolly **motion curve** (keyframes of
position-over-time on the dolly lane): flat = parked, sloped = moving, curve shape =
speed/accel/damping. Simpler mental model ("the dolly's journey") and the natural home
for fine speed control. Data is already cart-track keys, so this is a UI/authoring change,
not a data rework. Decision (this session): don't invest further in the block UI; do the
curve here. Needs a custom curve-editing lane (the current @xzdarcy lane does blocks/actions,
not 2D keyframe curves).

> Shares the @xzdarcy dependency risk called out in debrief **P2.2** (multilane
> timeline reuse): the same limitation (blocks/actions, not 2D curves) plus its
> unmaintained transitive `react-virtualized` argue for a lighter in-house lane —
> do F3's curve lane and P2.2's reuse together.

### Scroll-driven timeline (scrollytelling demo)
A demo where **page scroll scrubs the timeline**: scrolling down advances `t`,
scrolling up rewinds — carts move, cameras cut/blend, and views change as the
reader scrolls, for a scrollytelling narrative. Cheap by construction: the
timeline is a **pure evaluator** (`evaluateTimeline(timeline, ctx, t)` is a
function of `t` with no internal clock), so a scroll handler just maps scroll
progress → `t` via `seekTimelinePlayer` (scrub semantics, no event double-fire)
and drives a frame — no playback clock needed. Build as a new `examples/`
scrollytelling scene (map `scrollTop/scrollHeight` → `t`, optionally smooth/damp
the mapping so scroll feels inertial). Pairs well with the new follow/orbit
camera bodies for "view changes as you scroll". Consider a small reusable
`useScrollTime` hook in `/r3f` if the mapping proves generally useful.

## Ideas mined from mature peers (Cyango) — presentation/interaction breadth

> **2026-07-17 — concept mining.** Reviewed [Cyango Studio](https://www.cyango.com/docs/studio/editor-basics),
> a mature no-code XR storytelling / virtual-tour editor (Workspaces → Stories →
> Scenes → Entities, plus an Asset Manager, an Actions behaviour system, a
> responsive 2D UI layer, custom code, publish/share, and AI/MCP). Their deep
> feature pages are a client-rendered SPA that couldn't be scraped past one-line
> intros, so specifics below are inferred from their documented section structure
> (getting-started, core-concepts, scenes, entities, assets, ui, actions,
> custom-code, publish-share, ai-agents-mcp), their core-concepts page, and their
> origin-story blog — treat item details as candidates, not committed specs.
>
> Framing: **we are deeper than Cyango on cinematography** (vcams, blends, dollies,
> orbit, tracking targets, pilot override, first-class easing, the bezier keyframe
> curve editor, deterministic scrub-safe timeline). They are **broader on everything
> around the camera** — interaction, structure, UI, delivery. These items take that
> breadth *toward the "author & deliver 3D scenes as presentations" + interactive
> **inspection** vision* (see the inspection handover plan under `docs/plans/`), not
> toward our motion core. All are candidate pillars, ordered by leverage.

### Tier 1 — structural, high leverage (advance the interactive-presentation vision)

- **Actions / trigger→action system (the keystone).** A declarative behaviour layer:
  *event types* (click / hover / proximity / timeline-marker / scene-enter / load) →
  *action types* (jump-to-vcam, play / pause / seek the timeline, goto scene,
  show / hide entity, play media, start inspection) with *conditions* and both
  *entity actions* and *scene actions* (Cyango's model). Turns our **linear** timeline
  into **interactive** presentations and cleanly wraps the inspection primitive
  (inspection becomes just another action). Fits the pure-evaluator model: actions are
  effects dispatched at `t` or on input, not new clock state. This is the single
  biggest lever; most other items below compose with it.
- **Multi-scene "Story / Deck" container + navigation.** We have one rig / one timeline
  ("one show"). A presentation product needs many scenes ("slides") with authored
  transitions and next / prev / jump navigation, plus **camera hand-off between
  scenes**. Concept: a Story document wrapping N rig-scenes + a transition/navigation
  spec. This is the "slides" half of the vision made structural; the Actions layer
  provides the `goto scene` verb. Pairs with a shared Asset Manager (below).
- **Interactive hotspots / world-anchored annotations.** Today's Targets are aim points,
  not interactive. Add a **Hotspot entity** — world- or object-anchored clickable point
  bound to an Action (focus camera, open info panel, next scene, *start inspection*).
  Directly realises the inspection plan's "mark objects / sub-regions as inspectable,"
  and is the concrete authoring UI that makes Tier-1 actions + scene nav usable.

### Tier 2 — authoring surface / delivery

- **2D UI overlay layer (responsive).** Cyango's Elementor/Webflow-style flexbox +
  breakpoint 2D UI. We have none. For presentations: title cards, captions, nav
  controls, progress, info panels — bound to Actions and the timeline, responsive for
  the mobile-orientation input path the inspection plan already wants. Demo-owned
  first, with a promotion path to a package "overlay" schema (keep library-first per
  the demo-must-not-cap-library rule).
- **Asset Manager (reusable asset library).** We import GLBs ad hoc and decode audio
  per-clip. A registry (id → source + metadata + cached decode / peaks) referenced by
  tracks and entities, reused across scenes; enables dedupe, preload, and a media
  browser. Prerequisite for shared assets across the multi-scene Story.
- **Decoupled embeddable viewer / player + publish-share.** We export/import JSON and
  have the demo + the deployed twin. Formalise a runtime **player with no editor deps**
  plus a share-link / embed flow — the "deliver" half of the vision. Low-risk given the
  twin already consumes `/core` + `/timeline` cleanly (see the twin integration note
  above and the debrief).

### Tier 3 — reach / ecosystem

- **MCP server for rig authoring (AI-assisted choreography).** Cyango ships AI agents +
  MCP; we already run inside Claude Code with MCP infrastructure. Expose rig authoring
  over MCP (create path, add vcam, keyframe, "generate a camera move from a prompt") for
  AI-assisted camera choreography — on-brand for this environment and differentiating.
  Worth a spike before committing.
- **Variables / state + conditions (logic layer).** For branching / conditional reveals
  (guided paths, quizzes, progressive disclosure): a small variable/state model with
  conditions on Actions. A later extension of the Tier-1 Actions system, not standalone.
- **Editor maturity: undo/redo command stack + entity parenting.** Cyango's editor
  basics list undo/redo and hierarchy parenting. We have autosave but no robust undo,
  and transform tracks bind to registered groups without general parent-space nesting.
  A command/transaction model over the rig document (table-stakes with the gizmo +
  curve-editor direct manipulation) and scene-graph parenting (animate a child in parent
  space) broaden what's authorable. Maturity items, not vision-critical.

## Known gaps / smaller items

- ~~**Conditional: smooth Web Audio gain automation if crossfade artifacts are observed.**~~
  **RESOLVED (2026-08-08) as a side effect of the audio scheduler.** The concern was that
  the player applied the evaluated gain once per render frame, so a crossfade advanced in
  frame-sized steps and could zipper. Gain is now scheduled as a sampled value curve
  (`setValueCurveAtTime`) taken from `evaluateAudio` itself, at 20Hz minimum and
  interpolated by the audio hardware — so the envelope, the automatic crossfade and the
  track gain all arrive as continuous automation rather than per-frame steps. Nothing was
  added preemptively; it fell out of scheduling.
- Legacy migration: pre-RigDocument saved shows (old `SHOW_STORAGE_KEY`) do NOT migrate
  dolly moves into per-dolly runs (edge case; only affects saves made before this session's
  storage change). Shots/paths/targets still migrate.
- ~~Dolly `speed` is global~~ **DONE (demo).** Each dolly now carries its own free-run
  `speed` (per-cart), authored via a per-dolly slider in the Dollies section and threaded
  into each cart's `createPathCart({ speed })`. Uses `RigCartDefinition.speed`, which always
  supported it; the demo previously collapsed it to one global value.
- The demo `TrackingTargetDefinition` group variant isn't authored (`SceneTarget` excludes it);
  target groups (weighted multi-subject framing) are unimplemented in the demo UI.
