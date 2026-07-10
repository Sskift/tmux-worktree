import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DashboardBackendProvider, type DashboardBackend } from "./platform";
import { tauriDashboardBackend } from "./platform/tauriBackend";

async function resolveDashboardBackend(): Promise<DashboardBackend> {
  const previewRequested =
    import.meta.env.DEV &&
    new URLSearchParams(window.location.search).get("backend") === "fake";
  if (!previewRequested) return tauriDashboardBackend;
  const preview = await import("./platform/previewBackend");
  return preview.previewDashboardBackend;
}

function renderDashboard(dashboardBackend: DashboardBackend) {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DashboardBackendProvider backend={dashboardBackend}>
        <App />
      </DashboardBackendProvider>
    </React.StrictMode>,
  );
}

void resolveDashboardBackend().then(renderDashboard);
