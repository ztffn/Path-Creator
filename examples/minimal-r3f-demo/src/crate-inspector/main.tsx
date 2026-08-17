import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CrateInspector from "./CrateInspector";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrateInspector />
  </StrictMode>
);
