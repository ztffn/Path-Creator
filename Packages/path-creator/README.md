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

## Rotation Composer Example

`applyScreenComposerAim` is a rotation-only camera composer. The caller owns camera
position; the composer only changes orientation. This lets the same aim behavior work
for a dolly rail camera, a static camera, or another movement rig.

```ts
import {
  applyScreenComposerAim,
  createScreenComposerState
} from "@huma/path-creator/r3f";

const composerState = createScreenComposerState();

function frame(camera: PerspectiveCamera, target: Vec3, railUp: Vec3, deltaSeconds: number) {
  applyScreenComposerAim(
    camera,
    target,
    railUp,
    composerState,
    {
      screenPosition: { x: 0.15, y: -0.05 },
      deadZone: { width: 0.18, height: 0.14 },
      softZone: { width: 0.55, height: 0.45 },
      hardLimits: { width: 0.9, height: 0.85 },
      damping: { x: 6, y: 8 },
      lookaheadTime: 0.2,
      lookaheadSmoothing: 8,
      lookaheadIgnoreY: false,
      centerOnActivate: false
    },
    deltaSeconds
  );
}
```

Screen coordinates are Cinemachine-style normalized coordinates: `{ x: 0, y: 0 }`
is the viewport center, positive `x` moves right, and positive `y` moves up. The
dead/soft/hard zones are expressed as normalized viewport width/height.

## Tested Coverage

- Core endpoint behavior (`loop`, `reverse`, `stop`)
- Bezier editing operations (`splitSegment`, `deleteAnchor`, `autoSmooth`)
- Three mesh buffer invariants (counts, normals/uvs shape, indexed triangles)
- R3F runtime helpers (`updateFollowerState`, sampling parity, camera application, screen composer)
