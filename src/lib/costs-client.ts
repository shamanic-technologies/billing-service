/** Client for resolving platform prices from costs-service. */

export interface CostItem {
  costName: string;
  quantity: number;
}

export interface ResolvedPrice {
  name: string;
  pricePerUnitInUsdCents: string;
}

function getCostsServiceConfig() {
  const url = process.env.COSTS_SERVICE_URL;
  const apiKey = process.env.COSTS_SERVICE_API_KEY;
  if (!url || !apiKey) return null;
  return { url, apiKey };
}

/** Resolve the platform price for a single cost name. */
export async function resolvePlatformPrice(
  costName: string,
  headers: Record<string, string>
): Promise<ResolvedPrice> {
  const config = getCostsServiceConfig();
  if (!config) {
    throw new Error("COSTS_SERVICE not configured");
  }

  const res = await fetch(
    `${config.url}/v1/platform-prices/${encodeURIComponent(costName)}`,
    {
      headers: {
        "x-api-key": config.apiKey,
        ...headers,
      },
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Failed to resolve price for ${costName}: ${res.status} ${body}`
    );
  }

  return (await res.json()) as ResolvedPrice;
}

/** Resolve all items and compute total required cents. */
export async function resolveRequiredCents(
  items: CostItem[],
  headers: Record<string, string>
): Promise<number> {
  const prices = await Promise.all(
    items.map((item) => resolvePlatformPrice(item.costName, headers))
  );

  let totalCents = 0;
  for (let i = 0; i < items.length; i++) {
    const unitCost = parseFloat(prices[i].pricePerUnitInUsdCents);
    totalCents += items[i].quantity * unitCost;
  }

  return Math.ceil(totalCents);
}
