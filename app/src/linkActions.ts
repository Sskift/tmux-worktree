import type { DashboardBackend } from "./platform";

export async function checkFileExists(
  dashboardBackend: DashboardBackend,
  absolutePath: string,
  hostId?: string | null,
): Promise<boolean> {
  try {
    return hostId
      ? await dashboardBackend.files.existsRemote(hostId, absolutePath)
      : await dashboardBackend.files.exists(absolutePath);
  } catch {
    return false;
  }
}

export async function openUrlInBrowser(
  dashboardBackend: DashboardBackend,
  url: string,
): Promise<void> {
  await dashboardBackend.files.openUrl(url);
}
