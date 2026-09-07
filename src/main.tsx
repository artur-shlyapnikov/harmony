import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Provider } from "react-redux";
import { BrowserRouter } from "react-router-dom";
import { App } from "./app/App";
import { store } from "./app/store";
import { registerAutosaveFlushTriggers } from "./app/listeners";
import { ErrorBoundary } from "@shared/ErrorBoundary";
import "./styles/global.css";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Missing #root container element");
}

// §3.22: pending debounced autosave must survive page close/reload.
registerAutosaveFlushTriggers();

createRoot(container).render(
  <StrictMode>
    <Provider store={store}>
      <BrowserRouter>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </BrowserRouter>
    </Provider>
  </StrictMode>,
);
