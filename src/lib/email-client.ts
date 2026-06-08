/** Fire-and-forget client for transactional-email-service. */

interface SendEmailParams {
  eventType: string;
  orgId: string;
  userId: string;
  runId: string;
  /**
   * Explicit recipient (overrides email-service's x-user-id → client-service
   * resolution). Used by the dunning engine to target the org's Stripe billing
   * email. When absent/null, the email-service resolves the recipient from
   * x-user-id.
   */
  recipientEmail?: string | null;
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

  const body: Record<string, unknown> = {
    eventType: params.eventType,
    metadata: params.metadata,
  };
  if (params.recipientEmail) body.recipientEmail = params.recipientEmail;

  fetch(`${config.url}/send`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }).catch((err) => {
    console.error(`[billing-service] Failed to send ${params.eventType} email:`, err);
  });
}
