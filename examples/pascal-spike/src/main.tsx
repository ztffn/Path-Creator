import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Registry population MUST happen at module import time, before any React tree renders.
// Doing it in an effect leaves the first render resolving every node to null.
import { loadSceneKinds } from "./pascal-bootstrap";
import App from "./App";

loadSceneKinds();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
