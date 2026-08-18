import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "host-panel/index": "src/host-panel/index.tsx"
  },
  // ESM only. Every dependency of this package — Pascal's three packages and
  // path-creator's ESM build — is ESM, and Pascal's registries are module-level
  // singletons, so a CJS copy would be a second registry rather than a fallback.
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  // Splitting is load-bearing, not an optimization: both entries import the transport store
  // and the plugin internals, and without shared chunks each entry would inline its OWN COPY —
  // two stores, a panel scrubbing a clock no driver reads. test/host-panel.spec.ts asserts it.
  splitting: true
});
