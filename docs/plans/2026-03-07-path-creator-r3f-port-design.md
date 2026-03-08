# Path-Creator to Three.js/R3F Port Design

Date: 2026-03-07
Status: Active (partially implemented)
Owner: Codex + project maintainer
Last reviewed: 2026-03-08

## 1) Goal and Non-Goals

Goal: port Path-Creator concepts and functionality from Unity/C# to a reusable TypeScript ecosystem for Three.js and React Three Fiber (R3F), with a focus on animation paths and Cinemachine-like camera motion workflows.

Primary outcomes:
- Installable npm package with no example files included.
- Minimal example app proving runtime behavior and API usage.
- Functional parity of core concepts (Bezier editing model, sampled vertex path, path-following, mesh generation primitives, end-of-path behaviors).

Non-goals (current):
- Full Unity editor UX parity.
- Scene tooling parity with Unity handles/inspector polish.
- Asset-store-level packaging or advanced UI tooling.

## 2) Architecture

Layered architecture:
- `Packages/path-creator/src/core`
- `Packages/path-creator/src/three`
- `Packages/path-creator/src/r3f`
- `examples/minimal-r3f-demo`

### Core layer
- `BezierPath`: anchors, control points, control modes (`aligned`, `mirrored`, `free`, `automatic`), open/closed path, normal angle metadata.
- `VertexPath`: sampled representation with cumulative length/time lookup, tangent/normal access, closest-point queries.
- Utilities: cubic evaluation, derivatives, split/sampling, arc-length tables, endpoint instructions (`loop`, `reverse`, `stop`).

### Three.js adapter layer
- Buffer data builders for:
  - road mesh (top/bottom/sides + UVs)
  - tube/cylinder-like sweep mesh around path normals
  - polyline buffers

### R3F layer
- Hooks/utilities:
  - `usePathFollower`
  - `usePathSample`
  - `useDollyCamera`
  - `applySampleToObject`
  - `applyDollyCamera`

## 3) Cinemachine-like Scope

Current baseline:
- Position driver by traveled distance.
- Look-ahead based orientation.
- Optional damping in camera application.
- Endpoint behavior support (`loop`, `reverse`, `stop`).

Still pending for parity goals:
- higher-level camera rig presets/blending channels
- FOV/noise/blend feature channels

## 4) Package and Publishing Constraints

Package-first deliverable:
- `Packages/path-creator` publishes to npm.
- `examples/` is never published.

Current package constraints (implemented):
- `files` whitelist includes only `dist`, `README.md`, `LICENSE`.
- `exports` map includes root + `core` + `three` + `r3f` entry points.
- `peerDependencies` include `three`; React and R3F are optional peers.

Build outputs:
- ESM + `.d.ts`
- source maps

## 5) Migration Plan (Progress)

### Phase 1: Core parity + tests
Status: Completed
- Bezier + vertex sampling primitives ported.
- Distance/time/closest-point APIs implemented.
- Unit tests for endpoint instructions and editing behavior implemented.

### Phase 2: Three/R3F runtime
Status: In progress (major parts complete)
- Follower/camera hooks and transform utilities implemented.
- Road/tube/polyline mesh buffer builders implemented.
- Demo provides interactive editing + runtime path following.

### Phase 3: Camera rigs
Status: Partially started
- Basic dolly camera behavior exists.
- Advanced Cinemachine-like channels and blending not yet implemented.

### Phase 4: Documentation and stabilization
Status: In progress
- Baseline docs updated.
- API deep documentation and migration guide still pending.

## 6) Testing Strategy

Implemented:
- Core math + endpoint instruction tests.
- Geometry builder invariant tests (counts/triangle indexing/normals/uv shape).
- R3F helper tests for follower state update, sample parity, and camera application.

Recommended additions:
- Golden fixture regression tests from Unity-equivalent path layouts.
- Additional editor interaction tests for demo behavior.

## 7) Acceptance Criteria

- A consumer can install package and animate object/camera along a path in R3F. (met)
- Core APIs are framework-agnostic and tested. (met)
- Minimal demo runs locally and documents setup. (met)
- Published package excludes `examples/**`. (met)

## 8) Immediate Next Steps

1. Stabilize demo editing UX for anchors/control points and midpoint normal tooling.
2. Lock interaction rules (selection, dragging, pivot/transform control interplay).
3. Add concise API docs and publish checklist for first external release.
4. Resume advanced camera rail feature work after editor UX is stable.
