import { Hono } from "hono";
import { env } from "./config.js"; // imported first: fail-fast env validation on boot
import { health } from "./routes/health.js";
import { form } from "./routes/form.js";
import { feedback } from "./routes/feedback.js";
import { oauth } from "./routes/oauth.js";
import { providerWebhooks } from "./routes/webhooks/provider.js";
import { runSync } from "./jobs/sync.js";
import { refreshWebhooks } from "./jobs/refresh-webhooks.js";
import { pushShopifyFulfillments } from "./jobs/shopify-fulfillment.js";
import { fetchAndWriteRates, purchaseLabel } from "./jobs/shipstation-rates.js";
import { createPO } from "./jobs/quickbooks-po.js";
import { registry } from "./connectors/registry.js";
import { pushOutbound } from "./sync/engine.js";

/**
 * One entry, two platforms:
 *   - Vercel: `api/index.ts` wraps this app with the hono/vercel adapter.
 *   - Railway/local: this file serves directly and runs in-process cron.
 */
const app = new Hono();

// Static assets (logo, etc.) — served before any route
if (!process.env.VERCEL) {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  app.use("/public/*", serveStatic({ root: "./" }));
}

app.route("/health", health);
app.route("/form", form);
app.route("/feedback", feedback);
app.route("/oauth", oauth);
app.route("/webhooks", providerWebhooks);

/**
 * Job endpoints — never publicly triggerable. Auth: Bearer header, or
 * `?token=` because Vercel Cron sends GET without custom headers.
 */
function jobAuthorized(c: { req: { header(name: string): string | undefined; query(name: string): string | undefined } }): boolean {
  const bearer = c.req.header("authorization");
  const token = c.req.query("token");
  return bearer === `Bearer ${env.INTERNAL_JOB_SECRET}` || token === env.INTERNAL_JOB_SECRET;
}

app.on(["GET", "POST"], "/jobs/sync", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json(await runSync());
});

app.on(["GET", "POST"], "/jobs/refresh-webhooks", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  return c.json(await refreshWebhooks());
});


/**
 * Blueprint external automation #7 (see src/jobs/shopify-fulfillment.ts).
 * Triggered by a native Airtable automation when Internal Status ->
 * Fulfilled. Pushes the order's customer-facing Shipments as Shopify
 * fulfillments (tracking + carrier), triggering Shopify's shipped email.
 */
app.post("/jobs/shopify-fulfillment", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ orderId?: string }>();
  if (!body.orderId) return c.json({ error: "orderId is required" }, 400);
  return c.json({ ok: true, ...(await pushShopifyFulfillments(body.orderId)) });
});

/**
 * QuickBooks PO creation — dedicated endpoint so DocNumber is written back
 * to Airtable immediately from the create response, not on the next sync.
 * Update the Airtable automation script to call this instead of /jobs/outbound.
 */
app.post("/jobs/quickbooks/create-po", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ recordId?: string }>();
  if (!body.recordId) return c.json({ error: "recordId is required" }, 400);
  return c.json({ ok: true, ...(await createPO(body.recordId)) });
});

/**
 * ShipStation rate fetch and label purchase (see src/jobs/shipstation-rates.ts).
 * "Get Rates" button on a Shipments record calls /rates; staff picks a row in
 * the Rates table; "Purchase Label" button on that Rate record calls /create-label.
 */
app.post("/jobs/shipstation/rates", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ shipmentRecordId?: string }>();
  if (!body.shipmentRecordId) return c.json({ error: "shipmentRecordId is required" }, 400);
  try {
    return c.json({ ok: true, ...(await fetchAndWriteRates(body.shipmentRecordId)) });
  } catch (err) {
    console.error("[rates] failed for", body.shipmentRecordId, err);
    return c.json({ error: String(err) }, 500);
  }
});

app.post("/jobs/shipstation/create-label", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ rateRecordId?: string }>();
  if (!body.rateRecordId) return c.json({ error: "rateRecordId is required" }, 400);
  return c.json({ ok: true, ...(await purchaseLabel(body.rateRecordId)) });
});

/**
 * Pattern C: Airtable -> provider. Called by an Airtable Automation script
 * (or your Airtable-webhooks handler) with { provider, entity, recordId }.
 * The automation should only NOTIFY — this service does the real work.
 */
app.post("/jobs/outbound", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);

  const body = await c.req.json<{ provider?: string; entity?: string; recordId?: string }>();
  const { provider, entity, recordId } = body;
  if (!provider || !entity || !recordId) {
    return c.json({ error: "provider, entity and recordId are required" }, 400);
  }
  const registration = registry[provider];
  const spec = registration?.specs[entity];
  if (!registration || !spec) {
    return c.json({ error: `unknown provider/entity: ${provider}/${entity}` }, 404);
  }

  const result = await pushOutbound(registration.connector, spec, entity, recordId);
  return c.json({ ok: true, ...result });
});

app.get("/jobs/qb-accounts", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const { getAccessToken } = await import("./lib/oauth.js");
  const { requireEnv: re } = await import("./config.js");
  const realmId = re("QUICKBOOKS_REALM_ID");
  const env2 = process.env.QUICKBOOKS_ENVIRONMENT;
  const host = env2 === "production" ? "quickbooks.api.intuit.com" : "sandbox-quickbooks.api.intuit.com";
  const token = await getAccessToken("quickbooks", realmId);
  const q = encodeURIComponent("SELECT Id, Name, AccountType, AccountSubType FROM Account WHERE AccountType = 'Cost of Goods Sold' MAXRESULTS 20");
  const res = await fetch(`https://${host}/v3/company/${realmId}/query?query=${q}&minorversion=65`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  return c.json(await res.json());
});

app.get("/ip", async (c) => {
  const res = await fetch("https://api.ipify.org?format=json");
  const { ip } = await res.json() as { ip: string };
  return c.json({ ip });
});

export default app; // Vercel picks this up via api/index.ts (hono/vercel)

// Railway/local: run a real server; on Railway also run the in-process scheduler.
if (!process.env.VERCEL) {
  const { serve } = await import("@hono/node-server");

  if (process.env.RAILWAY_ENVIRONMENT) {
    const cron = (await import("node-cron")).default;
    cron.schedule("*/15 * * * *", () => runSync().catch(console.error));
    cron.schedule("0 6 * * *", () => refreshWebhooks().catch(console.error));
  }

  const port = Number(process.env.PORT ?? 3000); // Railway injects PORT — always bind to it
  serve({ fetch: app.fetch, port });
  console.log(`Server up on :${port} (${env.NODE_ENV})`);
}
