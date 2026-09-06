/**
 * The acquisition channels' published commercial terms, as features-service
 * serves them on `GET /public/channels` (captured from production 2026-09-06).
 *
 * The daily floor a funded ceiling must clear IS `terms.dailyOperatingCostCents`
 * — billing reads it and stores none of it, so this fixture exists only so the
 * suite has a catalogue to read. `tests/setup.ts` seeds it for every file; a
 * test exercising an unreadable catalogue resets the snapshot instead.
 */
export const PUBLISHED_CHANNEL_DAILY_OPERATING_COST_CENTS: Record<
  string,
  number
> = {
  // Outbound, one to one.
  "sales-cold-email-outreach": 800,
  "sales-crm-email-outreach": 800,
  "feedback-request-cold-email-outreach": 800,
  "cold-call-outreach": 24000,
  "cold-sms-outreach": 1500,
  "cold-whatsapp-outreach": 1500,
  "cold-linkedin-outreach": 1200,
  "cold-x-outreach": 1000,
  "cold-instagram-outreach": 1000,
  "cold-reddit-outreach": 1000,
  // Paid reach.
  "google-ads": 500,
  "meta-ads": 5000,
  "linkedin-ads": 10000,
  "tiktok-ads": 5000,
  "youtube-ads": 5000,
  "x-ads": 3000,
  "reddit-ads": 3000,
  "bing-ads": 3000,
  "quora-ads": 3000,
  "newsletter-sponsorships": 6000,
  "podcast-sponsorships": 8000,
  "creator-sponsorships": 8000,
  "paid-directory-listings": 4000,
  // Earned.
  "pr-cold-email-outreach": 800,
  "pr-expert-quote-outreach": 800,
  "seo-content": 12000,
  "press-placements": 8000,
  "podcast-guesting": 6000,
  "affiliate-programme": 4000,
  "organic-linkedin-publishing": 10000,
  "organic-x-publishing": 8000,
  "organic-reddit-publishing": 8000,
  "organic-youtube-publishing": 12000,
  // Conversion — these do not open a funnel, they move a lead already on one to
  // its next step. The customer-operated ones spend none of our money: 0 is a
  // STATED floor, not an absent one.
  "ai-meeting-booking": 100,
  "agency-meeting-booking": 0,
  "agency-meeting-attendance": 6000,
  "agency-closing-calls": 30000,
  "agency-signup-conversion": 15000,
  "your-team-meeting-booking": 0,
  "your-team-meeting-attendance": 0,
  "your-team-closing-calls": 0,
  "your-team-signup-conversion": 0,
};

/** The same catalogue in the shape `/public/channels` serves it. */
export function publishedChannelsBody(): {
  channels: Array<{ slug: string; terms: { dailyOperatingCostCents: number } }>;
} {
  return {
    channels: Object.entries(
      PUBLISHED_CHANNEL_DAILY_OPERATING_COST_CENTS
    ).map(([slug, dailyOperatingCostCents]) => ({
      slug,
      terms: { dailyOperatingCostCents },
    })),
  };
}

/** The floors as billing resolves them from those terms. */
export function publishedChannelMinimums(): Map<string, number> {
  return new Map(
    Object.entries(PUBLISHED_CHANNEL_DAILY_OPERATING_COST_CENTS)
  );
}
