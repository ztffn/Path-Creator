// Public surface of @huma/pascal-time: the node kinds Pascal gains, the two calls that install
// them, the binding that turns Pascal's scene registry into something path-creator can drive,
// and the per-frame driver itself. Everything here is safe in a published presentation — it
// imports @pascal-app/core but never @pascal-app/editor. The authoring-only surface (the
// timeline panel, M1.3) belongs behind a separate `/host-panel` entry, NOT in this file.
export {
  CART_KIND,
  CartNode,
  CUE_KIND,
  CueNode,
  PATH_KIND,
  PathNode,
  SHOT_KIND,
  ShotNode,
  PASCAL_TIME_PLUGIN_ID,
  TIMELINE_KIND,
  TimelineNode,
  type CartNodeType,
  type CueNodeType,
  type PathNodeType,
  type ShotNodeType,
  type TimelineNodeType
} from "./plugin/kinds";
export {
  cartDefinition, cueDefinition, pascalTimePlugin, pathDefinition, shotDefinition, timelineDefinition
} from "./plugin/definitions";
export { installPascalTimeOnScene, registerPascalTimeKinds } from "./plugin/install";
export {
  buildCartNode,
  buildCueNode,
  buildPathNode,
  buildShotNode,
  buildTimelineNode,
  createPluginNode,
  deletePluginNode,
  newPascalTimeNodeId,
  readCarts,
  readCues,
  readPaths,
  readPluginNode,
  readShots,
  updatePluginNode,
  updatePluginNodes,
  type CartRead,
  type Matrix4Like,
  type PathRead,
  type Shot
} from "./plugin/scene-ops";
export {
  capturePose,
  captureTransformKey,
  withActivationClip,
  withCapturedPose,
  type CapturedPose
} from "./plugin/keying";
export {
  anchorAt,
  anchorCount,
  dollyRunEasing,
  newDollyRun,
  starterRailPoints,
  withAppendedAnchor,
  withDollyRunEasing,
  withoutAnchor,
  type Point3
} from "./plugin/rails";
export {
  cartTrackSpan,
  retimeCartTrack,
  retimeTransformTrack,
  transformTrackSpan
} from "./plugin/retiming";
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
  CartKeySchema,
  CartTrackSchema,
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
  emptyRig,
  putTrack,
  readRig,
  remapRailsAfterClone,
  readShotBlocks,
  readShotDefinitions,
  readStoredTimeline,
  readTimeline,
  synthesiseCameraTrack,
  remapTracksAfterClone,
  writeTracks,
  type PascalRig,
  type ShotBlock,
  type StoredTimeline
} from "./plugin/timeline-io";
export { PascalNodeDriver, type PascalDriveClock } from "./drive/node-driver";
export {
  captureViewportPose,
  getCartFrames,
  getLastCameraFrame,
  getViewportCameraPose,
  PascalTimeSceneDriver,
  type CartFrameLike,
  type ViewportCameraPose
} from "./drive/timeline-scene-driver";
export {
  PascalTimePathEditOverlay,
  PASCAL_OVERLAY_LAYER,
  PATH_EDIT_GROUP
} from "./drive/path-edit-overlay";
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
