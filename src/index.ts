import { Hono } from "hono";
import { env } from "./config.js"; // imported first: fail-fast env validation on boot
import { health } from "./routes/health.js";
import { form } from "./routes/form.js";
import { oauth } from "./routes/oauth.js";
import { providerWebhooks } from "./routes/webhooks/provider.js";
import { runSync } from "./jobs/sync.js";
import { refreshWebhooks } from "./jobs/refresh-webhooks.js";
import { createVendorShipments, createLuxToCustomerShipment } from "./jobs/shipments.js";
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

app.route("/health", health);
app.route("/form", form);
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
 * Staff-triggered shipment grouping (see src/jobs/shipments.ts). Each call
 * groups one order's not-yet-grouped line items into Shipments records for
 * the relevant leg and pushes each to ShipStation. Intentionally two
 * separate actions, not one — staff trigger each at the point that matches
 * physical reality (vendor assignment done vs. goods actually received).
 */
app.post("/jobs/shipments/create-vendor-shipments", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ orderId?: string }>();
  if (!body.orderId) return c.json({ error: "orderId is required" }, 400);
  return c.json({ ok: true, ...(await createVendorShipments(body.orderId)) });
});

app.post("/jobs/shipments/create-lux-to-customer-shipment", async (c) => {
  if (!jobAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ orderId?: string }>();
  if (!body.orderId) return c.json({ error: "orderId is required" }, 400);
  return c.json({ ok: true, ...(await createLuxToCustomerShipment(body.orderId)) });
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
  return c.json({ ok: true, ...(await fetchAndWriteRates(body.shipmentRecordId)) });
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
