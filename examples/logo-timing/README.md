<!--
Purpose: what this demo proves about TimelineLanes, how the three pieces fit together,
and the one browser behaviour that will bite anyone animating injected SVG from React.
Scope: the example only; the component it exercises is Packages/path-creator/timeline-ui.
-->

# logo-timing

`TimelineLanes` driving something that is not a camera.

The show is a 3.5-second SVG logo intro. Every animated element gets its own lane: a block's
position is that element's delay, its width is how long it takes, and for the two wordmarks
the width is how fast the letters chase each other. Scrub or play to preview, then **Export
timings** to print the edited table back as source.

```sh
pnpm --filter logo-timing dev
```

## Why it exists

It is the first host to use **none** of the component's camera surface — no shots, no dollies,
no rails — and writing it is what turned three module constants into props. Before this demo
`TimelineLanes` could technically render host lanes, but a lanes-only host had to pass ten
no-op callbacks, carry a permanently empty shot row, scroll a twelve-lane show through a
three-lane window, and snap every drag to a quarter second on a show that is 3.5 seconds long.
See the package CHANGELOG for `showShotLane`, `maxVisibleLanes` and `snapSeconds`.

Still camera-shaped, and deliberately left alone: the transport prints a `PiP` status the
`driving` prop feeds, which means nothing here.

## The three pieces

| File | What it owns |
|---|---|
| `logo-timing.ts` | The show as DATA — one record per timed piece — plus the drag/resize semantics and the file export. Pure, and where the tests are. |
| `easing-css.ts` | The bridge from the package's `Easing` model to a CSS timing function. |
| `logo-stage.tsx` | The preview. Builds one PAUSED animation per target and seeks them. |
| `App.tsx` | The clock, the lane wiring, and the export panel. |

## Two things worth knowing

**Nothing plays.** The original intro schedules itself with `setTimeout`, which a scrubber
cannot address. Here every animation is created paused with the original delay folded into the
WAAPI `delay`, and seeking sets `currentTime` on all of them. The browser still does every
interpolation, so easing curves and transform stacks are Chrome's own rather than a
reimplementation — but the timeline owns the time. `fill: "both"` is load-bearing: backwards
fill holds a piece off-screen before its delay, forwards fill keeps it placed afterwards.

**The artwork is injected imperatively, not through `dangerouslySetInnerHTML`.** This component
re-renders whenever the playhead publishes a new time, and a re-rendered innerHTML subtree is a
*replaced* subtree — every animation on an SVG group vanishes while the React-owned wrapper divs
keep theirs. The symptom is that only the shake and flash lanes appear to work, which reads as a
timeline bug rather than a React one.

## Editing several lanes at once

Timing an intro is mostly moving groups, not single blocks, so the component grew a
selection: drag across empty track to rubber-band, shift-click to add or remove one, click
empty track or press Escape to clear. Dragging any selected block moves the whole set by one
delta with the gaps preserved, and the arrow keys nudge it (shift for ten steps). Every
gesture reaches the host as ONE write through `onExtraClipsTiming`, so a nine-block move is a
single undo step rather than nine.

The two header buttons are the operation you actually reach for most: ripple. They shift
everything starting at or after the playhead, which is how you buy 100 ms for the dagger
without selecting the eight things that follow it. That is `rippleClips` from the package —
the arithmetic is exported, the button is the demo's.

## Easing

Selecting a lane opens the package's `EasingEditor` beside the stage, bound to that piece's
curve — timing is only half of what makes an intro land, and "the dagger should hit harder"
is a curve change, not a delay change.

The model carries the package's own `Easing` value and resolves it to CSS at the edge
(`easing-css.ts`), because `Element.animate` takes a CSS timing function and `Easing` is a
preset name or a multi-anchor curve. A single cubic-bezier keeps its exact CSS spelling;
anything else is sampled into CSS `linear()`, which can express a curve with more than one
inflection that no single cubic-bezier can. The panel shows which form the export takes.

Worth knowing: the package's `easeIn`, `easeOut` and `easeInOut` presets are its own
polynomials and differ from the CSS keywords of the same name by up to 0.069 of progress —
measured, and pinned by a test. Mapping them onto the keywords would render a curve the
editor never drew, so only `linear` is spelled directly and the rest are sampled.

## Resizing a stagger

Widening a wordmark lane keeps each letter's own 200 ms pop and spreads the **step** between
letters. That is the control you want on a wordmark: how fast the letters chase each other, not
how long one letter takes. A lane with a single target has no stagger, so its width is simply
its duration.

## Where the numbers go

**Export timings** shows the JSON and **Download JSON** saves `logo-timing.json`, which is
what `tools/logo-video/render-logo-intro.mjs` in the distantfront project reads — it renders
this same SVG to video offline, and derives both the picture and its procedural score from
that file, so retiming a piece carries its sound along. Drop the download at
`design/logo/animated/logo-timing.json` and re-run the renderer.

It emits JSON rather than pasteable source for a reason worth keeping: the first version
printed a `var T = { … }` literal, and piece ids contain hyphens, so every key was an
unquoted identifier and the output did not parse at all. A data file also means the renderer
holds no second copy of the timeline to drift from this one.

The artwork here (`distant-front-logo.svg`) is a copy of that project's
`design/logo/animated/` source; the element ids are the contract the timing model addresses,
so renaming one silently drops its lane.
