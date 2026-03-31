import { Request, Response, NextFunction } from "express";

export interface WorkflowHeaders {
  campaignId?: string;
  brandIds?: string[];
  workflowSlug?: string;
  featureSlug?: string;
}

/** Parse the x-brand-id header as a comma-separated list of UUIDs. */
function parseBrandIds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const ids = String(raw).split(",").map(s => s.trim()).filter(Boolean);
  return ids.length > 0 ? ids : undefined;
}

/** Extract optional workflow-tracking headers injected by workflow-service. */
export function getWorkflowHeaders(req: Request): WorkflowHeaders {
  return {
    campaignId: req.headers["x-campaign-id"] as string | undefined,
    brandIds: parseBrandIds(req.headers["x-brand-id"] as string | undefined),
    workflowSlug: req.headers["x-workflow-slug"] as string | undefined,
    featureSlug: req.headers["x-feature-slug"] as string | undefined,
  };
}

/** Build a header record for forwarding workflow headers to downstream services. */
export function forwardWorkflowHeaders(wf: WorkflowHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  if (wf.campaignId) headers["x-campaign-id"] = wf.campaignId;
  if (wf.brandIds && wf.brandIds.length > 0) headers["x-brand-id"] = wf.brandIds.join(",");
  if (wf.workflowSlug) headers["x-workflow-slug"] = wf.workflowSlug;
  if (wf.featureSlug) headers["x-feature-slug"] = wf.featureSlug;
  return headers;
}

export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const apiKey = req.headers["x-api-key"] as string;
  if (!apiKey || apiKey !== process.env.BILLING_SERVICE_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function requireOrgHeaders(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const orgId = req.headers["x-org-id"] as string;
  if (!orgId) {
    console.error(`[billing-400] ${req.method} ${req.path}: missing x-org-id`);
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  if (!UUID_RE.test(orgId)) {
    console.error(`[billing-400] ${req.method} ${req.path}: invalid x-org-id="${orgId}" (not a UUID)`);
    res.status(400).json({ error: "x-org-id must be a valid UUID" });
    return;
  }
  const userId = req.headers["x-user-id"] as string;
  if (!userId) {
    console.error(`[billing-400] ${req.method} ${req.path}: missing x-user-id (orgId=${orgId})`);
    res.status(400).json({ error: "x-user-id header is required" });
    return;
  }
  if (!UUID_RE.test(userId)) {
    console.error(`[billing-400] ${req.method} ${req.path}: invalid x-user-id="${userId}" (not a UUID)`);
    res.status(400).json({ error: "x-user-id must be a valid UUID" });
    return;
  }
  const runId = req.headers["x-run-id"] as string;
  if (!runId) {
    console.error(`[billing-400] ${req.method} ${req.path}: missing x-run-id (orgId=${orgId})`);
    res.status(400).json({ error: "x-run-id header is required" });
    return;
  }
  if (!UUID_RE.test(runId)) {
    console.error(`[billing-400] ${req.method} ${req.path}: invalid x-run-id="${runId}" (not a UUID)`);
    res.status(400).json({ error: "x-run-id must be a valid UUID" });
    return;
  }
  next();
}
