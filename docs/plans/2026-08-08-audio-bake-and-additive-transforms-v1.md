<!--
Purpose: Phased implementation plan for per-clip time/pitch control (rate +
pitch-preserving stretch), a shared audio graph builder serving both live preview
and an offline mixdown bake, and an additive transform mode so keyframed
corrections can layer over baked GLB animation instead of overwriting it.
Scope: Packages/path-creator (core/three) + examples/minimal-r3f-demo.
-->

# Audio bake + additive transforms

> **Status: all five phases executed, 2026-08-08.** Package tests 216 → 230, demo
> tests 46 → 74. Lint, build and typecheck clean. Verified in Chrome against real Web
> Audio, not only against mocks — see "Verification" below.

## Objective

Close four gaps surfaced by dogfooding `@huma/path-creator` from an external
consumer — a weapon-animation audio tuning tool that stacks several sounds over a
long reload animation with individual lengths, pitches and volumes, and needs
corrective bone offsets over baked animation.

The consumer's pipeline is **author here, bake to files, ship the files**. The game
does not run the timeline. That framing decides most of what follows: the timeline
document is a project file consumed by a baker, not a runtime format consumed by a
game.

## Decisions taken (2026-08-08)

Settled in discussion before any code. Recorded because several reverse an earlier
reading.

| Decision | Choice |
| --- | --- |
| Pitch/time control | Constant per-clip `rate` **and** pitch-preserving `stretch` |
| Rate animatable? | No — constant per clip |
| Audio export shape | **Mixdown per sequence** (one file per scene) |
| Animation export | **Deferred** — additive authoring lands, glTF writing does not |
| Alternate sources | **Deferred** |
| Editor preview | Must match the bake sample-for-sample |
| Live playback | Retire the per-frame reconciler for a **scheduler** |
| Bake code home | **Demo first**, with a promotion path |
| Schema versioning | One bump per feature |

Two reversals worth flagging:

- **`stretch` was initially argued out of scope** on the grounds that
  pitch-preserving stretch needs an offline pre-render that `core` cannot perform.
  Once the product is a bake, everything is an offline pre-render and the objection
  is void.
- **The trigger/scrub gap was initially framed as a runtime API need** (a pure
  onset query in `core`, for a game triggering sounds from the timeline). With the
  game consuming baked files, runtime triggering does not exist. The defect
  survives only as an editor-preview fidelity problem, and is fixed demo-side with
  no package API.

`alternates` were deferred partly on cost and partly on a genuine conflict: random
or cursor-based selection is stateful, so putting it inside `evaluateAudio` would
break the pure-function-of-`t` guarantee that makes scrubbing deterministic. If
alternates return, selection must sit outside the evaluator.

## Context and findings

All measured against `de36994`, not speculative.

### 1. No pitch or rate exists anywhere

`DesiredAudio` (`core/timeline.ts:297`) is exactly `{ src, offset, gain, loop }`.
No rate, detune or stretch field exists in the package or the demo.

### 2. Clip starts are decapitated by frame timing

`evaluateAudio` computes source position as `clip.offset + t - clip.start`
(`core/timeline.ts:329`). The player then calls `source.start(0, offset)`
(`audio-player.ts:160`) — start *now*, seeking into the buffer by however far past
the clip's start the frame landed.

A clip starting at 2.000s with frames at 1.994s and 2.011s begins playing 11ms into
the file. Those 11ms never play. The sound is not late; it is missing its head, and
by a different amount every trigger, so the attack timbre varies shot to shot. At
60fps the loss is 0–16.7ms, at 30fps 0–33ms. The consumer tunes at 10ms, so the
error exceeds the adjustment.

`RESYNC_TOLERANCE_SECONDS = 0.3` (`audio-player.ts:9`) is a separate and much
milder issue. Tightening it is the wrong fix — a resync is a stop-and-restart, so a
tighter tolerance buys drift correction with audible restart clicks.

### 3. `TransformTrackDirector` overwrites, so it cannot layer

It writes absolute values via `object.position.fromArray(...)` and
`object.quaternion.fromArray(...)` (`three/object-tracks.ts:105`) and snapshots a
`base` pose once on first drive (`:99-102`). Pointed at a bone already driven by an
`AnimationMixer` it erases the animation, and the `base` snapshot captures whatever
frame happened to be showing. This blocks bone correction entirely.

Call order is already correct: `mixerDirector.sync` runs immediately before
`transformDirector.sync` (`demo-scene-viewport.tsx:813-816`), so an additive mode
composes over the mixer's output with no reordering.

### 4. `extractPeaks` is stranded in the demo

