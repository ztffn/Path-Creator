## Path-Creator Port To-Do

Last updated: 2026-03-08

### Completed (Phase 1 + Significant Phase 2)
- [x] Set up workspace structure for package + demo.
- [x] Created publishable package scaffold at `Packages/path-creator`.
- [x] Implemented core vector/math utilities and cubic bezier primitives.
- [x] Implemented `BezierPath` model:
  - [x] anchors/controls storage
  - [x] control modes (`free`, `aligned`, `mirrored`, `automatic`)
  - [x] open/closed path handling
  - [x] auto control-point placement and `autoSmooth`
  - [x] serialize/deserialize support
- [x] Implemented `VertexPath` runtime queries:
  - [x] point/direction/normal/rotation at time and distance
  - [x] closest point/time/distance
  - [x] end-of-path instructions (`loop`, `reverse`, `stop`)
- [x] Implemented Three adapter mesh builders:
  - [x] `buildRoadMeshBuffers`
  - [x] `buildTubeMeshBuffers`
  - [x] `buildPolylineBuffers`
- [x] Implemented R3F runtime helpers/hooks:
  - [x] `usePathFollower`
  - [x] `usePathSample`
  - [x] `useDollyCamera`
  - [x] object/camera apply helpers
- [x] Built interactive minimal demo for path editing and follower validation.
- [x] Added test coverage for core, three, and r3f layers.

### Next Steps (Current Priority)
- [ ] Stabilize Bezier editor UX in demo:
  - [ ] tighten selection/drag behavior for anchors and control points
  - [ ] confirm midpoint normal visualization and pivot behavior are mathematically consistent
  - [ ] reduce accidental control conflicts between orbiting and editing
- [ ] Define and implement final handle UX conventions:
  - [ ] anchors vs control points visual language
  - [ ] interaction affordance tuning (hit area, hover/active states)
- [ ] Add endpoint behavior UX pass:
  - [ ] explicit endpoint editing for open paths
  - [ ] verify open-path endpoint tangents and normals in editor
- [ ] Package hardening:
  - [ ] API docs for public exports
  - [ ] semantic versioning + changelog setup
  - [ ] npm publish dry-run validation

### Deferred / Later
- [ ] Cinemachine-like advanced camera features (blends/channels/noise).
- [ ] Road mesh authoring pipeline demo built from edited path data.
- [ ] Additional geometry correctness/regression fixtures from Unity-equivalent layouts.
