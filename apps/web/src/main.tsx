import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

function blockPinchZoom() {
  const stopGesture = (event: Event) => {
    event.preventDefault();
  };
  document.addEventListener("gesturestart", stopGesture);
  document.addEventListener("gesturechange", stopGesture);
  document.addEventListener(
    "touchmove",
    (event) => {
      if (event.touches.length > 1) event.preventDefault();
    },
    { passive: false },
  );
}

blockPinchZoom();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
