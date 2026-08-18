import { defineConfig } from "vitest/config";

export default defineConfig({
  // @pascal-app/editor ships raw TSX written for the automatic JSX runtime; without this the
  // inlined transform emits classic `React.createElement` calls and evaluation throws
  // "React is not defined" at the first JSX expression in module scope.
  esbuild: { jsx: "automatic" },
  test: {
    // Pascal's published bundles use directory imports (`./events/bus`), which plain
    // Node ESM rejects — the documented "bundler-only" constraint. Inlining routes them
    // through Vite's resolver instead, which is what lets these tests run against
    // Pascal's REAL store and REAL registry rather than a stand-in shaped like them.
    server: { deps: { inline: [/@pascal-app\//] } },
    // Supplies requestAnimationFrame, without which Pascal's dirty marking silently never
    // runs and the "driving leaves the document alone" assertions measure nothing.
    setupFiles: ["./test/setup.ts"]
  }
});
