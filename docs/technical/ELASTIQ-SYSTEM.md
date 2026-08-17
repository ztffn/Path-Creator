<!--
Purpose: The system design for elastiq — a 3D authoring and presentation platform assembled
from three parts: Pascal (space), @huma/path-creator (time), and elastiq (narrative and
delivery). Defines what the one system is, what each part owns, the seams between them, the
document format, and the build sequence. Read this before INTEGRATION-DESIGN.md, which holds
the detailed ownership rules this doc summarises. Scope: cross-repo product architecture.
-->

# elastiq — the system

**Status:** design, agreed in outline. Sections marked *decided* are settled; *open* means it
needs a call before the work it gates. Written 2026-08-17 after a spike that measured the
Pascal/path-creator seams end to end (`examples/pascal-spike`) and a survey of elastiq's current
implementation and docs.

---

## 1. What we are building

**A tool where people build a space, give it time, and deliver it as a navigable presentation.**

Not a model viewer with slides attached. Not a slide deck with a 3D background. A 3D authoring
environment whose output is hypermedia: a space you move through, narrated, on the web.

Three properties define it:

- **Anything can be built.** The scene vocabulary is extensible by plugin. Forty-six kinds ship
  today — walls, slabs, roofs, stairs, ducts, columns, fences, solar panels — and anyone can add
  more without touching the core. The ceiling is what people write, not what we shipped.
- **Anything can move.** Time is a layer over the scene that binds to objects by id. It does not
  know what a wall is, so it animates walls, imported models, and every kind written in the
  future, equally and for free.
- **Anything can be presented.** A narrative graph addresses moments in that world. The audience
  moves through branching paths; the world moves under them.

The bet is that these three have never been in one tool. Editors have space. Motion tools have
time. Deck tools have narrative. This has all three, and the extension point runs through all
three at once.

---

## 2. The three parts

| Part | Owns | Repository |
|---|---|---|
| **Pascal** | **Space** — what exists, where, parented how, made of what | `pascalorg/editor` (MIT) |
| **path-creator** | **Time** — when things move, appear, sound, frame, fire | `@huma/path-creator` |
| **elastiq** | **Narrative and delivery** — slides, graph, hypermedia, publishing | `humatopia-frontend` |

### 2.1 Pascal is the editor — all of it *(decided)*

Taken whole: core, editor, nodes, viewer. The architectural kinds are capability, not ballast —
they are the difference between placing models and authoring a world. Its plugin contract is the
extensibility promise, and it is real: node kinds contribute schema, renderer, placement tool,
inspector and click behaviour, with no separate internal API. Third-party packs already exist
upstream.

**What it gives us that we would otherwise build and get wrong:** stable node identity, real
parenting, undo that is expressible, schemas with migrations, gizmos, placement tools, snapping,
selection, an inspector derived from schema, and an MCP server.

**Verified cost:** it is pre-1.0 and moves daily; its editor is inseparable from its viewer (139
import sites); `three@0.185` is a hard floor; and consuming it outside Next needs a
`process.env` shim.

### 2.2 path-creator is time — and Pascal has none *(decided)*

Pascal has no clock, no timeline, no animation. Forty-six node kinds, none of which can move.
Its only animation surface bakes door swings into an exported GLB as a special case.

That is the contribution, and its size is the point: **we are not adding camera paths for
slides, we are adding a dimension to a 3D editor that lacks one.** A wall that builds itself. A
machine that runs. A roof that lifts. Every kind that exists and every kind anyone writes later,
because the timeline drives objects by id and never asks what they are.

Delivered **as a Pascal plugin**, not a fork. Shots, cues, tracks and hotspots become node kinds
alongside walls and slabs, authored in the same editor, inspected by the same inspector.

### 2.3 elastiq is the product *(decided)*

The deck, the graph, the slides, the HTML hypermedia, the presenter tooling, publishing, and the
audience-facing runtime. It is what people actually use and what the audience actually sees.

Its existing strengths stay: the branching graph, the presenter panel on a second screen, the
markdown-first slide with composable layers, the agent-authored deck pipeline.

---

## 3. The core concepts

Five nouns. Everything in the system is one of these.

**Scene** — a Pascal node document. Objects in space, each with a stable id. Owns geometry,
placement, hierarchy, materials.

**Timeline** — a pure function of `t` over one scene. Tracks bind to nodes **by id**. Contains
camera shots, transforms, visibility, animation, audio, triggers.

**World** — a scene plus its timeline. The unit several slides can share. This is what
elastiq's long-dead `sceneGroup` field was reaching for.

**Cue** — a named timestamp in a timeline. The address a slide points at. Slides call these
moments; authors call them slides.

**Slide** — an elastiq graph node. Carries its hypermedia content, a world reference, and a cue.
**It does not carry a scene.**

---

## 4. The seams

The whole architecture is two references.

