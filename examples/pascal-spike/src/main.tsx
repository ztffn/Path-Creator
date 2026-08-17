import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// Registry population MUST happen at module import time, before any React tree renders —
// Pascal's own bootstrap says so and its viewer warns when it finds the registry empty at
// mount. Doing it in an effect leaves <Viewer> resolving every node to null on first render.
import { loadPascalBuiltins } from "./pascal-bootstrap";
import App from "./App";

loadPascalBuiltins();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
