import { Request, Response, NextFunction } from "express";

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
  const appId = req.headers["x-app-id"] as string;
  if (!appId) {
    res.status(400).json({ error: "x-app-id header is required" });
    return;
  }
  next();
}
