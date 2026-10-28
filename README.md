# Path-Creator (Three.js / R3F Port)

Standalone TypeScript port inspired by Seb Lague's Unity Path-Creator.

This repository is focused on reusable runtime path functionality for Three.js and React Three Fiber, with a local demo for validation.

## Repository Layout

- `Packages/path-creator`: publishable npm package (`@huma/path-creator`)
- `examples/minimal-r3f-demo`: internal demo app for interactive validation (not published)
- `docs/plans`: design docs, implementation status, and handoff notes
- `Assets`: original Unity source kept as reference during porting

## Current Status (July 11, 2026)

Implemented:
- Core Bezier path editing model (`anchors`, `controls`, `open/closed`, control modes, auto-smooth)
- Vertex path sampling and runtime queries (point/direction/normal/rotation, closest point/time/distance)
- End-of-path behavior (`loop`, `reverse`, `stop`)
- Three adapter mesh buffer builders (`road`, `tube`, `polyline`)
- R3F runtime helpers/hooks (`usePathFollower`, `usePathSample`, `useDollyCamera`)
- Virtual cameras + a pure, scrub-safe timeline evaluator (camera/cart/event tracks, crossfade blends, FOV lens animation)
- Minimal demo with in-scene path editing, virtual-camera authoring, and timeline tracks — activation, audio, GLB animation clips, and keyframed transforms (viewport gizmo + key-pose) — all scrub-safe and portable via the scene file

## Workspace Commands

From repo root:

```bash
pnpm install
pnpm build
pnpm test
pnpm lint
pnpm dev:demo
```

## Package Publishing Boundary

`@huma/path-creator` is configured to publish only:
- `dist`
- `README.md`
- `LICENSE`

Demo files are intentionally excluded from npm output.

Publishing (from `Packages/path-creator`, source name `@huma/path-creator`, published as
`@ztffn/path-creator`):
- `pnpm publish:npm` — npmjs, public. Needs `npm login`; 2FA is prompted interactively
  (run in a real terminal) or passed as `NPM_OTP=<code>`.
- `pnpm publish:github` — GitHub Packages. Needs `GH_PACKAGES_TOKEN` or `gh auth`.

## Design + Tracking Docs

- `docs/plans/2026-03-07-path-creator-r3f-port-design.md`
- `docs/plans/2026-03-07-phase1-phase2-todo.md`
- `docs/plans/2026-03-08-agent-handoff-prompt.md`
