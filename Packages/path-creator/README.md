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
- `@huma/path-creator/timeline` — headless timeline model + player (`buildShowTimeline`, `createTimelinePlayer`, `evaluateTimeline`, `seekTimelinePlayer`)
- `@huma/path-creator/timeline-ui` — `TimelineLanes`, a themeable DOM multilane editor (renderer-agnostic)

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

## Virtual Camera Example

Virtual cameras are lightweight shot states, not render cameras. Any rig can produce
one: a dolly rail, a static camera, a follow rig, or a future timeline block. The
real Three camera is updated by cutting to a snapshot or blending between snapshots.

```ts
import {
  activateVirtualCameraBrain,
  applyVirtualCameraTransition,
  applyVirtualCameraBrain,
  captureVirtualCameraSnapshot,
  createVirtualCameraBrainState
} from "@huma/path-creator/three";

const shotA = captureVirtualCameraSnapshot(camera, {
  name: "wide",
  settings: { targetWeight: 0.5, composerScreenX: 0 }
});

const shotB = {
  ...shotA,
  name: "close",
  position: { x: 4, y: 2, z: 6 },
  lens: { fov: 35, near: 0.1, far: 200 },
  settings: { targetWeight: 1, composerScreenX: 0.18 }
};

const resolved = applyVirtualCameraTransition(camera, shotA, shotB, {
  durationSeconds: 1.2,
  elapsedSeconds: 0.4,
  curve: "easeInOut"
});
```

`applyVirtualCameraTransition` applies camera position, rotation, and lens values.
It also returns the resolved snapshot, including blended numeric rig settings for
timeline/editor code to feed into composers or other rig controls. A zero-duration
transition is a cut.

For frame-driven shot control, use the virtual camera brain helpers:

```ts
const brain = createVirtualCameraBrainState();

activateVirtualCameraBrain(brain, shotB, {
  durationSeconds: 1.2,
  curve: "easeInOut"
});

function frame(deltaSeconds: number) {
  const live = applyVirtualCameraBrain(camera, brain, deltaSeconds);
  // live?.settings contains blended rig values for the current frame.
}
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

## Timeline UI Example

`TimelineLanes` (`@huma/path-creator/timeline-ui`) is a DOM (renderer-agnostic)
multilane editor for shot and dolly lanes, plus host-defined `extraLanes` for
anything else (activation, audio, …). It is fully host-driven: the host owns the
data and selection, supplies a `theme` and left-rail icons, and receives edits via
callbacks. Selection is bidirectional — pass `selectedShotId`/`selectedLaneId` in,
handle `onSelectShot`/`onSelectLane` out.

```tsx
import { TimelineLanes } from "@huma/path-creator/timeline-ui";

<TimelineLanes
  shots={shots}
  dollies={dollies}
  dollyMoves={dollyMoves}
  duration={timeline.duration}
  playerRef={playerRef}
  driving={playing}
  theme={{ panelBackground: "#101820", text: "#e8eef5", fontFamily: "system-ui" }}
  shotIcon={<CameraIcon />}
  dollyIcon={<TrackIcon />}
  // Host-defined lanes; each id is opaque to the editor and echoed back in callbacks.
  extraLanes={[{ id: "aud:voice", name: "Voice", color: "rgba(167,139,250,0.6)", icon: <AudioIcon />, clips }]}
  // Selection (bidirectional):
  selectedShotId={selectedShotId}
  onSelectShot={(shotId) => select(shotId)}
  selectedLaneId={selectedLaneId}
  onSelectLane={(laneId) => selectLane(laneId)}
  // Edits route back to the host to mutate its own data:
  onShotTiming={onShotTiming}
  onExtraClipTiming={onExtraClipTiming}
  onCreateExtraClip={onCreateExtraClip}
  onSeek={onSeek}
/>;
```

Deletion is intentionally left off-lane (a host side-panel/inspector), mirroring
how dolly moves are removed — the lane editor only creates, moves, and resizes.

## Tested Coverage

- Core endpoint behavior (`loop`, `reverse`, `stop`)
- Bezier editing operations (`splitSegment`, `deleteAnchor`, `autoSmooth`)
- Three mesh buffer invariants (counts, normals/uvs shape, indexed triangles)
- Three virtual camera cuts and blends
- R3F runtime helpers (`updateFollowerState`, sampling parity, camera application, screen composer)
