# Path-Creator to Three.js/R3F Port Design

Date: 2026-03-07
Status: Approved
Owner: Codex + project maintainer

## 1) Goal and Non-Goals

Goal: port Path-Creator concepts and functionality from Unity/C# to a reusable TypeScript ecosystem for Three.js and React Three Fiber (R3F), with a strong focus on animation paths and Cinemachine-like camera motion workflows.

Primary outcomes:
- Installable npm package with no example files included.
- Minimal example app proving runtime behavior and API usage.
- Functional parity of core concepts (Bezier editing model, sampled vertex path, path-following, mesh generation primitives, end-of-path behaviors).

Non-goals (phase 1):
- Full Unity editor UX parity.
- Scene tooling parity with Unity handles/inspector polish.
- Asset-store-level packaging or advanced UI tooling.

## 2) Architecture

Use a layered architecture to keep math and runtime logic framework-agnostic:

- `Packages/path-creator/src/core`
- `Packages/path-creator/src/three`
- `Packages/path-creator/src/r3f`
- `examples/minimal-r3f-demo`

### Core layer
- `BezierPath`: anchors, control points, control modes (`aligned`, `mirrored`, `free`, `automatic`), open/closed path, normal angle metadata.
- `VertexPath`: sampled representation with cumulative length/time lookup, tangent/normal access, closest-point queries.
- Utilities: cubic evaluation, derivatives, split/sampling, arc-length tables, endpoint instructions (`loop`, `reverse`, `stop`).

### Three.js adapter layer
- Convert core vectors/quaternions to/from `THREE` types.
- Buffer geometry builders:
- Road mesh (top/bottom/sides + UVs).
- Tube/cylinder-like sweep mesh around path normals.

### R3F layer
- Hooks:
- `usePathFollower`
- `usePathSample`
- `useDollyCamera` (Cinemachine-style path camera)
- Optional debug components for path/vertices/normals visualization.

## 3) Cinemachine-like Scope

Camera rig will be componentized and data-driven:
- Position driver: by `distance` or normalized `t`.
- Orientation driver: look-ahead direction + explicit up handling + roll.
- Damping: independent positional/rotational smoothing.
- Extensible channels (future): FOV by curve, noise, blends between rails.

Initial feature set:
- Follow rail with constant speed.
- Look ahead along tangent.
- Optional target override (look-at target with blend).
- Loop/reverse/stop endpoint behavior.

## 4) Package and Publishing Constraints

Package-first deliverable:
- `Packages/path-creator` publishes to npm.
- `examples/` is never published.

`package.json` strategy:
- `files` whitelist only built output and docs (`dist`, `README`, `LICENSE`).
- `exports` map for core/three/r3f entry points.
- `peerDependencies` for `three`, `react`, `@react-three/fiber` where needed.

Build outputs:
- ESM + `.d.ts`.
- Source maps.

## 5) Migration Plan (Phased)

### Phase 1: Core parity + tests
- Port Bezier and vertex sampling primitives from Unity runtime.
- Implement numeric behavior for distance/time queries and closest-point APIs.
- Add unit tests for deterministic path math and endpoint instructions.

### Phase 2: Three/R3F runtime
- Add follower hook and transform utilities.
- Implement road/tube geometry generation.
- Provide debug rendering helpers.

### Phase 3: Camera rigs
- Implement dolly camera behavior and options.
- Add example scenarios:
- Object follows path.
- Camera follows path and tracks moving object.

### Phase 4: docs and stabilization
- API docs and migration notes from Unity terms to package terms.
- Performance pass and integration tests in demo.

## 6) Testing Strategy

- Unit tests (core math): cubic eval, sampling density, monotonic arc-length lookup, closest-point stability.
- Snapshot or geometry-assert tests: vertex/triangle counts and winding for generated meshes.
- Demo-level checks: follower/camera endpoint modes and update behavior.
- Regression seeds: fixed path fixtures from Unity-equivalent layouts.

## 7) Acceptance Criteria

- A consumer can `npm install` the package and animate object/camera along a path in R3F.
- Core APIs are framework-agnostic and tested.
- Minimal demo runs locally and documents setup.
- Published package excludes `examples/**`.

## 8) Immediate Next Steps

1. Scaffold workspace (`Packages/path-creator`, `examples/minimal-r3f-demo`).
2. Port core math/types first, with tests.
3. Add R3F follower and camera hook.
4. Add minimal demo proving object + camera rail behavior.
