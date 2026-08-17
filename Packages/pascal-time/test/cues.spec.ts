// M1.5: cues are authorable in Pascal and navigable by the timeline. The library owns the pure
// half — lookup and the ride — and has its own tests; what is tested here is the seam. An author
// creates, names, retimes, deletes and undoes cues through Pascal's machinery, and the time
// layer sees only `{ id, name, time }` and never learns that a scene document exists.
// Runs against Pascal's real registry and real store. Scope: authorability and the seam.
import { beforeEach, describe, expect, it } from "vitest";
import { nodeRegistry, sceneRegistry, useScene } from "@pascal-app/core";
import {
  createCueTransport,
  createTimelinePlayer,
  currentCue,
  rideToCue,
  rideToNext,
  stepCueTransport
} from "@huma/path-creator/timeline";
import {
  buildCueNode,
  buildTimelineNode,
  createPluginNode,
  CUE_KIND,
  deletePluginNode,
  installPascalTimeOnScene,
  readCues,
  readPluginNode,
  registerPascalTimeKinds
} from "../src/index";
import { flushFrame } from "./setup";

const CLOCK = "humatime_clock";

/** The authored fixture: one clock and three named moments on it. */
function authorCues(): void {
  useScene.getState().clearScene();
  useScene.temporal.getState().clear();
  installPascalTimeOnScene();

  createPluginNode(buildTimelineNode({ id: CLOCK, name: "Deck", durationSeconds: 12 }));
  createPluginNode(buildCueNode({ id: "cue_intro", name: "Intro", parentId: CLOCK, timeSeconds: 0 }));
  createPluginNode(buildCueNode({ id: "cue_mid", name: "The turbine", parentId: CLOCK, timeSeconds: 4 }));
  createPluginNode(buildCueNode({ id: "cue_end", name: "Close on the hub", parentId: CLOCK, timeSeconds: 9 }));
}

describe("M1.5 — cues are a registered Pascal kind", () => {
  beforeEach(() => registerPascalTimeKinds());

  it("registers alongside the timeline kind", () => {
    expect(nodeRegistry.has(CUE_KIND)).toBe(true);
  });

  it("is selectable, deletable and duplicable, and carries no geometry", () => {
    const definition = nodeRegistry.get(CUE_KIND)!;
    expect(definition.capabilities.selectable).toEqual({ hitVolume: "none" });
    expect(definition.capabilities.deletable).toBe(true);
    // A scene wants many cues, and duplicating one to retime it is a reasonable way to author.
    expect(definition.capabilities.duplicable).toBe(true);
    expect(definition.dirtyTracking).toBe(false);
  });

  it("ships no renderer, and that is the correct answer rather than an omission", () => {
    const definition = nodeRegistry.get(CUE_KIND)!;
    // A cue is a moment, not a thing. Two independent reasons it must not have a renderer:
    // there is no geometry to draw, and one would never mount anyway — Pascal's NodeRenderer
    // renders a node's OWN renderer and does not dispatch children, so anything parented to
    // the timeline node is invisible unless the timeline's renderer dispatches it, which it
    // does not. A renderer here would be dead code that reads as live.
    expect(definition.renderer).toBeUndefined();
    expect(definition.geometry).toBeUndefined();
  });

  it("is therefore absent from the object registry even when authored", () => {
    // Recorded as behaviour rather than left as a surprise: `readCues` reads the scene STORE,
    // so cues work fully while rendering nothing. Anything that expects to find a cue in
    // `sceneRegistry` is asking the wrong map.
    authorCues();
    expect(readCues()).toHaveLength(3);
    expect(sceneRegistry.nodes.has("cue_mid")).toBe(false);
  });
});

