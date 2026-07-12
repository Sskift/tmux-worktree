import { useCallback } from "react";
import { useDashboardBackend } from "../../platform";
import {
  loadDashboardLayoutPreferences,
  saveDashboardLayoutPreferences,
} from "../layoutPersistence";
import type { DashboardLayoutPreferences } from "../layout/types";

export function useLayoutPreferences() {
  const backend = useDashboardBackend();

  const loadLayoutPreferences = useCallback(
    () => loadDashboardLayoutPreferences(backend),
    [backend],
  );
  const saveLayoutPreferences = useCallback(
    (preferences: DashboardLayoutPreferences) =>
      saveDashboardLayoutPreferences(backend, preferences),
    [backend],
  );

  return { loadLayoutPreferences, saveLayoutPreferences };
}