```
   Scene (Pascal)                Timeline (path-creator)         Deck (elastiq)
   ──────────────                ───────────────────────         ──────────────
   nodes: { id -> node }         tracks: [{ objectId, … }]       nodes: slides
   parentId hierarchy            shots, cues                     edges: navigation
          │                              │                              │
          └────── node id ───────────────┘                              │
                                         └────────── cue ───────────────┘
```

**Space meets time at a node id.** A track names the object it drives; it never holds geometry.

**Time meets narrative at a cue.** A slide names a moment; it never holds scene contents.

Two hops, each owned by the layer that should own it. Rearranging the scene cannot break a
slide. Re-timing the narrative cannot break the scene.

The detailed ownership rules — nine of them, each with the reason and the measurement behind it
— are in **`INTEGRATION-DESIGN.md`**. The ones that matter most here:

- The time layer never creates, deletes or reparents scene nodes.
- The time layer writes to live objects, never to node data. *(Measured: 2220 frames of driving
  moved Pascal's undo depth and dirty-node count by zero.)*
- Node ids are a contract. A change that re-mints them breaks every timeline referencing them.
- Anything with an authored position is a scene node — including hotspots, cues and cameras.

---

## 5. How narrative and time fit together *(decided)*

Elastiq's deck is a **graph**, not a sequence — slides are nodes, arrow keys follow edges by
direction, and branching is the documented product thesis. A timeline is a line. These reconcile
cleanly once you assign them different jobs:

> **The graph decides where you can go. The timeline decides what the journey looks like.**

Following an edge **rides the clock** from this slide's cue to the target's, eased. Because the
timeline is a pure function of `t`, animating `t` moves the camera, the objects, the audio and
anything else, together, with no separate transition system. Backwards is the same code path.

**Consequence to author around:** in a graph deck the timeline is an *address space*, not a
playback order — two edges out of a slide lead to two different timestamps. The convention that
makes this feel like a journey rather than a scrub: **lay the primary path out monotone in time,
so the main narrative plays as one continuous forward motion, and branches jump.**

**In-slide steps fall out for free.** A step is a cue at finer grain. Advance-slide and
advance-step become one verb at two granularities — which finally gives elastiq's vestigial
`buildStep` something to mean.

---

## 6. Rendering — one picture *(decided)*

**Pascal's renderer, upgraded with elastiq's look.** Not two renderers, not an editor look and a
publish look. What the author sees is what the audience gets.

Pascal today renders real-time WebGPU with screen-space GI, denoise, inked edges and merged
outlines — an excellent *technical* look, tuned for reading geometry. Elastiq's identity is the
other end: HDRI environments, studio light-formers, reflective floors, transmission and wax
materials, bloom, ambient occlusion, tone mapping, Gaussian splats.

The work is porting the second into the first. Verified constraints:

- **Post-processing ports cleanly.** three 0.185 ships bloom, ground-truth ambient occlusion,
  denoise, screen-space GI and reflections, depth of field, outline and anti-aliasing as TSL
  nodes. Elastiq's Bloom, N8AO and tone mapping have direct equivalents.
- **The material and environment work does not.** Elastiq's look is drei-shaped in load-bearing
  ways: `Environment` + `Lightformer` *are* studio mode, `MeshReflectorMaterial` *is* glossy
  mode, `MeshTransmissionMaterial` is the glass and wax, `AccumulativeShadows` and `SoftShadows`
  are the shadow quality. **This is a re-authoring of the look, not a port.** Budget it as such.
- **Splats are solved** — a WebGPU splat implementation exists in another project.
- **Three drei liabilities are already solved** in path-creator, from the WebGPU work: `RigLine`
  for fat lines, `RigLabel` for text (troika renders garbage on the node renderer), and
  `TransformGizmo`, a vendored PivotControls fork with the fat-line material swapped out.

**The look becomes authorable.** Once lighting, environment and post live in the scene and on
the timeline, "polished" and "technical" stop being modes and become positions in a look-space
that can *transition as you ride*. A slide can dissolve from a rendered view into an inked
technical read. That is a product capability, not a settings toggle.

---

## 7. The document format *(open — shape proposed)*

Elastiq's stored decks today have **no version field anywhere**, and migration is inference-based.
Scene configs embed in slide data by an explicit past decision. Model URLs are frequently
`blob:` links that die on reload. All three have to change.

Proposed: **one versioned document, four sections, assets by reference.**

```jsonc
{
  "format": "elastiq",
  "version": 1,                    // the thing today's format has no way to express
  "meta": { "id", "name", "updatedAt" },

  "worlds": {                      // was: a scene config embedded per slide
    "<worldId>": {
      "scene":    { /* Pascal node document — nodes keyed by stable id */ },
      "timeline": { /* path-creator timeline — tracks bind by node id */ },
      "cues":     [ { "id", "name", "time" } ]
    }
  },

  "deck": {                        // elastiq's existing graph, essentially unchanged
    "nodes": [ { "id", "data": { "content", "worldId", "cueId", … } } ],
    "edges": [ /* directional, by handle */ ]
  },

  "assets": {                      // was: blob: URLs written straight into slides
    "<assetId>": { "kind": "glb" | "splat" | "hdri" | "video", "src", "hash" }
  }
}
```

**Why this shape**

- **A version field, from day one.** The single cheapest thing on this list and the one whose
  absence hurts most later.
- **Worlds are shared, not embedded.** This reverses the recorded "scene configs embed in slide
  data" decision. It is what makes several slides address one space, and it collapses today's
  one-canvas-per-3D-slide into one canvas per world. Presentations stop being self-contained;
  that trade is the price of a continuous world and should be made deliberately.
- **A world with one slide is exactly today's behaviour**, so existing 3D slides migrate to
  single-slide worlds and nothing about them changes. The migration is not all-or-nothing.
- **Assets are referenced and content-addressed**, which kills the dead-`blob:`-URL class of bug
  and lets two slides share one GLB instead of loading it twice.

**Open:** whether the deck stays React Flow's node/edge shape verbatim (cheapest, keeps the
existing editor working) or gets its own schema with React Flow as a view over it.

