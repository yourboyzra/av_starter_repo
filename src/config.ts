import { config } from "dotenv";
import { z } from "zod";

// override: true so this project's .env always wins over same-named vars
// already exported in the shell (e.g. a different AIRTABLE_PAT used for
// other tools/MCP connections on this machine). Skipped under vitest, which
// sets its own fake secrets in tests/setup.ts before this module loads.
if (process.env.NODE_ENV !== "test") {
  config({ override: true });
}

/**
 * Fail-fast env validation. The app must crash loudly at startup if config is
 * missing — not 500 at 2 a.m. Provider-specific vars are optional so the
 * chassis boots without every connector configured; connectors assert their
 * own vars on first use.
 */
const Env = z.object({
  AIRTABLE_PAT: z.string().startsWith("pat"),
  AIRTABLE_BASE_ID: z.string().startsWith("app"),
  INTERNAL_JOB_SECRET: z.string().min(16),

  // Stripe (reference connector)
  STRIPE_API_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  // Shopify (custom app — Admin API access token, no OAuth dance)
  SHOPIFY_STORE_DOMAIN: z.string().optional(), // e.g. your-store.myshopify.com
  SHOPIFY_ACCESS_TOKEN: z.string().optional(),
  SHOPIFY_API_VERSION: z.string().default("2026-01"),
  SHOPIFY_WEBHOOK_SECRET: z.string().optional(),

  // ShipStation (V2 API)
  SHIPSTATION_API_KEY: z.string().optional(),
  // Shared-secret header value registered as a custom webhook header (V2 has
  // no body HMAC) — see src/connectors/shipstation.ts for the exact scheme.
  SHIPSTATION_WEBHOOK_SECRET: z.string().optional(),
  // Fallback ship-from when an order has no Vendor linked (or the linked
  // vendor has no address on file) — a default warehouse_id configured once
  // in the ShipStation dashboard.
  SHIPSTATION_WAREHOUSE_ID: z.string().optional(),

  // Airtable webhooks to refresh daily (Pattern C, Option 2)
  AIRTABLE_WEBHOOK_IDS: z.string().default(""),

  // OAuth
  OAUTH_REDIRECT_BASE_URL: z.string().url().default("http://localhost:3000"),
  QUICKBOOKS_CLIENT_ID: z.string().optional(),
  QUICKBOOKS_CLIENT_SECRET: z.string().optional(),
  GHL_CLIENT_ID: z.string().optional(),
  GHL_CLIENT_SECRET: z.string().optional(),

  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

export const env = Env.parse(process.env);

/** Assert a provider-specific env var exists, with a useful error. */
export function requireEnv<K extends keyof typeof env>(key: K): NonNullable<(typeof env)[K]> {
  const v = env[key];
  if (v === undefined || v === "") {
    throw new Error(`Missing env var ${String(key)} — required for this connector. See .env.example.`);
  }
  return v as NonNullable<(typeof env)[K]>;
}
