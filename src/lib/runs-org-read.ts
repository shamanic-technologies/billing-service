/**
 * A runs-service read as one org (x-org-id), fail-loud on non-2xx. Used by the
 * sales funnel caps measurement (lib/sales-funnel-caps.ts).
 */
import { fetchWithRetry } from "./fetch-retry.js";

function runsConfig() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be configured");
  }
  return { url, apiKey };
}

/** GET a runs-service read as this org (x-org-id), fail-loud on non-2xx. */
export async function readJson<T>(path: string, orgId: string, params: URLSearchParams): Promise<T> {
  const { url, apiKey } = runsConfig();
  const res = await fetchWithRetry(`${url}${path}?${params}`, {
    headers: { "x-api-key": apiKey, "x-org-id": orgId },
  });
  if (!res.ok) {
    throw new Error(`runs-service ${path} failed (${res.status}): ${await res.text()}`);
  }
  return (await res.json()) as T;
}
