import { Request, Response, NextFunction } from "express";
import type { KeySource } from "../lib/key-client.js";
import type { KeySourceInfo } from "../lib/stripe.js";

const VALID_KEY_SOURCES = new Set<string>(["app", "byok", "platform"]);

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
  const keySource = req.headers["x-key-source"] as string;
  if (!keySource) {
    res.status(400).json({ error: "x-key-source header is required" });
    return;
  }
  if (!VALID_KEY_SOURCES.has(keySource)) {
    res.status(400).json({ error: `Invalid x-key-source: ${keySource}. Must be one of: app, byok, platform` });
    return;
  }
  next();
}

/** Extract KeySourceInfo from request headers. Call after requireOrgHeaders. */
export function getKeySourceInfo(req: Request): KeySourceInfo {
  const keySource = req.headers["x-key-source"] as KeySource;
  const appId = req.headers["x-app-id"] as string;
  const orgId = req.headers["x-org-id"] as string;

  switch (keySource) {
    case "app": return { keySource: "app", appId };
    case "byok": return { keySource: "byok", orgId };
    case "platform": return { keySource: "platform" };
  }
}
