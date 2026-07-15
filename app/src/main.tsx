import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import type { RelayV2EnrollmentState } from "./dashboard/Settings/relayV2EnrollmentModel";
import { DashboardBackendProvider, type DashboardBackend } from "./platform";

interface ResolvedDashboard {
  backend: DashboardBackend;
  relayV2Enrollment?: RelayV2EnrollmentState;
}

async function resolveDashboard(): Promise<ResolvedDashboard> {
  const localWebPreview =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";
  const previewRequested =
    (import.meta.env.DEV || localWebPreview) &&
    new URLSearchParams(window.location.search).get("backend") === "fake";
  if (previewRequested) {
    const [preview, relayV2Preview] = await Promise.all([
      import("./platform/previewBackend"),
      import("./dashboard/Settings/relayV2EnrollmentPreview"),
    ]);
    return {
      backend: preview.previewDashboardBackend,
      relayV2Enrollment: relayV2Preview.previewRelayV2EnrollmentState,
    };
  }
  const tauri = await import("./platform/tauriBackend");
  return { backend: tauri.tauriDashboardBackend };
}

function renderDashboard({ backend, relayV2Enrollment }: ResolvedDashboard) {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <DashboardBackendProvider backend={backend}>
        <App relayV2Enrollment={relayV2Enrollment} />
      </DashboardBackendProvider>
    </React.StrictMode>,
  );
}

void resolveDashboard().then(renderDashboard);