describe("M1.5 — authoring cues through Pascal", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    authorCues();
  });

  it("reads the authored cues back as timeline data", () => {
    const cues = readCues();
    expect(cues).toHaveLength(3);
    expect(cues.map((cue) => cue.name).sort()).toEqual([
      "Close on the hub",
      "Intro",
      "The turbine"
    ]);
  });

  it("uses the node id as the cue id, so a reference is a node reference like any other", () => {
    // Not a second identifier with its own stability rules — the same ids R8 already governs.
    expect(readCues().map((cue) => cue.id).sort()).toEqual(["cue_end", "cue_intro", "cue_mid"]);
  });

  it("scopes to one clock when asked, and ignores cues on another", () => {
    createPluginNode(buildTimelineNode({ id: "humatime_other", name: "Other clock" }));
    createPluginNode(
      buildCueNode({ id: "cue_elsewhere", name: "Elsewhere", parentId: "humatime_other", timeSeconds: 2 })
    );

    expect(readCues()).toHaveLength(4);
    expect(readCues(CLOCK).map((cue) => cue.id).sort()).toEqual([
      "cue_end",
      "cue_intro",
      "cue_mid"
    ]);
  });

  it("falls back to the node id when an author has not named the cue", () => {
    createPluginNode(buildCueNode({ id: "cue_unnamed", parentId: CLOCK, timeSeconds: 6 }));
    expect(readCues().find((cue) => cue.id === "cue_unnamed")?.name).toBe("cue_unnamed");
  });

  it("retimes when the author edits the node", async () => {
    useScene.getState().updateNode("cue_mid" as never, { timeSeconds: 7 } as never);
    await flushFrame();
    expect(readCues().find((cue) => cue.id === "cue_mid")?.time).toBe(7);
  });

  it("deletes, and comes back on undo", () => {
    deletePluginNode("cue_mid");
    expect(readCues()).toHaveLength(2);
    expect(readPluginNode("cue_mid")).toBeUndefined();

    useScene.temporal.getState().undo();
    expect(readCues()).toHaveLength(3);
    expect(readCues().find((cue) => cue.id === "cue_mid")?.time).toBe(4);
  });

  it("survives being authored out of order — cues are addressed by time, not by document order", () => {
    useScene.getState().clearScene();
    installPascalTimeOnScene();
    createPluginNode(buildTimelineNode({ id: CLOCK }));
    createPluginNode(buildCueNode({ id: "c", parentId: CLOCK, timeSeconds: 9 }));
    createPluginNode(buildCueNode({ id: "a", parentId: CLOCK, timeSeconds: 0 }));
    createPluginNode(buildCueNode({ id: "b", parentId: CLOCK, timeSeconds: 4 }));

    expect(currentCue(readCues(), 5)?.id).toBe("b");
  });
});

describe("M1.5 — navigating a scene's cues", () => {
  beforeEach(() => {
    registerPascalTimeKinds();
    authorCues();
  });

  it("rides from cue to cue over what the author placed in the document", () => {
    const cues = readCues();
    const player = createTimelinePlayer();
    const transport = createCueTransport();

    expect(rideToNext(transport, player, cues, { seconds: 0 })?.name).toBe("The turbine");
    expect(player.time).toBe(4);
    expect(rideToNext(transport, player, cues, { seconds: 0 })?.name).toBe("Close on the hub");
    expect(player.time).toBe(9);
    expect(rideToNext(transport, player, cues, { seconds: 0 })).toBeNull();
  });

  it("navigates to a cue by the node id a hotspot would store", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    expect(rideToCue(transport, player, readCues(), "cue_end", { seconds: 0 })?.time).toBe(9);
    expect(player.time).toBe(9);
  });

  it("eases to the cue over several frames and lands exactly on it", () => {
    const player = createTimelinePlayer();
    const transport = createCueTransport();
    rideToCue(transport, player, readCues(), "cue_mid", { seconds: 1, easing: "linear" });

    expect(stepCueTransport(transport, player, 0.5)).toBe(true);
    expect(player.time).toBeCloseTo(2, 6);
    expect(stepCueTransport(transport, player, 0.5)).toBe(false);
    expect(player.time).toBe(4);
  });

  it("follows the author when a cue is retimed — no cached copy to go stale", async () => {
    useScene.getState().updateNode("cue_end" as never, { timeSeconds: 11 } as never);
    await flushFrame();

    const player = createTimelinePlayer({ time: 5 });
    const transport = createCueTransport();
    rideToNext(transport, player, readCues(), { seconds: 0 });
    expect(player.time).toBe(11);
  });

  it("stops navigating to a cue the author deleted, without throwing", () => {
    deletePluginNode("cue_end");
    const player = createTimelinePlayer({ time: 5 });
    const transport = createCueTransport();

    // The time layer holds ids it did not mint and cannot repair; a missing cue is a no-op.
    expect(rideToCue(transport, player, readCues(), "cue_end", { seconds: 0 })).toBeNull();
    expect(player.time).toBe(5);
  });
});