---

## 8. Build sequence

Four phases, in dependency order. Each is independently useful.

### Phase 1 — Time, as a Pascal plugin

Bring the timeline into the editor as first-class authoring. Track kinds, shots, cues and
hotspots as node kinds. Timeline UI inside the editor. Every existing Pascal kind becomes
animatable.

*Done when:* an author opens Pascal, places a wall and a model, keyframes them, scrubs, and it
plays back deterministically.

*Already proven:* the object binding (a four-line adapter over Pascal's registry), per-frame
driving without touching undo, camera ownership, and a working custom node kind end to end. See
`examples/pascal-spike`.

### Phase 2 — Rendering

Port elastiq's look into Pascal's renderer. Post-processing chain first (mechanical), then the
environment, material and shadow work (a re-authoring — see §6), then splats.

*Done when:* a scene authored in Pascal looks like elastiq's current output, in the editor.

### Phase 3 — First-class in elastiq

Worlds addressable from the deck. Slides carry `worldId` + `cueId`. One canvas per world, alive
across the deck, with HTML compositing over it. Riding the clock on edge navigation. The
authoring surface embedded so it reads as one product, not a linked-out tool.

*Done when:* an author builds a world, lays slides across it, and presents a continuous journey.

### Phase 4 — The format

The versioned document of §7, with migration from today's decks and an asset registry.

*Sequencing note:* the version field should land in Phase 1 even if nothing else does. It costs
nothing now and is expensive to retrofit.

---

## 9. Risks, verified

Things measured or read this session, not guessed.

| Risk | Standing |
|---|---|
| Elastiq's scene config has **no stable identity** — `parts` keyed by mesh name in a flat namespace, colliding across models | Confirmed. Nothing outside a scene can address anything inside it. This is the defect the whole design fixes. |
| Elastiq's 3D prototype **cannot express undo** — ~30 `useState` hooks plus mutable `userData` as the source of truth | Confirmed. Restructuring, not a feature add. |
| **Materials are never saved** from the prototype — presets, tweaks, MaterialX, per-model scale | Confirmed, live data loss today. |
| Pascal's viewer caps the frame loop at **50fps**, hardcoded | Proposed upstream as a `maxFps` prop — pascalorg/editor#671. Fallback: drive `advance` ourselves. |
| **Pascal is pre-1.0**, commits daily | Real ongoing cost. Mitigated by contributing upstream rather than forking. |
| Elastiq's presentation storage has **no auth or tenant isolation**, and its upload key is committed to the repo | Confirmed by their own audit: *"Blocks external launch: Yes."* Unrelated to this design; fix independently. |
| `cloneNodesInto` mints **fresh ids**, which a prefab needs and a timeline reference cannot survive | Open. Only bites when prefabs and timelines meet — which this design makes inevitable. See `INTEGRATION-DESIGN.md` §10. |

---

## 10. What this makes possible that none of the three can alone

- **A building that explains itself.** Author the structure, animate the assembly, narrate it as
  a deck, publish to a URL.
- **Anything, not just buildings.** The plugin contract means the vocabulary is open, and time
  and narrative apply to whatever anyone adds without them writing a line of timeline code.
- **Authored from a description.** Pascal ships an MCP server; elastiq already generates decks
  from a brief with an agent pipeline. Neither can produce a narrated 3D presentation alone.
- **A time layer for someone else's ecosystem.** A widely-used 3D editor with no animation is a
  gap somebody fills. Contributing rather than forking makes every plugin anyone writes
  something this system can animate and present.
