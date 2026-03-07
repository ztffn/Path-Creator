## Path-Creator Port To-Do

### Phase 1 Completed
- [x] Set up workspace structure for package + demo.
- [x] Created publishable package scaffold at `Packages/path-creator`.
- [x] Implemented core vector/math utilities (`vec3`, lerp/clamp/pingpong, axis rotation).
- [x] Ported cubic bezier evaluation/derivatives/length estimation.
- [x] Implemented `BezierPath` core model:
- [x] anchors/controls storage
- [x] control modes
- [x] open/closed path handling
- [x] auto control-point placement
- [x] Implemented vertex sampling utilities:
- [x] split by angle error
- [x] split by even spacing
- [x] Implemented `VertexPath` runtime queries:
- [x] point/direction/normal/rotation at time and distance
- [x] closest point/time/distance
- [x] end-of-path instructions (`loop`, `reverse`, `stop`)
- [x] Added and updated tests for core behavior.
- [x] Verified `lint`, `test`, and `build` pass for `@huma/path-creator`.

### Next Steps (Phase 2+)
- [ ] Implement Three.js geometry builders in `src/three`:
- [ ] road mesh
- [ ] tube/cylinder mesh
- [ ] Replace polyline stub with real `BufferGeometry` outputs.
- [ ] Implement R3F runtime hooks in `src/r3f`:
- [ ] `usePathFollower`
- [ ] `usePathSample`
- [ ] `useDollyCamera` (initial Cinemachine-like rail behavior)
- [ ] Add demo scenes in `examples/minimal-r3f-demo`:
- [ ] object follow path
- [ ] camera rail follow + look-ahead
- [ ] Add tests for geometry output invariants and follower/camera behavior.
- [ ] Document API usage and migration notes from Unity concepts.
