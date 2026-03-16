import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { Toaster } from "react-hot-toast";
import { initializeTheme } from "./hooks/useTheme";

// Initialize theme before React renders to prevent flash of wrong theme
initializeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Toaster toastOptions={{ className: "dark:bg-card dark:text-foreground" }} />
  </React.StrictMode>
);
