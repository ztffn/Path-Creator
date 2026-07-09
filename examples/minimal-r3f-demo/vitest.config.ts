// Vitest config for the demo's pure audio helpers (gain envelope, peak windowing,
// clip resize). Node environment — these are plain functions with no DOM/WebAudio.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.spec.ts"] }
});
