/** Fire-and-forget client for posting trace events to runs-service. */

interface TraceEventParams {
  runId: string;
  orgId: string;
  userId: string;
  event: string;
  detail?: Record<string, unknown>;
  workflowHeaders?: Record<string, string>;
}

function getRunsServiceConfig() {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

export function traceEvent(params: TraceEventParams): void {
  if (!params.runId) return;

  const config = getRunsServiceConfig();
  if (!config) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    ...params.workflowHeaders,
  };

  fetch(`${config.url}/v1/runs/${params.runId}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      event: params.event,
      detail: params.detail,
    }),
  }).catch((err) => {
    console.error("[billing-service] Failed to trace event:", err);
  });
}
