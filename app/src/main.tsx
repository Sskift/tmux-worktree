import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DashboardBackendProvider } from "./platform";
import { tauriDashboardBackend } from "./platform/tauriBackend";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <DashboardBackendProvider backend={tauriDashboardBackend}>
      <App />
    </DashboardBackendProvider>
  </React.StrictMode>,
);
