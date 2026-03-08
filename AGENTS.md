# AGENTS.md

## Project Mission

Port Unity Path-Creator concepts and functionality to Three.js + React Three Fiber.

Priority order:
1. Reusable runtime functionality (path math, sampling, follower, camera rail behavior).
2. Installable npm package.
3. Minimal demo app for validation.

## Scope Guardrails

- Optimize for concept/functionality parity, not Unity editor UX parity.
- Keep core logic framework-agnostic and independent from React.
- Support animation workflows and Cinemachine-like camera rails in Three.js/R3F.
- Do not include example/demo files in published npm package.

## Current State (2026-03-08)

Implemented:
- Core Bezier and VertexPath runtime APIs with endpoint behaviors.
- Three mesh buffer adapters (`road`, `tube`, `polyline`).
- R3F runtime hooks/helpers (`usePathFollower`, `usePathSample`, `useDollyCamera`).
- Automated tests across `core`, `three`, and `r3f`.
- Interactive minimal demo for path editing and runtime validation.

Primary open area:
- Demo editor UX and math consistency around handles/midpoints.

## Required Output Structure

- `Packages/path-creator`:
  - publishable package
  - TypeScript source and typed build output
  - clean public API (`core`, `three`, `r3f`)

- `examples/minimal-r3f-demo`:
  - internal validation demo
  - intentionally excluded from package publish

## Architecture Rules

- Layering:
  - `core`: path data model + sampling + endpoint handling
  - `three`: geometry and Three.js adapters
  - `r3f`: hooks/components for runtime integration

- Avoid mixing rendering concerns into core.
- Avoid hard dependencies from core to R3F.

## Functional Requirements

Preserve these behaviors:
- Editable cubic Bezier path model (anchors/controls, open/closed, control modes).
- Vertex path sampling with distance/time lookup.
- Path queries:
  - position/direction/normal/rotation by distance and time
  - closest point/time/distance along path
- Endpoint instructions:
  - `loop`
  - `reverse`
  - `stop`
- Follower runtime utility for object transform updates.
- Camera rail utility for Cinemachine-like dolly behavior.

## Quality Bar

- Keep tests for core math and endpoint behavior green.
- Keep geometry output invariants covered where practical.
- Keep APIs stable and documented as features are added.
- Prefer incremental, reviewable commits over large unstructured changes.

## Working Defaults for Agents

- Read first:
  - `docs/plans/2026-03-07-path-creator-r3f-port-design.md`
  - `docs/plans/2026-03-07-phase1-phase2-todo.md`
  - `docs/plans/2026-03-08-agent-handoff-prompt.md`
- If tradeoffs arise, prefer runtime correctness and API clarity over editor tooling.
- If unsure, keep demo minimal and invest effort in package quality.
