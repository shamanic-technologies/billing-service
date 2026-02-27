export type KeySource = "app" | "byok" | "platform";

export interface CallerContext {
  service: string;
  method: string;
  path: string;
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

/** Resolve an app-level secret from key-service at runtime. */
export async function resolveAppKey(
  provider: string,
  appId: string,
  caller: CallerContext = DEFAULT_CALLER
): Promise<string> {
  const config = getKeyServiceConfig();
  if (!config) {
    throw new Error(`KEY_SERVICE not configured — cannot resolve ${provider}`);
  }

  const res = await fetch(
    `${config.url}/internal/app-keys/${encodeURIComponent(provider)}/decrypt?appId=${encodeURIComponent(appId)}`,
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
    throw new Error(`Failed to resolve ${provider} key for app ${appId}: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

/** Resolve a BYOK secret from key-service (user's own key, resolved by orgId). */
export async function resolveByokKey(
  provider: string,
  orgId: string,
  caller: CallerContext = DEFAULT_CALLER
): Promise<string> {
  const config = getKeyServiceConfig();
  if (!config) {
    throw new Error(`KEY_SERVICE not configured — cannot resolve ${provider}`);
  }

  const res = await fetch(
    `${config.url}/internal/keys/${encodeURIComponent(provider)}/decrypt?orgId=${encodeURIComponent(orgId)}`,
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
    throw new Error(`Failed to resolve ${provider} BYOK key for org ${orgId}: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

/** Resolve a platform-level secret from key-service. */
export async function resolvePlatformKey(
  provider: string,
  caller: CallerContext = DEFAULT_CALLER
): Promise<string> {
  const config = getKeyServiceConfig();
  if (!config) {
    throw new Error(`KEY_SERVICE not configured — cannot resolve ${provider}`);
  }

  const res = await fetch(
    `${config.url}/internal/platform-keys/${encodeURIComponent(provider)}/decrypt`,
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
    throw new Error(`Failed to resolve ${provider} platform key: ${res.status} ${body}`);
  }

  const data = (await res.json()) as { key: string };
  return data.key;
}

/** Unified key resolver — dispatches to the correct key-service path based on keySource. */
export async function resolveKey(
  provider: string,
  keySource: KeySource,
  opts: { appId?: string; orgId?: string },
  caller: CallerContext = DEFAULT_CALLER
): Promise<string> {
  switch (keySource) {
    case "app": {
      if (!opts.appId) throw new Error("appId is required for keySource 'app'");
      return resolveAppKey(provider, opts.appId, caller);
    }
    case "byok": {
      if (!opts.orgId) throw new Error("orgId is required for keySource 'byok'");
      return resolveByokKey(provider, opts.orgId, caller);
    }
    case "platform": {
      return resolvePlatformKey(provider, caller);
    }
  }
}
