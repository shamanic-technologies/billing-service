/** Fire-and-forget client for transactional-email-service. */

interface SendEmailParams {
  eventType: string;
  orgId: string;
  userId: string;
  runId: string;
  metadata?: Record<string, string | null>;
  workflowHeaders?: Record<string, string>;
}

function getEmailServiceConfig() {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

export function sendEmail(params: SendEmailParams): void {
  const config = getEmailServiceConfig();
  if (!config) {
    console.warn("TRANSACTIONAL_EMAIL_SERVICE not configured — skipping email send");
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": config.apiKey,
    "x-org-id": params.orgId,
    "x-user-id": params.userId,
    "x-run-id": params.runId,
    ...params.workflowHeaders,
  };

  fetch(`${config.url}/send`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      eventType: params.eventType,
      metadata: params.metadata,
    }),
  }).catch((err) => {
    console.error(`Failed to send ${params.eventType} email:`, err);
  });
}
