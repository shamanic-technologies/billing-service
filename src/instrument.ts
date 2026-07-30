/**
 * Boot-time registration of the email templates this service SENDS.
 *
 * transactional-email-service resolves a template by looking up the row whose
 * `name` equals the `eventType` of the send, so an unregistered template makes
 * every send of that event throw "No template for event" — the email silently
 * never arrives. `PUT /templates` upserts by name, which IS the idempotency:
 * every restart and every replica may call it, no marker state needed.
 *
 * ⚠️ This module used to run its registration as a top-level side effect and
 * was imported by NOTHING (no import in `src/index.ts`, no `--import` preload,
 * container command is a plain `node dist/index.js`). It therefore never ran in
 * production: the prod store held 36 templates and zero of billing's. It is now
 * an exported function called from `src/index.ts` AFTER `app.listen()`.
 *
 * Only templates this service actually sends belong here — one per `eventType`
 * that appears in a `sendEmail` call:
 *   - `credits-reload-failed`      → src/routes/customer_balance.ts
 *   - `brand_daily_budget_changed` → src/lib/brand-budget-notification.ts
 * The six dunning templates (`credit-depleted*`) are registered by the dashboard
 * (distribute.you#1420, which owns their copy) and are present in prod.
 */
import { fetchWithRetry } from "./lib/fetch-retry.js";
import { BRAND_DAILY_BUDGET_CHANGED_EVENT } from "./lib/brand-budget-notification.js";

/**
 * The sibling can be cold (Neon scale-to-zero), suspended, or down at our boot.
 * We must never hold the process, so the call is bounded and its failure is
 * logged rather than thrown — a start that cannot reach the email service still
 * has to bind its port and serve traffic.
 */
const DEPLOY_TIMEOUT_MS = 15_000;

const SERVICE_IDENTITY = "00000000-0000-0000-0000-000000000000";

const TEMPLATES = [
  {
    name: "credits-reload-failed",
    subject: "Automatic reload failed",
    htmlBody: `<p>We attempted to automatically reload your account, but the payment failed. Please update your payment method.</p>
<p><a href="{{settingsUrl}}">Update payment method</a></p>`,
    textBody: "We attempted to automatically reload your account, but the payment failed. Please update your payment method. Visit: {{settingsUrl}}",
  },
  {
    // Staff notification, not a customer email: transactional-email-service
    // routes this event type to its own staff recipient list and fills {{email}}
    // with the acting user when billing sends none. The name is imported from
    // the sender rather than retyped, so the template row and the event key
    // cannot drift apart.
    name: BRAND_DAILY_BUDGET_CHANGED_EVENT,
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
] as const;

/** Template names this service registers — exported for the boot-coverage test. */
export const REGISTERED_TEMPLATE_NAMES = TEMPLATES.map((t) => t.name);

/**
 * Upsert this service's templates into transactional-email-service.
 *
 * NEVER throws and NEVER blocks the caller's critical path: call it
 * fire-and-forget after `app.listen()`. Returns whether the upsert landed, for
 * tests and for the boot log.
 */
export async function deployEmailTemplates(): Promise<boolean> {
  const url = process.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = process.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.warn(
      "[billing-service] TRANSACTIONAL_EMAIL_SERVICE not configured — email templates NOT registered; every send will fail with 'No template for event'",
    );
    return false;
  }

  try {
    const res = await fetchWithRetry(`${url}/templates`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-org-id": SERVICE_IDENTITY,
        "x-user-id": SERVICE_IDENTITY,
        "x-run-id": SERVICE_IDENTITY,
      },
      body: JSON.stringify({ templates: TEMPLATES }),
      signal: AbortSignal.timeout(DEPLOY_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(
        `[billing-service] Failed to register email templates: ${res.status} ${await res.text()}`,
      );
      return false;
    }

    console.log(
      `[billing-service] Email templates registered: ${REGISTERED_TEMPLATE_NAMES.join(", ")}`,
    );
    return true;
  } catch (err) {
    console.error("[billing-service] Failed to register email templates:", err);
    return false;
  }
}
