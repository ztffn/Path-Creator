import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "three/index": "src/three/index.ts",
    "r3f/index": "src/r3f/index.ts",
    "timeline/index": "src/timeline/index.ts",
    "timeline-ui/index": "src/timeline-ui/index.tsx"
  },
  // timeline-ui imports the @xzdarcy editor CSS; inject it into the emitted JS
  // so consumers get the styles from a plain import with no separate CSS step.
  injectStyle: true,
  // Dual format: browsers/bundlers take ESM; Node-side consumers that load
  // through a CJS bundle (e.g. Vite config files whose middleware imports the
  // package) need the require condition.
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false
});
