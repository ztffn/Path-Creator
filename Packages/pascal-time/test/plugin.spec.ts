// M1.1: the plugin loop, against Pascal's REAL registry and REAL scene store rather than a
// stand-in shaped like them. Walks one node kind through the lifecycle an author puts it
// through — register, gate, place, render, select, delete, undo — because each of Pascal's
// plugin traps fails silently, and a kind that registers but never renders looks identical
// from the outside to one that works. Scope: the M1.1 done-criterion, one assertion each.
import { beforeAll, describe, expect, it } from "vitest";
import {
  getNodePluginId,
  isNodeKindEnabled,
  isRegistrySelectable,
  nodeRegistry,
  useScene
} from "@pascal-app/core";
import {
  buildTimelineNode,
  createPluginNode,
  deletePluginNode,
  installPascalTimeOnScene,
  newPascalTimeNodeId,
  PASCAL_TIME_PLUGIN_ID,
  readPluginNode,
  registerPascalTimeKinds,
  TIMELINE_KIND,
  TimelineNode
} from "../src/index";

/** Pascal's published definition type is looser than what we need to read here. */
type RendererSource = {
  kind: string;
  module: () => Promise<{ default: unknown }>;
};

describe("M1.1 — the kind exists in Pascal", () => {
  it("is absent before the plugin is registered", () => {
    // Guards the rest of the file: if something else already registered the kind, every
    // assertion below would pass without this package having done anything.
    expect(nodeRegistry.has(TIMELINE_KIND)).toBe(false);
  });

  it("registers through loadPlugin, which records the owning plugin id", () => {
    registerPascalTimeKinds();
    expect(nodeRegistry.has(TIMELINE_KIND)).toBe(true);
    // The whole reason to prefer loadPlugin over registerNode. A directly registered
    // definition lands in the registry with NO plugin id, which makes the install gate below
    // answer "enabled" for every project — bypassing the gate rather than satisfying it.
    expect(getNodePluginId(TIMELINE_KIND)).toBe(PASCAL_TIME_PLUGIN_ID);
  });

  it("is registered exactly once however many times bootstrap re-enters", () => {
    registerPascalTimeKinds();
    registerPascalTimeKinds();
    const matching = Array.from(nodeRegistry.entries()).filter(([kind]) => kind === TIMELINE_KIND);
    expect(matching).toHaveLength(1);
  });

  it("is gated on the project having the plugin installed", () => {
    expect(isNodeKindEnabled(TIMELINE_KIND, [])).toBe(false);
    expect(isNodeKindEnabled(TIMELINE_KIND, ["someone-else"])).toBe(false);
    expect(isNodeKindEnabled(TIMELINE_KIND, [PASCAL_TIME_PLUGIN_ID])).toBe(true);
  });
});

describe("M1.1 — installing on a scene", () => {
  it("adds the plugin id without evicting one already installed", () => {
    const scene = useScene.getState();
    scene.setInstalledPlugins(["another-plugin"], { explicit: true });

    installPascalTimeOnScene();

    // setInstalledPlugins REPLACES the list, so a plugin that called it with only its own id
    // would silently uninstall every other plugin on the scene. Merging is the contract.
    expect(useScene.getState().installedPlugins).toEqual(["another-plugin", PASCAL_TIME_PLUGIN_ID]);
  });

  it("does not append a duplicate when called again", () => {
    installPascalTimeOnScene();
    const installed = useScene.getState().installedPlugins;
    expect(installed.filter((id) => id === PASCAL_TIME_PLUGIN_ID)).toHaveLength(1);
  });
});

describe("M1.1 — the renderer contract", () => {
  it("is a lazy parametric module with a default export", async () => {
    const definition = nodeRegistry.get(TIMELINE_KIND);
    const renderer = definition?.renderer as unknown as RendererSource | undefined;

    // Pascal's getRegistryRenderer drops anything that is not this exact shape, without a
    // warning: the kind registers, the scene stays empty, and nothing says why. Asserting the
    // shape is cheap; discovering it in a browser is not.
    expect(renderer?.kind).toBe("parametric");

    const module = await renderer!.module();
    expect(typeof module.default).toBe("function");
  });
});

describe("M1.1 — the capabilities the editor reads", () => {
  const definition = () => nodeRegistry.get(TIMELINE_KIND)!;

  it("is selectable through the registry, with nothing to hit-test in the viewport", () => {
    // isRegistrySelectable is what Pascal's SelectionManager and floating action menu consult;
    // a kind missing from it cannot be selected however correct the rest of the definition is.
    expect(isRegistrySelectable(TIMELINE_KIND)).toBe(true);
    expect(definition().capabilities.selectable).toEqual({ hitVolume: "none" });
  });

  it("is deletable and not duplicable", () => {
    expect(definition().capabilities.deletable).toBe(true);
    // One clock per scene: a second one would be equally authoritative with no rule saying
    // which timeline a given track belongs to.
    expect(definition().capabilities.duplicable).toBe(false);
  });

  it("opts out of dirty tracking, like Pascal's own organisational kinds", () => {
    // No geometry, no system, nothing rebuilds it — so its dirty marks would never be
    // cleared, would accumulate for the whole session, and would defeat every consumer's
    // empty-set early exit each frame.
    expect(definition().dirtyTracking).toBe(false);
  });
});

describe("M1.1 — minting an id for a kind Pascal does not know", () => {
  it("mints in Pascal's own <prefix>_<id> shape, namespaced against collision", () => {
    const id = newPascalTimeNodeId();
    expect(id).toMatch(/^humatime_.+/);
    expect(newPascalTimeNodeId()).not.toBe(id);
  });
});

describe("M1.1 — the node lifecycle in the scene document", () => {
  const NODE_ID = "humatime_lifecycle";

  beforeAll(() => {
    useScene.getState().clearScene();
    useScene.temporal.getState().clear();
    installPascalTimeOnScene();
  });

  it("places as a root node — nothing validates parent kinds, so it needs no home", () => {
    createPluginNode(buildTimelineNode({ id: NODE_ID, name: "Presentation clock" }));
    const state = useScene.getState();
    expect(readPluginNode(NODE_ID)).toBeTruthy();
    expect(state.rootNodeIds).toContain(NODE_ID);
    expect(readPluginNode(NODE_ID)!.parentId).toBeNull();
  });

  it("round-trips its own fields through Pascal as opaque node data", () => {
    // Pascal stores durationSeconds/loop/autoplay the same way it stores a wall's thickness:
    // it never interprets them. That is what lets space and time stay separable while one
    // authored object carries both halves.
    const parsed = TimelineNode.parse(readPluginNode(NODE_ID));
    expect(parsed.durationSeconds).toBe(10);
    expect(parsed.loop).toBe(false);
    expect(parsed.autoplay).toBe(false);
  });

  it("deletes out of the document", () => {
    deletePluginNode(NODE_ID);
    expect(readPluginNode(NODE_ID)).toBeUndefined();
    expect(useScene.getState().rootNodeIds).not.toContain(NODE_ID);
  });

  it("comes back on undo — Pascal owns the structural history, and it works on our kind too", () => {
    useScene.temporal.getState().undo();
    expect(readPluginNode(NODE_ID)).toBeTruthy();
  });
});
