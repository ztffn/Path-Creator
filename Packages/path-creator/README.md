# @huma/path-creator

Path creation and runtime sampling primitives for Three.js + React Three Fiber.

## Install

```bash
npm install @huma/path-creator three
```

If you use the React hooks, also install:

```bash
npm install react @react-three/fiber
```

## Entry Points

- `@huma/path-creator/core`
- `@huma/path-creator/three`
- `@huma/path-creator/r3f`

## Core Quick Start

```ts
import {
  BezierPath,
  ControlMode,
  EndOfPathInstruction,
  PathSpace,
  VertexPath
} from "@huma/path-creator/core";

const bezier = new BezierPath(
  [
    { x: 0, y: 0, z: 0 },
    { x: 2, y: 0.5, z: 0 },
    { x: 4, y: 0, z: 1 }
  ],
  { space: PathSpace.XYZ, controlMode: ControlMode.Free }
);

bezier.autoSmooth(0.45);

const vertexPath = new VertexPath(bezier, {
  maxAngleError: 0.3,
  minVertexDistance: 0.05
});

const p = vertexPath.getPointAtTime(0.25, EndOfPathInstruction.Stop);
const dir = vertexPath.getDirection(0.25, EndOfPathInstruction.Stop);
```

## Three Adapter Example

```ts
import { buildRoadMeshBuffers } from "@huma/path-creator/three";

const road = buildRoadMeshBuffers(vertexPath, {
  roadWidth: 0.35,
  thickness: 0.08,
  flattenSurface: false
});

// road.positions / road.indices / road.normals / road.uvs
```

## R3F Runtime Example

```ts
import { EndOfPathInstruction } from "@huma/path-creator/core";
import { usePathFollower } from "@huma/path-creator/r3f";

const follower = usePathFollower({
  path: vertexPath,
  speed: 1.5,
  mode: EndOfPathInstruction.Loop
});
```

## Tested Coverage

- Core endpoint behavior (`loop`, `reverse`, `stop`)
- Bezier editing operations (`splitSegment`, `deleteAnchor`, `autoSmooth`)
- Three mesh buffer invariants (counts, normals/uvs shape, indexed triangles)
- R3F runtime helpers (`updateFollowerState`, sampling parity, camera application)
