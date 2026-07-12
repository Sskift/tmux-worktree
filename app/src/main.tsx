import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { DashboardBackendProvider, type DashboardBackend } from "./platform";

async function resolveDashboardBackend(): Promise<DashboardBackend> {
  const localWebPreview =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const previewRequested =
    (import.meta.env.DEV || localWebPreview) &&
    new URLSearchParams(window.location.search).get("backend") === "fake";
  if (previewRequested) {
    const preview = await import("./platform/previewBackend");
    return preview.previewDashboardBackend;
  }
  const tauri = await import("./platform/tauriBackend");
  return tauri.tauriDashboardBackend;
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
