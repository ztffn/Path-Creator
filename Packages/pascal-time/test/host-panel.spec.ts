// The host-panel contract, asserted against Pascal's REAL editor registry (trap 13's standard:
// a real registry beats a stand-in shaped like one) — registration, kind mapping, the lazy
// default-export module that fails silently if got wrong (trap 1's shape) — plus the build-shape
// control: tsup must emit the editor import as external and both entries must share the
// transport chunk, because a duplicated chunk is TWO stores and a panel no driver hears.
// Scope: src/host-panel/* and the package split itself.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { editorHostPanelRegistry } from "@pascal-app/editor";
import { PASCAL_TIME_PANEL_ID, registerPascalTimeHostPanel } from "../src/host-panel";
import { CUE_KIND, SHOT_KIND, TIMELINE_KIND } from "../src/plugin/kinds";

describe("registering the timeline panel", () => {
  it("lands in the editor's registry and maps every huma-time kind to the panel", () => {
    registerPascalTimeHostPanel();

    const listed = editorHostPanelRegistry.getSnapshot().find((p) => p.id === PASCAL_TIME_PANEL_ID);
    expect(listed).toBeDefined();
    expect(listed?.pluginId).toBe("huma-time");
    expect(listed?.defaultInstalled).toBe(true);

    expect(editorHostPanelRegistry.panelForKind(TIMELINE_KIND)).toBe(PASCAL_TIME_PANEL_ID);
    expect(editorHostPanelRegistry.panelForKind(CUE_KIND)).toBe(PASCAL_TIME_PANEL_ID);
    expect(editorHostPanelRegistry.panelForKind(SHOT_KIND)).toBe(PASCAL_TIME_PANEL_ID);
    // Pascal's own kinds stay unclaimed — a plugin that shadowed them would break the editor.
    expect(editorHostPanelRegistry.panelForKind("wall")).toBeUndefined();
  });

  it("is idempotent — bootstrap modules re-run under HMR and must not throw or duplicate", () => {
    registerPascalTimeHostPanel();
    registerPascalTimeHostPanel();
    const matches = editorHostPanelRegistry
      .getSnapshot()
      .filter((p) => p.id === PASCAL_TIME_PANEL_ID);
    expect(matches).toHaveLength(1);
  });

  it("the lazy module resolves with a component default export — trap 1's silent failure", async () => {
    registerPascalTimeHostPanel();
    const panel = editorHostPanelRegistry
      .getSnapshot()
      .find((p) => p.id === PASCAL_TIME_PANEL_ID);
    const module_ = await panel?.component();
    expect(typeof module_?.default).toBe("function");
  });
});

describe("the package split (built shape)", () => {
  it("host-panel keeps the editor external, the runtime never names it, and both share chunks", async () => {
    const { build } = await import("tsup");
    const outDir = mkdtempSync(join(tmpdir(), "pascal-time-split-"));
    try {
      await build({
        entry: { index: "src/index.ts", "host-panel/index": "src/host-panel/index.tsx" },
        format: ["esm"],
        outDir,
        splitting: true,
        dts: false,
        sourcemap: false,
        clean: false,
        silent: true,
        config: false
      });

      const runtime = readFileSync(join(outDir, "index.js"), "utf8");
      const hostPanel = readFileSync(join(outDir, "host-panel/index.js"), "utf8");

      // The deployment boundary: the runtime entry must never name the editor package —
      // one import and elastiq's Vite bundle inherits Next (plan §0b).
      expect(runtime).not.toContain("@pascal-app/editor");
      // The panel entry must import the REAL editor at runtime, not a paths-stubbed copy —
      // the tsconfig `paths` mapping exists only for the type-checker.
      expect(hostPanel).toContain("@pascal-app/editor");

      // The single-store guarantee: both entries import at least one common shared chunk.
      // Without splitting each entry inlines its own transport store — two clocks, silently.
      const chunkRefs = (source: string): Set<string> =>
        new Set(
          [...source.matchAll(/from\s*["']([^"']*chunk-[^"']+)["']/g)].map((m) =>
            m[1]!.replace(/^\.\.?\//, "")
          )
        );
      const shared = [...chunkRefs(runtime)].filter((chunk) => {
        const fromPanel = chunkRefs(hostPanel);
        // The panel imports chunks as "../chunk-x" (it sits one level down); normalize both.
        return fromPanel.has(chunk);
      });
      expect(shared.length).toBeGreaterThan(0);

      // Control: the regex actually matches this build's output — an emptied instrument would
      // otherwise let both assertions above pass on a build with no chunks at all.
      expect(readdirSync(outDir).some((f) => f.startsWith("chunk-"))).toBe(true);
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
