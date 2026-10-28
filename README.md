# Path Creator for Three.js + React Three Fiber

A runtime-first port of the ideas behind Seb Lague's Unity Path Creator, rebuilt for modern web 3D workflows.

This repository is not trying to mirror the Unity editor. It is focused on the parts that matter in production: editable cubic Bezier paths, reliable sampling, path-following runtime logic, and Three.js/R3F integration that can actually drive scenes, cameras, and animation.

## Why this exists

Path tools are usually either:

- editor-heavy and tied to a specific app model, or
- math libraries with no runtime behavior to drive real objects.

This project sits in the middle:

- core path math is framework-agnostic
- Three.js adapters produce geometry and camera rails
- R3F hooks let you animate objects along a path in real apps
- the demo is only for validation, not a published package concern

The goal is practical parity with the runtime concepts of Path Creator, not a 1:1 Unity editor clone.

## What is included

### Packages/path-creator
Publishable package: `@huma/path-creator`

Core features:

- cubic Bezier path editing model
- anchors, controls, open/closed paths, control modes, auto-smooth
- vertex path sampling and distance/time queries
- point / direction / normal / rotation lookup
- closest-point and closest-time searches
- end-of-path instructions: `loop`, `reverse`, `stop`
- mesh adapters for road, tube, and polyline geometry
- R3F runtime helpers like `usePathFollower`, `usePathSample`, and `useDollyCamera`
- virtual-camera and timeline primitives for camera rails, shot blending, and scrub-safe evaluators

### examples/minimal-r3f-demo
A minimal interactive validation app used to test runtime behavior in-scene.

This is intentionally not part of the published package.

### docs/plans
Design notes, implementation status, and handoff docs that explain the architecture and roadmap decisions.

## Repository layout

- `Packages/path-creator` — publishable npm package
- `examples/minimal-r3f-demo` — internal validation/demo app
- `docs/plans` — design and planning documents
- `Assets` — Unity reference source kept for comparison during porting

## Quick start

Install the package and Three.js runtime:

```bash
npm install @huma/path-creator three
```

If you are using React Three Fiber hooks:

```bash
npm install react @react-three/fiber
```

### Core example

```ts
import {
  BezierPath,
  ControlMode,
  EndOfPathInstruction,
  PathSpace,
  VertexPath,
} from "@huma/path-creator/core";

const bezier = new BezierPath(
  [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0.5, z: 0 },
    { x: 4, y: 0, z: 1 },
  ],
  { space: PathSpace.XYZ, controlMode: ControlMode.Free }
);

bezier.autoSmooth(0.45);

const vertexPath = new VertexPath(bezier, {
  maxAngleError: 0.3,
  minVertexDistance: 0.05,
});

const point = vertexPath.getPointAtTime(0.25, EndOfPathInstruction.Stop);
const direction = vertexPath.getDirection(0.25, EndOfPathInstruction.Stop);
```

### R3F example

```ts
import { EndOfPathInstruction } from "@huma/path-creator/core";
import { usePathFollower } from "@huma/path-creator/r3f";

const follower = usePathFollower({
  path: vertexPath,
  speed: 1.5,
  mode: EndOfPathInstruction.Loop,
});
```

## Architecture

The library is intentionally layered:

- `core` — path data model, sampling, closest-point queries, endpoint behavior
- `three` — geometry builders, mesh adapters, camera and virtual camera utilities
- `r3f` — hooks and runtime helpers for React Three Fiber
- `timeline` / `timeline-ui` — scrub-safe timeline evaluators and editor-friendly lane UI

This keeps the math portable and avoids dragging rendering concerns into the path engine.

## Workspace commands

From the repo root:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm dev:demo
```

## Publishing boundary

The package is configured to publish only the runtime artifacts:

- `dist`
- `README.md`
- `LICENSE`

The demo app is not published and remains a local validation tool.

## Current status

The project has already implemented the core runtime layer and validation tooling:

- editable cubic Bezier paths
- vertex sampling and runtime queries
- path-following runtime utilities
- Three.js mesh generation
- R3F hooks and camera rail helpers
- virtual camera / timeline support
- minimal interactive demo for testing behavior in-scene

The remaining emphasis is on polish and consistency around editor UX and handle/math edge cases, while keeping the runtime API stable and reusable.

## Design and planning docs

- `docs/plans/2026-03-07-path-creator-r3f-port-design.md`
- `docs/plans/2026-03-07-phase1-phase2-todo.md`
- `docs/plans/2026-03-08-agent-handoff-prompt.md`

## License

MIT
