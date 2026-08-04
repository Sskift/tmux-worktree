import { useCallback } from "react";
import { useDashboardBackend } from "../../platform";
import {
  loadDashboardLayoutPreferences,
  saveDashboardLayoutPreferences,
} from "../layoutPersistence";
import type { DashboardLayoutExtensions } from "../layout/schema";
import type { DashboardLayoutPreferences } from "../layout/types";
import type { DashboardLayoutRevision } from "../../platform/domainTypes";

export function useLayoutPreferences() {
  const backend = useDashboardBackend();

  const loadLayoutPreferences = useCallback(
    () => loadDashboardLayoutPreferences(backend),
    [backend],
  );
  const saveLayoutPreferences = useCallback(
    (
      preferences: DashboardLayoutPreferences,
      expectedRevision: DashboardLayoutRevision,
      extensions?: DashboardLayoutExtensions,
    ) => saveDashboardLayoutPreferences(
      backend,
      preferences,
      expectedRevision,
      extensions,
    ),
    [backend],
  );

  return { loadLayoutPreferences, saveLayoutPreferences };
}
