import { createContext, useContext, type ReactNode } from "react";
import type { DashboardBackend } from "./dashboardBackend";

const DashboardBackendContext = createContext<DashboardBackend | null>(null);

type Props = {
  backend: DashboardBackend;
  children?: ReactNode;
};

export function DashboardBackendProvider({ backend, children }: Props) {
  return (
    <DashboardBackendContext.Provider value={backend}>
      {children}
    </DashboardBackendContext.Provider>
  );
}

export function useDashboardBackend(): DashboardBackend {
  const backend = useContext(DashboardBackendContext);
  if (!backend) {
    throw new Error("DashboardBackendProvider is missing");
  }
  return backend;
}
