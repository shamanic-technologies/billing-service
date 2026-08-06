/**
 * One-time sweep: attribute an existing brand-level daily ceiling to the ONE
 * sales funnel the brand sells through.
 *
 * WHY THIS EXISTS. Per-funnel ceilings shipped with no backfill, because
 * splitting one brand-level budget across several funnels would invent a split
 * the customer never stated. That is still the rule. It simply does not apply to
 * a brand that sells through exactly one funnel: the whole ceiling belongs to
 * that funnel by construction, there is nothing to invent, and leaving it
 * unrecorded makes brand Settings render "$0/day" on the funnel of a brand that
 * is being charged against a real ceiling.
 *
 * WHAT IT IS NOT. Not a budget change. The brand-level read answers the SUM of
 * the ceilings once any exist, so a single ceiling equal to the scalar it
 * replaces returns the identical figure — including its `updated_at`, which is
 * copied rather than re-stamped. No org's charge moves.
 *
 * WHAT IT REFUSES. A brand declaring several funnels, a brand declaring none, an
 * unfunded (0) ceiling, and any brand that already carries a funnel ceiling a
 * human set. Each is logged with its reason and left exactly as it is.
 *
 * Dry-run by DEFAULT. Pass --apply to write.
 *
 *   BILLING_SERVICE_DATABASE_URL=... BRAND_SERVICE_URL=... BRAND_SERVICE_API_KEY=... \
 *     npx tsx scripts/attribute-single-funnel-budget.ts [--apply]
 *
 * Fail-loud throughout: a brand-service read that fails, or a funnel spelling
 * billing cannot name, ABORTS the sweep rather than being skipped — a skip is
 * indistinguishable from "this brand declared nothing", which is one of the
 * legitimate outcomes.
 */

import { and, eq } from "drizzle-orm";
import { db, sql } from "../src/db/index.js";
import { brandDailyBudgets, brandFunnelDailyBudgets } from "../src/db/schema.js";
import {
  attributeBrandBudgetToSingleFunnel,
  decideAttribution,
} from "../src/lib/single-funnel-attribution.js";

const APPLY = process.argv.includes("--apply");

const BRAND_SERVICE_URL = process.env.BRAND_SERVICE_URL;
const BRAND_SERVICE_API_KEY = process.env.BRAND_SERVICE_API_KEY;

if (!BRAND_SERVICE_URL || !BRAND_SERVICE_API_KEY) {
  console.error(
    "[attribute-single-funnel-budget] BRAND_SERVICE_URL and BRAND_SERVICE_API_KEY are required"
  );
  process.exit(1);
}

interface DeclaredFunnel {
  funnelKey?: string;
}

/**
 * The funnels this ORG actively sells this brand through.
 *
 * `x-org-id` is mandatory here, not optional: several orgs legitimately claim
 * the same brand, and brand-service's internal read only auto-resolves the org
 * when exactly one does. Two of the brands in scope are claimed by several orgs,
 * so an org-less read would 400 on them — and answering with another org's
 * declaration would attribute this org's money against a funnel it never chose.
 */
async function fetchDeclaredFunnelKeys(
  orgId: string,
  brandId: string
): Promise<string[]> {
  const res = await fetch(
    `${BRAND_SERVICE_URL}/internal/brands/${brandId}/sales-funnels`,
    {
      method: "GET",
      headers: {
        "x-api-key": BRAND_SERVICE_API_KEY!,
        "x-org-id": orgId,
      },
      signal: AbortSignal.timeout(15_000),
    }
  );
  if (!res.ok) {
    throw new Error(
      `brand-service /internal/brands/${brandId}/sales-funnels -> ${res.status} for org ${orgId}`
    );
  }
  const body = (await res.json()) as { funnels?: DeclaredFunnel[] };
  const funnels = Array.isArray(body.funnels) ? body.funnels : [];
  return funnels
    .map((f) => f.funnelKey)
    .filter((key): key is string => typeof key === "string" && key !== "");
}

async function main(): Promise<void> {
  console.log(
    `[attribute-single-funnel-budget] mode=${APPLY ? "APPLY" : "DRY-RUN"}`
  );

  const scalars = await db.select().from(brandDailyBudgets);
  console.log(
    `[attribute-single-funnel-budget] ${scalars.length} brand-level ceiling row(s) to consider`
  );

  let attributed = 0;
  let skipped = 0;

  for (const row of scalars) {
    const label = `org ${row.orgId} brand ${row.brandId} @ ${row.dailyBudgetCents}`;

    // Never overwrite a ceiling a human already set. Checked before the
    // brand-service read so an already-migrated brand costs nothing.
    const existingFunnels = await db
      .select({ funnelKey: brandFunnelDailyBudgets.funnelKey })
      .from(brandFunnelDailyBudgets)
      .where(
        and(
          eq(brandFunnelDailyBudgets.orgId, row.orgId),
          eq(brandFunnelDailyBudgets.brandId, row.brandId)
        )
      )
      .limit(1);
    if (existingFunnels.length > 0) {
      skipped++;
      console.log(`  SKIP  ${label} — already funnel-funded`);
      continue;
    }

    const declaredFunnelKeys = await fetchDeclaredFunnelKeys(
      row.orgId,
      row.brandId
    );
    const decision = decideAttribution({
      brandId: row.brandId,
      dailyBudgetCents: row.dailyBudgetCents,
      declaredFunnelKeys,
    });

    if (!decision.attribute) {
      skipped++;
      console.log(`  SKIP  ${label} — ${decision.reason}`);
      continue;
    }

    if (!APPLY) {
      attributed++;
      console.log(
        `  WOULD ${label} -> funnel ${decision.funnelKey} (brand total unchanged)`
      );
      continue;
    }

    const outcome = await attributeBrandBudgetToSingleFunnel(
      row.orgId,
      row.brandId,
      decision.funnelKey
    );
    if (!outcome.applied) {
      skipped++;
      console.log(`  SKIP  ${label} — ${outcome.reason}`);
      continue;
    }
    attributed++;
    console.log(
      `  DONE  ${label} -> funnel ${outcome.funnelKey} @ ${outcome.dailyBudgetCents}`
    );
  }

  // Read the result back from the DB rather than reporting the loop's own
  // counters: a re-run of an idempotent sweep prints zeros, which is
  // indistinguishable from "found nothing".
  const [{ count: funnelFunded }] = await sql<{ count: string }[]>`
    SELECT count(DISTINCT (org_id, brand_id))::text AS count
    FROM brand_funnel_daily_budgets
  `;
  const [{ count: scalarFunded }] = await sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM brand_daily_budgets
  `;

  console.log(
    `[attribute-single-funnel-budget] ${APPLY ? "attributed" : "would attribute"}=${attributed} skipped=${skipped}`
  );
  console.log(
    `[attribute-single-funnel-budget] DB now: ${funnelFunded} funnel-funded org+brand pair(s), ${scalarFunded} brand-level scalar row(s)`
  );
}

main()
  .then(async () => {
    await sql.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("[attribute-single-funnel-budget] FAILED:", err);
    await sql.end();
    process.exit(1);
  });
