import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  // ESM only. Every dependency of this package — Pascal's three packages and
  // path-creator's ESM build — is ESM, and Pascal's registries are module-level
  // singletons, so a CJS copy would be a second registry rather than a fallback.
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false
});
