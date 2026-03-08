# AGENTS.md (Local Agents Workspace)

This `.agents` workspace supports the Path-Creator migration to Three.js/R3F.

## Active Objective

Build a reusable npm package for path creation/following/camera rails, plus a minimal demo app.

## Current Status (2026-03-08)

- Package runtime layers exist and are tested (`core`, `three`, `r3f`).
- Demo exists and is used for interaction/UX validation.
- Current priority is stabilizing demo Bezier editing interactions (handle selection, dragging, midpoint behavior).

## Session Priorities

1. `Packages/path-creator` quality and API correctness.
2. Runtime parity of path concepts from Unity implementation.
3. Minimal `examples/minimal-r3f-demo` for verification only.

## Hard Constraints

- Keep example files out of package publish output.
- Keep core path math independent from React.
- Keep R3F integration in adapter hooks/components, not in core math.
- Do not push changes to upstream `SebLague/Path-Creator`; this repo is standalone inspired-by work.

## Reference

Primary docs to read first:
- `docs/plans/2026-03-07-path-creator-r3f-port-design.md`
- `docs/plans/2026-03-07-phase1-phase2-todo.md`
- `docs/plans/2026-03-08-agent-handoff-prompt.md`
