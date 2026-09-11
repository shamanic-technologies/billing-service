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
 *   - `referral-reward-opened`     → src/lib/referral-notifications.ts
 *   - `referral-credits-granted`   → src/lib/referral-notifications.ts
 *   - `credit-debt-card-required`  → src/lib/unpaid-debt.ts
 *   - `unpaid_debt_uncollectable`  → src/lib/unpaid-debt.ts (staff)
 * The six dunning templates (`credit-depleted*`) are registered by the dashboard
 * (distribute.you#1420, which owns their copy) and are present in prod.
 */
import { fetchWithRetry } from "./lib/fetch-retry.js";
import { BRAND_DAILY_BUDGET_CHANGED_EVENT } from "./lib/brand-budget-notification.js";
import {
  REFERRAL_REWARD_OPENED_EVENT,
  REFERRAL_CREDITS_GRANTED_EVENT,
} from "./lib/referral-notifications.js";
import {
  UNPAID_DEBT_CARD_REQUIRED_EVENT,
  UNPAID_DEBT_STAFF_EVENT,
} from "./lib/unpaid-debt.js";

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
    // The headline is the RUNNING figure — money attached to a campaign that is
    // ongoing. The configured total is stated underneath so the paused money is
    // visible rather than silently dropped. Both running variables render
    // "unavailable" when campaign-service could not be read, and {{runningNote}}
    // says so: a configured total must never be presented as a running one.
    name: BRAND_DAILY_BUDGET_CHANGED_EVENT,
    subject:
      "Running daily budget {{previousRunningBudget}} → {{newRunningBudget}}",
    htmlBody: `<p>{{email}} changed a brand's daily budget.</p>
<ul>
<li>Running: {{previousRunningBudget}} → {{newRunningBudget}}</li>
<li>Configured: {{previousBudget}} → {{newBudget}}</li>
<li>Brand: {{brandId}}</li>
<li>Org: {{orgId}}</li>
</ul>
<p>{{runningNote}}</p>`,
    textBody: "{{email}} changed a brand's daily budget. Running: {{previousRunningBudget}} → {{newRunningBudget}}. Configured: {{previousBudget}} → {{newBudget}}. Brand: {{brandId}}. Org: {{orgId}}. {{runningNote}}",
  },
  {
    // Someone the recipient invited has converted, so a reward just opened for
    // them. The one moment in the referral that cannot be inferred from anything
    // they can see, because it happened when somebody ELSE paid.
    //
    // Every variable here is ALWAYS supplied and never empty: the identity lookup
    // is fail-soft, so the sender substitutes a phrase that names nobody rather
    // than leaving {{referredOrg}} blank in the middle of a sentence. See
    // lib/referral-notifications.ts.
    name: REFERRAL_REWARD_OPENED_EVENT,
    subject: "You earned {{amount}} in free credits",
    htmlBody: `<p>{{referredOrg}} signed up through your invite link and started paying, so {{amount}} in free credits is now yours.</p>
<p>It lands in your account once your own payments reach {{unlockAt}}. Nothing to claim.</p>`,
    textBody:
      "{{referredOrg}} signed up through your invite link and started paying, so {{amount}} in free credits is now yours. It lands in your account once your own payments reach {{unlockAt}}. Nothing to claim.",
  },
  {
    // The credits actually arrived, on either side of the referral.
    //
    // {{reason}} carries WHO converted, composed by the sender because the two
    // sides earned the same amount for opposite reasons. It matters most when the
    // referrer was already past the new bar and this is the only message they get
    // about that referral.
    name: REFERRAL_CREDITS_GRANTED_EVENT,
    subject: "{{amount}} in free credits just landed",
    htmlBody: `<p>{{amount}} in referral credits is now in your account.</p>
<p>{{reason}}</p>
<p>The credits come off what you spend from here, so there is nothing to claim.</p>`,
    textBody:
      "{{amount}} in referral credits is now in your account. {{reason}} The credits come off what you spend from here, so there is nothing to claim.",
  },
  {
    // The org owes money and the card we would have taken it from is gone.
    //
    // Deliberately NOT one of the six `credit-depleted*` templates: those nudge
    // "turn on auto-topup" and the `-blocked` variants nudge a manual recharge,
    // and neither is reachable without a card on file. Adding a card is the one
    // action that unblocks this customer, so that is what this says.
    name: UNPAID_DEBT_CARD_REQUIRED_EVENT,
    subject: "Add a payment method to resume your campaigns",
    htmlBody: `<p>Your campaigns have stopped. You have an unpaid balance of {{amountOwed}} and we no longer have a card on file to charge.</p>
<p>Add a payment method in your billing settings and we will settle the {{amountOwed}} and start your campaigns again.</p>`,
    textBody:
      "Your campaigns have stopped. You have an unpaid balance of {{amountOwed}} and we no longer have a card on file to charge. Add a payment method in your billing settings and we will settle the {{amountOwed}} and start your campaigns again.",
  },
  {
    // Staff notification, not a customer email: transactional-email-service
    // routes this event type to its own staff recipient list, so no recipient
    // list lives here. Same shape as brand_daily_budget_changed, and the name is
    // imported from the sender rather than retyped so the two cannot drift.
    name: UNPAID_DEBT_STAFF_EVENT,
    subject: "Unpaid debt {{amountOwed}}, no card on file",
    htmlBody: `<p>An org owes {{amountOwed}} and has no chargeable card, so we cannot collect it.</p>
<ul>
<li>Org: {{orgId}}</li>
<li>Billing email: {{billingEmail}}</li>
</ul>
<p>Their campaigns are stopped and they have been asked to add a card.</p>`,
    textBody:
      "An org owes {{amountOwed}} and has no chargeable card, so we cannot collect it. Org: {{orgId}}. Billing email: {{billingEmail}}. Their campaigns are stopped and they have been asked to add a card.",
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
