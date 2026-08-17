// Public surface of @huma/pascal-time: the node kinds Pascal gains, the two calls that install
// them, the binding that turns Pascal's scene registry into something path-creator can drive,
// and the per-frame driver itself. Everything here is safe in a published presentation — it
// imports @pascal-app/core but never @pascal-app/editor. The authoring-only surface (the
// timeline panel, M1.3) belongs behind a separate `./editor` entry, NOT in this file.
export {
  PASCAL_TIME_PLUGIN_ID,
  TIMELINE_KIND,
  TimelineNode,
  type TimelineNodeType
} from "./plugin/kinds";
export { pascalTimePlugin, timelineDefinition } from "./plugin/definitions";
export { installPascalTimeOnScene, registerPascalTimeKinds } from "./plugin/install";
export {
  buildTimelineNode,
  createPluginNode,
  deletePluginNode,
  newPascalTimeNodeId,
  readPluginNode
} from "./plugin/scene-ops";
export {
  pascalObjectBinding,
  pascalSceneBinding,
  type PascalSceneRegistryLike
} from "./bind/scene-binding";
export { PascalNodeDriver, type PascalDriveClock } from "./drive/node-driver";
