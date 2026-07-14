import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").then(
      (registration) => console.log("[SAIVerse Lite][PWA] service worker registered", registration.scope),
      (error) => console.warn("[SAIVerse Lite][PWA] service worker registration failed", error),
    );
  });
}
