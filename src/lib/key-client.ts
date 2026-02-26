const APP_ID = "billing-service";

function getKeyServiceConfig() {
  const url = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/** Register an app-level secret with key-service (idempotent, safe to call on every cold start). */
export async function registerAppKey(
  provider: string,
  apiKey: string
): Promise<void> {
  const config = getKeyServiceConfig();
  if (!config) {
    console.warn(`KEY_SERVICE not configured — skipping ${provider} registration`);
    return;
  }

  const res = await fetch(`${config.url}/internal/app-keys`, {
    method: "POST",
    headers: {
      "x-api-key": config.apiKey,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      appId: APP_ID,
      provider,
      apiKey,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to register ${provider} key: ${res.status} ${body}`);
  }
}

/** Resolve an app-level secret from key-service at runtime. */
export async function resolveAppKey(provider: string): Promise<string> {
  const config = getKeyServiceConfig();
  if (!config) {
    throw new Error(`KEY_SERVICE not configured — cannot resolve ${provider}`);
  }

  const res = await fetch(
    `${config.url}/internal/app-keys/${encodeURIComponent(provider)}/decrypt?appId=${encodeURIComponent(APP_ID)}`,
    {
      headers: { "x-api-key": config.apiKey },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to resolve ${provider} key: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

/** Register all billing-service secrets at startup. */
export async function registerAllAppKeys(): Promise<void> {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  const registrations: Promise<void>[] = [];

  if (stripeKey) {
    registrations.push(registerAppKey("stripe", stripeKey));
  }
  if (webhookSecret) {
    registrations.push(registerAppKey("stripe-webhook", webhookSecret));
  }

  await Promise.all(registrations);
  console.log("App keys registered with key-service");
}