`audio-peaks.ts:9` is pure and dependency-free but lives where no consumer can
import it. The rest of that file — decode caching, blob import — duplicates what a
consumer already has.

### 5. Migration is nearly free

`migrateRigDocument` (`core/rig.ts:128`) only re-stamps version numbers. Every
schema addition so far has been an optional field, so no per-field transform is
needed. Adding an optional field later costs exactly what adding it now costs —
which is why reserving fields ahead of their implementation buys nothing.

### 6. No bake machinery exists

The only export is `downloadStory` (`scene-storage.ts:26`), writing the scene JSON.
`OfflineAudioContext` appears once, in `audio-peaks.ts`, and only to decode for
waveforms. There is no glTF exporter. The renderer, encoder and stretch algorithm
are all new.

## Design

### The scheduler, and why it replaces the reconciler

Choosing a mixdown makes the bake an `OfflineAudioContext` render across the
scene's duration: each clip becomes a buffer source through a gain node, started at
an exact time with an exact in-point, then encoded to WAV.

That is the same graph the live preview needs. The only differences are which
context is built into and what time counts as zero. Two implementations of one
behaviour would drift — precisely what "preview must match the bake" forbids. So
there is **one builder, called twice**:

```
buildAudioGraph(context, tracks, { timeOrigin, startAt })
```

Live preview passes an `AudioContext` and the current transport time; the bake
passes an `OfflineAudioContext` and zero. The single branch between them: live
cannot schedule in the past, so a clip already underway starts immediately with a
buffer offset, while a clip ahead is scheduled at its exact future context time
from offset zero — which is what restores the missing attack.

Consequences:

- `RESYNC_TOLERANCE_SECONDS` and the drift-correction path are deleted.
- Per-frame audio work leaves the render loop.
- Rescheduling is required on three events: play, seek, and edits to an audio
  track during playback. The third is cheap — demo track state is immutable, so a
  reference comparison detects it.
- Gain automation (`gainCurve`, adjacent-clip crossfades, track gain) schedules as
  `setValueCurveAtTime`, which `previewClip` (`audio-player.ts:55-62`) already
  demonstrates.

`evaluateAudio` stays exactly as it is. It remains the pure scrub-time evaluator
and the source of truth for gain math; the scheduler consumes clip data directly
because it needs windows, not instantaneous state.

### Additive transforms

A per-track flag, default absolute. Additive semantics:

- position — vector add
- scale — componentwise multiply
- rotation — local-space post-multiply, which is what "the wrist bends five degrees
  *more* than the baked animation" means, and matches Unity additive layers

Per-track rather than per-channel: simpler, matches the layer model, and
per-channel remains available later as a refinement.

The one non-obvious change: the one-shot `base` snapshot is meaningless for an
additive track, since the mixer rewrites the pose every frame. Additive tracks
capture the pre-application pose each frame and re-apply it once on release.

### Stretch

WSOLA first rather than a phase vocoder — simpler, and it treats transients better,
which matters because transients are the material in question. Whether
pitch-preserving stretch suits gunshots at all is then settled by listening to real
baked output rather than argued in the abstract. Gunshots may well want `rate` or
no length change; long foley is where stretch should earn its place.

`rate` and `stretch` do not compose trivially: stretch pre-renders the source to a
new length, after which `rate` applies on top. Bake order is stretch, then rate.

## Phases

### Phase 1 — audio timing schema

Package. Timeline schema 8→9, rig 10→11.

- Add optional `rate` and `stretch` to `AudioClip` (`core/timeline.ts:106`).
- `DesiredAudio` gains `rate`; `evaluateAudio` source position becomes
  `clip.offset + (t - clip.start) * rate`.
- Version-stamp comments in `core/timeline.ts` and `core/rig.ts`; migration is the
  existing re-stamp, no per-field transform.
- Peaks windowing becomes rate-aware — a clip consumes `duration * rate` of source.
- Demo `resizeAudioClip` left-trim math likewise.
- Tests extend `test/timeline.spec.ts` and `src/audio.spec.ts`.

Rate and stretch share one bump: they are one addition landing together.

### Phase 2 — shared graph builder

Demo. No schema change.

- Extract `buildAudioGraph(context, tracks, opts)` from the current player.
- Live playback drives it; the reconciler, `RESYNC_TOLERANCE_SECONDS` and the
  resync path are removed.
- Reschedule on play, seek, and audio-track edits.
- Verify the restored attack by rendering offline and comparing the first
  milliseconds against the source — a real assertion, not a listening test.

### Phase 3 — mixdown bake

Demo.

