// The hotspot's data shape, split from both the definition and the renderer so the lazily
// imported renderer module does not pull the definition (and therefore the plugin manifest)
// back in. The `action` field is the boundary made concrete: Pascal round-trips it as opaque
// node data, exactly as it round-trips a wall's thickness, and only the time layer reads it.
// Scope: spike harness proving the contract, not a shipped kind.
import { z } from "zod";
import { BaseNode } from "@pascal-app/core";

export const HotspotAction = z.object({
  type: z.enum(["seek", "play", "pause"]).default("seek"),
  seconds: z.number().default(0)
});

export const HotspotNode = BaseNode.extend({
  type: z.literal("huma:hotspot").default("huma:hotspot"),
  position: z.tuple([z.number(), z.number(), z.number()]).default([0, 0, 0]),
  label: z.string().default("Hotspot"),
  action: HotspotAction.default({ type: "seek", seconds: 0 })
});

export type HotspotNodeType = z.infer<typeof HotspotNode>;

/** Clicks captured by the renderer. A real host would dispatch these as timeline actions. */
export const hotspotClicks: Array<{ id: string; action: HotspotNodeType["action"] }> = [];
