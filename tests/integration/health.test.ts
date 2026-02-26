import { describe, it, expect } from "vitest";
import request from "supertest";
import { createTestApp } from "../helpers/test-app.js";

describe("Health endpoint", () => {
  const app = createTestApp();

  it("GET /health returns 200", async () => {
    const response = await request(app).get("/health");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      service: "billing-service",
    });
  });

  it("GET /nonexistent without auth returns 401", async () => {
    const response = await request(app).get("/nonexistent");
    expect(response.status).toBe(401);
  });

  it("GET /nonexistent with auth returns 404", async () => {
    const response = await request(app)
      .get("/nonexistent")
      .set("X-API-Key", "test-api-key");
    expect(response.status).toBe(404);
  });
});
