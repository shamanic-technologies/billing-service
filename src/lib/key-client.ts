export interface CallerContext {
  service: string;
  method: string;
  path: string;
}

export interface IdentityContext {
  orgId: string;
  userId: string;
  workflowHeaders?: Record<string, string>;
}

export interface PlatformKeyResponse {
  provider: string;
  key: string;
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

/** Resolve a platform key from key-service. Forwards identity headers required by key-service. */
export async function resolvePlatformKey(
  provider: string,
  identity: IdentityContext,
  caller: CallerContext = DEFAULT_CALLER
): Promise<PlatformKeyResponse> {
  const config = getKeyServiceConfig();
  if (!config) {
    throw new Error(`KEY_SERVICE not configured — cannot resolve ${provider}`);
  }

  const res = await fetch(
    `${config.url}/keys/platform/${encodeURIComponent(provider)}/decrypt`,
    {
      headers: {
        "x-api-key": config.apiKey,
        "x-org-id": identity.orgId,
        "x-user-id": identity.userId,
        "x-caller-service": caller.service,
        "x-caller-method": caller.method,
        "x-caller-path": caller.path,
        ...identity.workflowHeaders,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to resolve platform key for ${provider}: ${res.status} ${body}`
    );
  }

  return (await res.json()) as PlatformKeyResponse;
}
