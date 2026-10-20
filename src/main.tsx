import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { initializeEditorAppearance } from "./lib/editorAppearance";
import { initializeTheme } from "./lib/theme";

initializeTheme();
initializeEditorAppearance();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
