/**
 * Register billing's own email templates with transactional-email-service.
 *
 * That service resolves a template by looking up the row whose `name` equals the
 * event type, so an unregistered template makes every send of that event 404 —
 * silently, since sends are fire-and-forget. This module is therefore load-bearing
 * and MUST stay wired into the boot path (src/index.ts, after `app.listen()`).
 *
 * It sat here as an ORPHAN module — zero importers — from the day it was written
 * until 2026-07-30, so billing had never registered anything: the prod email DB
 * held no `credits-reload-failed` row (that send has been 404-ing) and no
 * `brand_daily_budget_changed` row (the staff notification shipped inert).
 *
 * `PUT /platform-templates` is the api-key-only cold-start route (the identity-gated
 * `PUT /templates` twin would need a fake all-zero user). Both are per-name upserts
 * (`ON CONFLICT (name) DO UPDATE`), so this only ever touches the rows listed here
 * and never disturbs another service's templates.
 *
 * Fire-and-forget by construction: never awaited at boot, never throws.
 */

const TEMPLATES = [
  {
    // Sent by customer_balance.ts when an off_session auto-reload PaymentIntent fails.
    name: "credits-reload-failed",
    subject: "Automatic reload failed",
    htmlBody: `<p>We attempted to automatically reload your account, but the payment failed. Please update your payment method.</p>
<p><a href="{{settingsUrl}}">Update payment method</a></p>`,
    textBody: "We attempted to automatically reload your account, but the payment failed. Please update your payment method. Visit: {{settingsUrl}}",
  },
  {
    // Staff notification, not a customer email: transactional-email-service
    // routes this event type to its own staff recipient list and fills {{email}}
    // with the acting user when billing sends none. The name MUST stay
    // byte-equal to BRAND_DAILY_BUDGET_CHANGED_EVENT — see lib/brand-budget-notification.ts.
    name: "brand_daily_budget_changed",
    subject: "Daily budget {{previousBudget}} → {{newBudget}}",
    htmlBody: `<p>{{email}} changed a brand's daily budget.</p>
<ul>
<li>Was: {{previousBudget}}</li>
<li>Now: {{newBudget}}</li>
<li>Brand: {{brandId}}</li>
<li>Org: {{orgId}}</li>
</ul>`,
    textBody: "{{email}} changed a brand's daily budget. Was: {{previousBudget}}. Now: {{newBudget}}. Brand: {{brandId}}. Org: {{orgId}}.",
  },
];

/** Template names this service owns. Exported so tests can pin the set. */
export const BILLING_EMAIL_TEMPLATE_NAMES = TEMPLATES.map((t) => t.name);

/** Deploy every billing-owned template (idempotent upsert). Never throws. */
export async function deployEmailTemplates(): Promise<void> {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.warn("TRANSACTIONAL_EMAIL_SERVICE not configured — skipping template deployment");
    return;
  }

  try {
    const res = await fetch(`${url}/platform-templates`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ templates: TEMPLATES }),
    });

    if (!res.ok) {
      console.error(`Failed to deploy email templates: ${res.status} ${await res.text()}`);
      return;
    }

    console.log(
      `Email templates deployed successfully: ${BILLING_EMAIL_TEMPLATE_NAMES.join(", ")}`
    );
  } catch (err) {
    console.error("Failed to deploy email templates:", err);
  }
}
