// Vitest config for the timing model — pure functions over a plain record, no DOM.
// The stage that turns that record into animations is verified in a browser instead.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.spec.ts"] }
});
