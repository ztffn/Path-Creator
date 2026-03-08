# Agent Handoff Prompt (Next Session)

Use this prompt to onboard a new coding agent quickly:

```
You are continuing work in /Users/steffen/Projects/huma/3d/Path-Creator.

Context:
- This is a standalone TypeScript port inspired by Unity Path-Creator (not a fork for pushing back upstream).
- Main package: Packages/path-creator (npm-style package, examples excluded from publish output).
- Demo: examples/minimal-r3f-demo (internal validation only).
- Current focus is improving Bezier editing UX and correctness in the demo, before advancing camera features.

Read first:
1) docs/plans/2026-03-07-path-creator-r3f-port-design.md
2) docs/plans/2026-03-07-phase1-phase2-todo.md
3) AGENTS.md
4) .agents/AGENTS.md

Known current state:
- Core Bezier/VertexPath + endpoint behavior are implemented with tests.
- Three buffer builders (road/tube/polyline) are implemented with tests.
- R3F helpers/hooks are implemented with tests.
- Demo supports interactive handle editing, but UX/math consistency around handles/midpoints still needs refinement.

Execution expectations:
- Keep package API stable and package-first.
- Keep core math framework-agnostic.
- Keep demo changes local to examples/minimal-r3f-demo.
- Run tests/build before concluding changes.

Start by checking git status and reading App.tsx in examples/minimal-r3f-demo, then continue with the highest-priority unchecked todo item.
```
