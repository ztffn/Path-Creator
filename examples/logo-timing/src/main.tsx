import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

document.documentElement.style.height = "100%";
document.body.style.height = "100%";
document.body.style.margin = "0";

const rootElement = document.getElementById("root")!;
rootElement.style.height = "100%";

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>
);
