import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Single entry on purpose. `crate-inspector.html` is a reference prototype for the
// inspection work (see docs/plans/2026-07-15-…-handover.md §11) and is meant to be read and
// run locally, not shipped: the dev server resolves it on demand, and leaving it out of
// `build.rollupOptions.input` keeps it out of any deployed bundle. Add it there if it ever
// becomes something to publish.
export default defineConfig({
  plugins: [react()]
});
