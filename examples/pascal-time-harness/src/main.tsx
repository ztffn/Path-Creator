// Entry point. Both plugins register HERE, at module import time, before any React tree
// renders — Pascal's viewer resolves nodes against the registry on its first pass, so a kind
// registered from an effect leaves every node of that kind resolving to null on first render.
// The order matters only in that both must be done before `createRoot`.
// Scope: harness bootstrap.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { loadPlugin, nodeRegistry } from "@pascal-app/core";
import { registerPascalTimeKinds } from "@huma/pascal-time";
import { harnessPlugin, MARKER_KIND } from "./kinds";
import App from "./App";
import BakeApp from "./bake-app";

registerPascalTimeKinds();
if (!nodeRegistry.has(MARKER_KIND)) void loadPlugin(harnessPlugin);

// `?mode=bake` runs the bake-measurement shell over the exported artifact instead of the
// authored harness scene. A query switch rather than a route: the harness has no router, and
// the two shells must share one bundle so the bake check measures THIS bundle's dependencies.
const mode = new URLSearchParams(window.location.search).get("mode");

createRoot(document.getElementById("root")!).render(
  <StrictMode>{mode === "bake" ? <BakeApp /> : <App />}</StrictMode>
);
