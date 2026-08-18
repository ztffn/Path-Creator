<!--
Purpose: The browser proof for M1.1 and M1.2 — a real Pascal viewer, a real WebGPU device, a
timeline driving real nodes, and a headless run that reads the numbers back and fails the build
when one misses its bound. Read this to reproduce the measurements quoted in the package README
and in INTEGRATION-DESIGN.md. Scope: verification harness; nothing here ships.
-->

# pascal-time harness

Two commands:

```sh
pnpm --filter pascal-time-harness dev      # watch it, panel top-left
pnpm --filter pascal-time-harness verify   # measure it headlessly, exit non-zero on a miss
```

`verify` rebuilds `@huma/pascal-time` first, starts Vite in-process, drives the page in **system
Chrome** with WebGPU enabled, waits for the probe to finish, and prints every claim with the
number behind it. Pascal's viewer is WebGPU, and Chromium's bundled build is not a trustworthy
stand-in for it, hence `channel: "chrome"`.

## What it sets up

Two plugins, deliberately:

- **`@huma/pascal-time`** contributes `huma-time:timeline`, the clock.
- **This harness** contributes `harness:marker`, a coloured box, from its own manifest with its
  own schema and renderer.

The time layer has never heard of `harness:marker`. That is the point — the central claim is
that time binds by node id and never asks what a thing is, and driving a kind from a *different*
plugin demonstrates it rather than restating it.

Three markers: one driven by a transform track, one revealed by an activation track, and one
named by nothing at all, so "the drive touched only what it should" is measurable.

Three cues, authored as Pascal nodes parented to the clock: `start`, `peak` and `return`. `peak`
sits at t=4, where the transform track has the driven marker at the top of its arc — which is
what makes riding to it a falsifiable claim rather than a demonstration.

Two shots, also authored as nodes: a static `wide`, and a `close` that **orbits the driven
marker by node id** and blends in over two seconds. And drei's real `CameraControls` is mounted
— the same component Pascal's editor uses — because R9 is a rule about what happens when a
controller is present, so measuring it against a stand-in would measure the stand-in.

## What it measures

The probe mounts **inside** `<Viewer>`, so it shares Pascal's frame loop rather than racing it
from a separate animation callback. It then walks the whole lifecycle and records each step on
`window.__pascalTime`:

```
drive 12s → release → ride to a cue → sweep the shots → select → delete → undo → done
```

Last run:

```
frames sampled            1112
sustained rate            47.8 fps
registered node kinds     4
nodes in the document     9
objects in sceneRegistry  6
frames our write was lost 0
worst drift               0.00000 m
undo depth                10 -> 10
dirty nodes               5 -> 5
restored on release       true (0 m)
cues in the document      3
rode to cue_peak in       76 frames -> t=4, marker y=3.4
shots in the document     2 (saw 2 while sweeping)
camera contested frames   0 of 451, worst 0 m
orbit radius held         5 (authored 5.0)
selection resolved to     2 object(s)
delete / undo in registry left / returned
```

22 checks, all passing. The ones worth understanding:

- **"renders" is measured as presence in `sceneRegistry`.** That map is written by
  `useRegistry`, which only runs from a mounted renderer — so an entry proves Pascal's dispatch
  found the kind, resolved its lazy module, and mounted it. Nothing else produces that entry.
- **"deletes" is measured the same way, in reverse.** `useRegistry`'s cleanup runs only on real
  unmount, so the entry disappearing proves the renderer went away, not merely that the
  document changed. Undo brings both back.
- **"selects" goes through `useViewer`**, the viewer's own selection state, and checks that it
  resolved the ids to live objects — a plugin kind the editor chrome would refuse to select
  would fail here even with the capability flag set.
- **Drift** is the pose we wrote last frame against the pose we find this frame. Zero means
  Pascal's render pass never overwrote a timeline write. The original spike measured 1 lost
  frame out of 2220 (the mount); this harness writes after the first mount, so it sees 0.
- **The cue ride checks the scene, not the clock.** Landing on t=4 exactly is the easy half.
  The claim that matters is that the driven marker was at y=3.4 when it arrived — the pose the
  transform track specifies for that instant. A ride that moved the number without moving the
  world would pass a weaker check and fail this one. It also takes ~46 frames, so "it landed"
  cannot be a single-frame snap that skipped the ease.
- **9 nodes, 6 objects.** One clock, three cues, two shots, three markers in the document; the
  same less the cues in the scene, because a cue is a moment rather than a thing and ships no
  renderer. The shots *do* render — they are placed, so they are spatial. This is checked rather
  than reported, and it earned that: adding the shots moved the counts and the check caught it,
  which is exactly what it is for.
- **The camera check runs against the real controller.** 0 contested frames of 451 means the
  camera held the pose the shot resolved to on every frame while drei's `CameraControls` was
  mounted and updating. The spike's contested mode — writing past the same controller — lost
  1229 frames of 1230 and settled the camera on a different shot entirely, so this number is
  the difference between the rule being obeyed and being ignored.
- **The orbit radius is the id-binding claim.** The `close` shot names the driven marker rather
  than storing coordinates, and holds exactly 5.0 from it. Move the marker and the shot
  re-frames it with no timeline edit.

## Frame rate, and one flake worth knowing about

43.8 fps, against the 50 that Pascal's `<FrameLimiter fps={50} />` hardcodes. The gap is
headless-Chrome overhead, not a new ceiling — the cap itself is unchanged and still the reason
not to design around 60 until
[pascalorg/editor#671](https://github.com/pascalorg/editor/pull/671) merges.

The first version of this script was **flaky**: it completed four times and then stalled for the
full timeout with the page loaded and no console errors. Cause: the probe advances on
`requestAnimationFrame`, and Chrome throttles that hard for pages it treats as backgrounded or
occluded. The three `--disable-*-backgrounding` flags in `measure.mjs` fix it — four consecutive
runs afterwards landed within 0.2 fps of each other. A timeout now also prints the last phase and
frame count the probe reached, so a stalled frame loop is distinguishable from a page that never
booted. A flaky gate is worse than no gate; if this starts failing intermittently again, that
diagnostic line is the first thing to read.

## Why some things are absent

- **No `@pascal-app/nodes`,** so Pascal's own 46 kinds are not loaded and `registered node
  kinds` reads 2. Taking `nodes` also takes `@pascal-app/editor` and `next` — see
  `INTEGRATION-DESIGN.md` §11. Nothing in M1.1 or M1.2 needs it.
- **No `@pascal-app/editor`,** so there is no placement tool, gizmo or inspector. The lifecycle
  is exercised through the store and the viewer's selection state instead, which is the same
  machinery the editor's chrome drives.

## The bake mode (`?mode=bake`, M1.3)

The one place this harness's "cannot resolve `/nodes`, `/editor` or `next`" property is not a
limitation but the measurement itself. `pnpm verify:bake` (usually chained from
`pnpm --filter pascal-editor-host verify:bake`, which exports the artifact first) asserts the
resolver claims statically — with a control that the resolver still resolves what IS a
dependency — then loads `/?mode=bake`: Pascal's own `GlbScene` over `public/baked/scene.glb`,
the id→object binding rebuilt from `extras.pascalId` (the same `ObjectBindingResolver`
interface, different source), and the timeline driving the baked column — scrub-exact
([0,3,0] at t=4, [0,0,0] at t=0) with the baked pose restored to 0 m on release. That is §0b's
bake option measured end to end: a Next-free runtime playing a Pascal-authored scene. The
artifact is committed as a fixture; regenerate it from the editor-host side.
