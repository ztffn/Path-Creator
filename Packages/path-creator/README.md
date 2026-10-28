# @huma/path-creator

Path creation and runtime sampling primitives for Three.js + React Three Fiber.

## Install

The package is published to npmjs as `@ztffn/path-creator` (public, no token needed).
Install it under its source name with an npm alias so imports stay `@huma/path-creator/...`:

```bash
npm install @huma/path-creator@npm:@ztffn/path-creator three
```

The same name is also on GitHub Packages (`npm.pkg.github.com`), which needs a GitHub
token with `read:packages`; npmjs is the recommended source.

If you use the React hooks, also install:

```bash
npm install react @react-three/fiber
```

## Entry Points

- `@huma/path-creator/core`
- `@huma/path-creator/three`
- `@huma/path-creator/r3f`
- `@huma/path-creator/timeline` — headless timeline model + player (`buildShowTimeline`, `createTimelinePlayer`, `evaluateTimeline`, `seekTimelinePlayer`), and cues (`currentCue`, `rideToCue`, `stepCueTransport`)
- `@huma/path-creator/timeline-ui` — `TimelineLanes`, a themeable DOM multilane editor (renderer-agnostic)

Timeline schema v4 supports portable camera, cart, event, activation, audio,
animation, and keyframed transform tracks. Pure track evaluators are exported from
`@huma/path-creator/timeline`; Three.js object binding and track directors are
exported from `@huma/path-creator/three`.

## Portable Timeline Tracks

Timeline v4 stores object and media tracks directly in `Timeline.tracks`, so they
survive `serializeRigDocument` / `parseRigDocument` without application sidecars.
All evaluators are pure functions of `time`, making playback, scrubbing, and replay
deterministic.

```ts
import {
  createTimeline,
  evaluateActivation,
  evaluateAnimation,
  evaluateAudio,
  evaluateTransform,
  type ActivationTrack,
  type AnimationTrack,
  type AudioTrack,
  type TransformTrack
} from "@huma/path-creator/timeline";

const activation: ActivationTrack = {
  type: "activation",
  id: "visibility",
  objectId: "fox",
  postPlaybackState: "revert",
  clips: [{ id: "visible", start: 0, end: 8 }]
};

const audio: AudioTrack = {
  type: "audio",
  id: "dialogue",
  gain: 0.8,
  clips: [
    { id: "line-a", src: "/audio/a.mp3", start: 0, duration: 4 },
    { id: "line-b", src: "/audio/b.mp3", start: 3, duration: 4 }
  ]
};

const animation: AnimationTrack = {
  type: "animation",
  id: "fox-motion",
  objectId: "fox",
  clips: [
    { id: "walk", clipName: "Walk", start: 0, end: 4 },
    { id: "run", clipName: "Run", start: 3, end: 8, loop: "once" }
  ]
};

const transform: TransformTrack = {
  type: "transform",
  id: "fox-root",
  objectId: "fox",
  position: [
    { time: 0, value: [0, 0, 0] },
    { time: 8, value: [10, 0, 0], easing: "easeInOut" }
  ],
  rotation: [
    { time: 0, value: [0, 0, 0] },
    { time: 8, value: [0, 180, 0] }
  ]
};

const timeline = createTimeline({
  duration: 8,
  tracks: [activation, audio, animation, transform]
});

const atThreeSeconds = {
  visibility: evaluateActivation([activation], 3),
  audio: evaluateAudio([audio], 3),
  animation: evaluateAnimation([animation], 3),
  transform: evaluateTransform([transform], 3)
};
```

Adjacent overlapping audio and animation clips crossfade automatically across the
overlap duration. Audio crossfade weights multiply the authored clip envelope, clip
gain, and track gain. Transform rotation keys use shortest-arc quaternion slerp.

### Applying object tracks in Three.js

The package directors apply evaluated state and restore the original object state
when timeline ownership ends. Register GLTF animation actions as an optional animation
binding on the same object id used by timeline tracks.

```ts
import {
  ActivationTrackDirector,
  AnimationTrackDirector,
  ObjectBindingRegistry,
  TransformTrackDirector
} from "@huma/path-creator/three";

const bindings = new ObjectBindingRegistry();
bindings.register("fox", foxRoot, {
  mixer,
  actions: new Map([
    ["Walk", mixer.clipAction(walkClip)],
    ["Run", mixer.clipAction(runClip)]
  ]),
  clips: ["Walk", "Run"],
  resetToRest
});

const activationDirector = new ActivationTrackDirector();
const animationDirector = new AnimationTrackDirector();
const transformDirector = new TransformTrackDirector();

function frame(time: number, playing: boolean, driving: boolean) {
  activationDirector.sync(bindings, [activation], driving, timeline.duration, time, playing);
  animationDirector.sync(bindings, [animation], driving, time);
  transformDirector.sync(bindings, [transform], driving, time);
}
```

Audio evaluation is package-owned, but decoding URLs and scheduling Web Audio nodes
remain host-owned because asset loading policy differs between browsers, servers, and
render workers.

### Migrating to schema v4

- `parseRigDocument` accepts RigDocument versions 1 through 4 and returns a v4 document.
- Embedded timeline versions are stamped to timeline schema v4 during migration.
- Existing camera, cart, and event tracks require no field changes.
- New tracks must include their `type` discriminator: `activation`, `audio`,
  `animation`, or `transform`.
- The minimal demo still imports its historical `x-demo-tracks` extension, but new
  exports embed those tracks directly in the show timeline. Consumers with a custom
  sidecar should move its arrays into `timeline.tracks` before serialization.

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

### Animating lens over a shot

A timeline `CameraBlock` may carry `lensAnimation` —
`Partial<Record<keyof VirtualCameraLens, { from, to, easing? }>>` — easing a lens
field (e.g. a FOV push) across the block window. It is sampled per frame inside
`evaluateTimeline` and blends with `blendIn` crossfades automatically, so no host
per-frame override is needed:

```ts
{ id: "shot-1", vcamId: "hero", start: 0, end: 4,
  lensAnimation: { fov: { from: 60, to: 24, easing: "easeInOut" } } }
```

## Tested Coverage

- Core endpoint behavior (`loop`, `reverse`, `stop`)
- Bezier editing operations (`splitSegment`, `deleteAnchor`, `autoSmooth`)
- Three mesh buffer invariants (counts, normals/uvs shape, indexed triangles)
- Three virtual camera cuts and blends
- R3F runtime helpers (`updateFollowerState`, sampling parity, camera application, screen composer)
