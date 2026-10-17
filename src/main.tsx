import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./css/App.css";
import { applyDocumentTheme, getAppearanceMode } from "./lib/theme";

applyDocumentTheme(getAppearanceMode());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
