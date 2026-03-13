import { Request, Response, NextFunction } from "express";

export interface WorkflowHeaders {
  campaignId?: string;
  brandId?: string;
  workflowName?: string;
}

/** Extract optional workflow-tracking headers injected by workflow-service. */
export function getWorkflowHeaders(req: Request): WorkflowHeaders {
  return {
    campaignId: req.headers["x-campaign-id"] as string | undefined,
    brandId: req.headers["x-brand-id"] as string | undefined,
    workflowName: req.headers["x-workflow-name"] as string | undefined,
  };
}

/** Build a header record for forwarding workflow headers to downstream services. */
export function forwardWorkflowHeaders(wf: WorkflowHeaders): Record<string, string> {
  const headers: Record<string, string> = {};
  if (wf.campaignId) headers["x-campaign-id"] = wf.campaignId;
  if (wf.brandId) headers["x-brand-id"] = wf.brandId;
  if (wf.workflowName) headers["x-workflow-name"] = wf.workflowName;
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

export function requireOrgHeaders(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const orgId = req.headers["x-org-id"] as string;
  if (!orgId) {
    res.status(400).json({ error: "x-org-id header is required" });
    return;
  }
  const userId = req.headers["x-user-id"] as string;
  if (!userId) {
    res.status(400).json({ error: "x-user-id header is required" });
    return;
  }
  const runId = req.headers["x-run-id"] as string;
  if (!runId) {
    res.status(400).json({ error: "x-run-id header is required" });
    return;
  }
  next();
}
