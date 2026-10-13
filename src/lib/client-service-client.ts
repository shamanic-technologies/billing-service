import { fetchWithRetry } from "./fetch-retry.js";

/**
 * client-service reads for staff surfaces: the org's NAME and the people using it.
 * X-API-Key only. Fail-loud: a staff figure that names or classifies an org must not
 * guess when client-service cannot be asked.
 */

const READ_TIMEOUT_MS = 20_000;

function config(): { url: string; apiKey: string } {
  const url = process.env.CLIENT_SERVICE_URL;
  const apiKey = process.env.CLIENT_SERVICE_API_KEY;
  if (!url || !apiKey) throw new Error("[billing-service] CLIENT_SERVICE_URL / CLIENT_SERVICE_API_KEY not configured");
  return { url, apiKey };
}

/**
 * `POST /internal/orgs/names`: each org's display name (stored, else Clerk's), in
 * batches of 1000. null = the org holds no name; an org client-service does not know
 * is absent from the map.
 */
export async function fetchOrgNames(orgIds: string[]): Promise<Map<string, string | null>> {
  const { url, apiKey } = config();
  const out = new Map<string, string | null>();
  const unique = [...new Set(orgIds)];
  for (let i = 0; i < unique.length; i += 1000) {
    const res = await fetchWithRetry(`${url}/internal/orgs/names`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({ orgIds: unique.slice(i, i + 1000) }),
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`client-service POST /internal/orgs/names failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { orgs?: Array<{ orgId: string; name: string | null }> };
    if (!Array.isArray(body?.orgs)) throw new Error("client-service org names answered an unusable shape");
    for (const o of body.orgs) out.set(o.orgId, typeof o.name === "string" && o.name.trim() ? o.name.trim() : null);
  }
  return out;
}

/** `GET /internal/users?orgId=`: emails of the people whose org it is (client-service users). */
export async function fetchOrgUserEmails(orgId: string): Promise<string[]> {
  const { url, apiKey } = config();
  const res = await fetchWithRetry(`${url}/internal/users?orgId=${encodeURIComponent(orgId)}`, {
    headers: { "x-api-key": apiKey },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`client-service GET /internal/users?orgId=${orgId} failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { users?: Array<{ email?: string | null }> };
  if (!Array.isArray(body?.users)) throw new Error(`client-service users of org ${orgId} answered an unusable shape`);
  return body.users.map((u) => u.email ?? "").filter((e) => e !== "");
}
