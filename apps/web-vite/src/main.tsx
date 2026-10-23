import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ToastProvider } from "./ui/toast";
import "./styles.css";
import "./ui/ui.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("React root element is missing");

createRoot(rootElement).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
