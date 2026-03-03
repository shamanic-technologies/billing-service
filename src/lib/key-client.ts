export interface CallerContext {
  service: string;
  method: string;
  path: string;
}

export interface KeyResolution {
  key: string;
  keySource: "platform" | "org";
}

const DEFAULT_CALLER: CallerContext = {
  service: "billing",
  method: "GET",
  path: "/v1/accounts",
};

function getKeyServiceConfig() {
  const url = process.env.KEY_SERVICE_URL;
  const apiKey = process.env.KEY_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/** Resolve a provider key from key-service. Returns the key and its source (platform or org). */
export async function resolveProviderKey(
  provider: string,
  orgId: string,
  userId: string,
  caller: CallerContext = DEFAULT_CALLER
): Promise<KeyResolution> {
  const config = getKeyServiceConfig();
  if (!config) {
    throw new Error(`KEY_SERVICE not configured — cannot resolve ${provider}`);
  }

  const params = new URLSearchParams({ orgId, userId });
  const res = await fetch(
    `${config.url}/keys/${encodeURIComponent(provider)}/decrypt?${params}`,
    {
      headers: {
        "x-api-key": config.apiKey,
        "x-caller-service": caller.service,
        "x-caller-method": caller.method,
        "x-caller-path": caller.path,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to resolve ${provider} key for org ${orgId}: ${res.status} ${body}`
    );
  }

  const data = (await res.json()) as KeyResolution;
  return data;
}
