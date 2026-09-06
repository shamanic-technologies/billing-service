/**
 * One-time backfill: give every existing ceiling the funnel LEG of the campaign
 * it already paces.
 *
 * WHY (2026-09-06 incident). A campaign is keyed on its funnel LEG and every
 * live campaign states one; migration 0039 gave the ceiling the same grain but
 * left `leg_key` NULL on all 24 production rows, with no way to fill it. So the
 * money said "no leg" while the campaign said a leg, campaign-service could not
 * find the campaign a ceiling already paced, and it provisioned a twin: five
 * brands ran two identical live campaigns for about an hour and roughly $109 of
 * five customers' budgets was spent twice.
 *
 * The leg is READ, never derived — see `lib/campaign-leg-attribution.ts` for the
 * rule and for what is refused. Amounts are never touched.
 *
 * DRY-RUN BY DEFAULT. Pass --apply to write.
 *
 *   BILLING_SERVICE_DATABASE_URL=... CAMPAIGN_SERVICE_URL=... CAMPAIGN_SERVICE_API_KEY=... \
 *     node dist/scripts/backfill-ceiling-legs.js [--apply]
 *
 * It lives under `src/` on purpose: `tsconfig.json` compiles `src/**` only, so
 * this is the one place a maintenance entrypoint is carried into the deployed
 * image, where the production database is reachable and the code is the same
 * code the service runs.
 *
 * FAIL-LOUD. A campaign-service read that fails ABORTS the whole sweep rather
 * than skipping the brand: a skip is indistinguishable from "no campaign stands
 * behind these ceilings", which is one of the legitimate leave-alone outcomes.
 */

import { sql } from "../db/index.js";
import {
  attributeCeilingLeg,
  decideLegAttributions,
} from "../lib/campaign-leg-attribution.js";
import { fetchSpendableBudget } from "../lib/campaign-service-client.js";

const APPLY = process.argv.includes("--apply");
const TAG = "[backfill-ceiling-legs]";

interface ReportRow {
  orgId: string;
  brandId: string;
  funnelKey: string;
  featureSlug: string;
  offerId: string;
  legKey: string;
  campaignId: string;
  before: string;
  after: string;
}

function printReport(rows: ReportRow[]): void {
  if (rows.length === 0) {
    console.log(`${TAG} nothing to report — no ceiling was touched`);
    return;
  }
  console.log("");
  console.log(
    "| brand | funnel | channel | offer | leg written | amount before | amount after |"
  );
  console.log("|---|---|---|---|---|---|---|");
  for (const row of rows) {
    console.log(
      `| ${row.brandId} | ${row.funnelKey} | ${row.featureSlug} | ${row.offerId} | ${row.legKey} | ${row.before} | ${row.after} |`
    );
  }
  console.log("");

  const moved = rows.filter((row) => row.before !== row.after);
  if (moved.length > 0) {
    // Impossible by construction — the amount is never in the SET clause — so
    // if it ever prints, something wrote money and the run must be investigated.
    console.error(
      `${TAG} ⚠️  ${moved.length} ceiling(s) changed AMOUNT. This must never happen:`,
      moved
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  console.log(`${TAG} mode=${APPLY ? "APPLY" : "DRY-RUN"}`);

  if (!process.env.CAMPAIGN_SERVICE_URL || !process.env.CAMPAIGN_SERVICE_API_KEY) {
    throw new Error(
      "CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY are required — the leg is read from campaign-service, never derived here"
    );
  }

  const pairs = await sql<{ org_id: string; brand_id: string }[]>`
    SELECT DISTINCT org_id, brand_id
      FROM brand_funnel_daily_budgets
     WHERE leg_key IS NULL
     ORDER BY brand_id
  `;
  console.log(
    `${TAG} ${pairs.length} org+brand pair(s) carry at least one leg-less ceiling`
  );

  const report: ReportRow[] = [];
  let skipped = 0;

  for (const pair of pairs) {
    const spendable = await fetchSpendableBudget(pair.org_id, pair.brand_id);
    if (!spendable) {
      // fetchSpendableBudget is fail-SOFT for the notification path it was
      // written for. A backfill must not read "could not ask" as "leave alone".
      throw new Error(
        `campaign-service could not be read for org ${pair.org_id} brand ${pair.brand_id} — aborting rather than treating it as "no campaign"`
      );
    }

    for (const decision of decideLegAttributions(spendable)) {
      const label = `org ${pair.org_id} brand ${pair.brand_id} ${decision.label}`;

      if (!decision.attribute) {
        skipped++;
        console.log(`  SKIP  ${label} — ${decision.reason}`);
        continue;
      }

      const { target } = decision;
      if (!APPLY) {
        console.log(
          `  WOULD ${label} -> leg ${target.legKey} (from campaign ${target.campaignId}, ${target.campaignStatus ?? "status unknown"}; amount unchanged)`
        );
        report.push({
          orgId: pair.org_id,
          brandId: pair.brand_id,
          funnelKey: target.funnelKey,
          featureSlug: target.featureSlug,
          offerId: target.offerId ?? "(none)",
          legKey: target.legKey,
          campaignId: target.campaignId,
          before: "(dry-run)",
          after: "(dry-run)",
        });
        continue;
      }

      const outcome = await attributeCeilingLeg(
        pair.org_id,
        pair.brand_id,
        target
      );
      if (!outcome.applied) {
        skipped++;
        console.log(`  SKIP  ${label} — ${outcome.reason}`);
        continue;
      }

      console.log(
        `  DONE  ${label} -> leg ${outcome.legKey} @ ${outcome.dailyBudgetCentsAfter}`
      );
      report.push({
        orgId: pair.org_id,
        brandId: pair.brand_id,
        funnelKey: target.funnelKey,
        featureSlug: target.featureSlug,
        offerId: target.offerId ?? "(none)",
        legKey: outcome.legKey,
        campaignId: target.campaignId,
        before: outcome.dailyBudgetCentsBefore,
        after: outcome.dailyBudgetCentsAfter,
      });
    }
  }

  printReport(report);

  // Read the result back from the DB rather than reporting the loop's own
  // counters: a re-run of an idempotent sweep prints zeros, which is
  // indistinguishable from "found nothing".
  const [counts] = await sql<{ total: string; with_leg: string }[]>`
    SELECT count(*)::text AS total, count(leg_key)::text AS with_leg
      FROM brand_funnel_daily_budgets
  `;

  console.log(
    `${TAG} ${APPLY ? "attributed" : "would attribute"}=${report.length} skipped=${skipped}`
  );
  console.log(
    `${TAG} DB now: ${counts.with_leg} of ${counts.total} ceiling(s) carry a leg`
  );
}

main()
  .then(async () => {
    await sql.end();
    process.exit(process.exitCode ?? 0);
  })
  .catch(async (err) => {
    console.error(`${TAG} FAILED:`, err);
    await sql.end();
    process.exit(1);
  });
