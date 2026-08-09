import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Application } from "./Application";

const rootElement = document.getElementById("root");
if (rootElement === null) {
  throw new Error("The dashboard root element is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <Application />
  </StrictMode>,
);
