import { writeFileSync } from "fs";
import { OpenApiGeneratorV3 } from "@asteasolutions/zod-to-openapi";
import { registry } from "../src/schemas.js";

const generator = new OpenApiGeneratorV3(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.0.0",
  info: {
    title: "Billing Service API",
    version: "0.1.0",
    description:
      "Manages billing accounts, credit balance, deductions, and Stripe integration for the Conductor platform.",
  },
  servers: [{ url: "http://localhost:3012" }],
});

writeFileSync("openapi.json", JSON.stringify(document, null, 2));
console.log("OpenAPI spec generated: openapi.json");
