// Public surface of @huma/pascal-time: the node kinds Pascal gains, the two calls that install
// them, the binding that turns Pascal's scene registry into something path-creator can drive,
// and the per-frame driver itself. Everything here is safe in a published presentation — it
// imports @pascal-app/core but never @pascal-app/editor. The authoring-only surface (the
// timeline panel, M1.3) belongs behind a separate `/host-panel` entry, NOT in this file.
export {
  CUE_KIND,
  CueNode,
  SHOT_KIND,
  ShotNode,
  PASCAL_TIME_PLUGIN_ID,
  TIMELINE_KIND,
  TimelineNode,
  type CueNodeType,
  type ShotNodeType,
  type TimelineNodeType
} from "./plugin/kinds";
export {
  cueDefinition, pascalTimePlugin, shotDefinition, timelineDefinition
} from "./plugin/definitions";
export { installPascalTimeOnScene, registerPascalTimeKinds } from "./plugin/install";
export {
  buildCueNode,
  buildShotNode,
  buildTimelineNode,
  createPluginNode,
  deletePluginNode,
  newPascalTimeNodeId,
  readCues,
  readPluginNode,
  readShots,
  updatePluginNode,
  updatePluginNodes,
  type Shot
} from "./plugin/scene-ops";
export {
  capturePose,
  captureTransformKey,
  withActivationClip,
  withCapturedPose,
  type CapturedPose
} from "./plugin/keying";
export { retimeTransformTrack, transformTrackSpan } from "./plugin/retiming";
export {
  pascalObjectBinding,
  pascalSceneBinding,
  type PascalSceneRegistryLike
} from "./bind/scene-binding";
export {
  ActivationTrackSchema,
  BlendInSchema,
  CameraBlockSchema,
  CameraTrackSchema,
  EasingSchema,
  LensAnimationSchema,
  LensFieldAnimationSchema,
  isObjectBoundTrack,
  migrateTrackPayload,
  PersistedTrackSchema,
  remapTracksForClone,
  removeTrack,
  removeTracksForObject,
  TRACK_PAYLOAD_VERSION,
  TransformTrackSchema,
  upsertTrack,
  type ObjectBoundTrack,
  type PersistedTrack
} from "./plugin/tracks";
export {
  deleteTrack,
  dropTracksForObject,
  putTrack,
  readShotDefinitions,
  readStoredTimeline,
  readTimeline,
  synthesiseCameraTrack,
  remapTracksAfterClone,
  writeTracks,
  type StoredTimeline
} from "./plugin/timeline-io";
export { PascalNodeDriver, type PascalDriveClock } from "./drive/node-driver";
export {
  captureViewportPose,
  getLastCameraFrame,
  getViewportCameraPose,
  PascalTimeSceneDriver,
  type ViewportCameraPose
} from "./drive/timeline-scene-driver";
export {
  getPipFrame,
  PascalTimeCameraPip,
  pipRect,
  type PipFrameInfo
} from "./drive/camera-pip";
export { pascalTimeTransport, type PascalTimeTransportState } from "./transport/store";
export {
  PascalCameraDirector,
  pascalTargetContext,
  type CameraControlsLike,
  type CameraDriveInput,
  type CameraFrame
} from "./drive/camera-director";
