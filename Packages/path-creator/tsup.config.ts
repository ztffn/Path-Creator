import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "core/index": "src/core/index.ts",
    "three/index": "src/three/index.ts",
    "r3f/index": "src/r3f/index.ts",
    "timeline/index": "src/timeline/index.ts"
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false
});
