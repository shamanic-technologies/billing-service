import { vi } from "vitest";

// runs-service's no-campaign split (lib/platform-absorbed) sits on every balance
// read. Default: nothing absorbed, so every suite written before it reads exactly
// the balance it always did. A plain function (not vi.fn) so restoreAllMocks never
// strips it; a suite that needs absorbed spend spies on it.
vi.mock("../src/lib/runs-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/runs-client.js")>();
  return {
    ...actual,
    fetchRunsOrgNoCampaignTotal: async () => ({ usageNetCents: "0", actualNetCents: "0" }),
  };
});
