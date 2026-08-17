import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Pascal's published bundles use directory imports (`./events/bus`), which plain
    // Node ESM rejects — the documented "bundler-only" constraint. Inlining routes them
    // through Vite's resolver instead, which is what lets these tests run against
    // Pascal's REAL store and REAL registry rather than a stand-in shaped like them.
    server: { deps: { inline: [/@pascal-app\//] } }
  }
});