- Offline render of one scene's audio tracks, honouring mute and track gain.
- WSOLA stretch, applied before rate.
- WAV encoder, roughly forty lines, no dependency.
- Export action alongside `downloadStory`.

"Sequence" reads as one scene, since that is the unit a timeline already describes.

### Phase 4 — additive transforms

Package. Timeline schema 9→10, rig 11→12.

- Per-track additive flag on `TransformTrack`.
- `TransformTrackDirector` applies deltas post-mixer; per-frame pre-application
  snapshot replaces the one-shot `base` for additive tracks.
- Demo inspector exposes the flag.

### Phase 5 — peaks to core

Package. No schema change. Lowest priority; droppable.

- Move `extractPeaks` and `slicePeaksToWindow` into `core`, typed structurally
  against `{ getChannelData, length }` so `core` needs no DOM lib.
- Decode caching, `ensurePeaks` and `importAudioFile` stay in the demo.

## Verification

Unit tests cover the scheduling decisions and the DSP. The claims that only real audio
can settle were measured in Chrome against the running dev server.

**Clip onsets are sample-exact and attacks survive.** Rendering a clip whose start lies
0.5s ahead of the playhead put its first sample at index 24000 of a 48kHz render —
exactly 0.5s — reading source position 0 at full amplitude. Probing with a ramped buffer
(so the sample value reports which point of the source is being read) across four cases:

| case | onset | source position at onset | source consumed per 0.25s |
| --- | --- | --- | --- |
| clip ahead of playhead | 0.5s | 0 | 0.25s |
| clip already underway | 0s | 0.5 | 0.25s |
| ahead, rate 2 | 0.5s | 0 | 0.5s |
| underway, rate 2 | 0s | 1.0 | 0.5s |

**The mixdown is numerically correct.** A three-track render (one muted) matched
predicted RMS on every window: 0.1131 against a predicted 0.1131 for a clip alone,
0.1334 against 0.1333 where two clips overlap, and exact silence in the gaps. WAV byte
count matched the header arithmetic exactly.

**Stretch holds pitch through the whole path.** A clip stretched to double length
measured 440Hz after decode, WSOLA, scheduling and render. The live preview path
produces the same 440Hz and the same 2x length, so preview and export agree.

**Additive transforms layer over a real AnimationMixer.** With a bone animated from
x=0 to x=10 and a `+3` correction on y, the additive track read `[5, 3]` at the
animation's midpoint — the mixer's x=5 preserved, the correction added. The identical
track without the flag read `[0, 3]`, erasing the animation. That contrast is the bug
this phase existed to fix.

**Old documents still load.** A rig at the pre-work version 10, carrying a timeline at
version 8, migrated to 12 and 10 with every clip and transform key intact.

## Constraints

- `core` stays free of Three.js and React imports.
- Demo and example files stay out of the published package.
- Bake code is demo-owned until proven, matching how audio tracks were introduced.
- pnpm only. Build `pnpm -r build`, test `pnpm -r test`, lint `pnpm -r lint`.
- Baseline at plan time: lint clean, 216 package tests and 46 demo tests green.

## Deviations from the plan as written

- **Rate and stretch share one bump** (timeline v9), not one each. They are one
  addition — per-clip source speed — and landed together.
- **`DesiredAudio` carries `stretch` as well as `rate`.** The plan's formula
  (`clip.offset + (t - clip.start) * rate`) predates working through how the two
  compose. Source consumption is `rate * stretch`, so the offset advances by both, and
  a host that pre-renders a stretched buffer needs the factor to index it.
- **`audioClipSpeeds` was added** so the sanitizing rule (non-positive and non-finite
  read as 1) lives in exactly one place, rather than being restated by every caller
  that needs the factors apart.
- **Authoring controls landed with the features**, which the phase list did not name:
  a pitch slider and a speed slider per audio clip, an additive toggle per transform
  track, and a bake button on the audio section.
- **`audioTracksEnd` excludes muted tracks.** Found during verification: a muted lane
  running past the content was padding the exported WAV with silence.
- **A never-running test file was recovered.** `src/extra-tracks.test.ts` did not match
  the demo's vitest include pattern (`src/**/*.spec.ts`) and so had never executed.
  Renamed to `.spec.ts`; its 8 tests pass.

## Open items

- WSOLA versus phase vocoder is provisional, to be settled by listening to baked
  output on both gunshots and long foley.
- Mixdown sample rate and bit depth default to the source material's rate and
  16-bit PCM; revisit if the consumer's library is mixed-rate.
- Alternates and glTF animation export remain deferred, with the determinism
  constraint above governing any future alternates design.
