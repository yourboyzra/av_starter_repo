import { Hono } from "hono";
import { registry } from "../../connectors/registry.js";
import { InvalidSignatureError } from "../../connectors/types.js";
import { alreadyProcessed, markProcessed } from "../../lib/idempotency.js";
import { processInbound } from "../../sync/engine.js";

/**
 * Pattern A: generic inbound webhook endpoint, POST /webhooks/:provider.
 * Pipeline: verify signature (in the adapter, on the RAW body) -> idempotency
 * -> map -> upsert. ACK fast — especially on Vercel. If processing grows
 * heavy (multi-table writes, enrichment), move the work to a queue and return
 * 200 immediately (chassis blueprint §7).
 */
export const providerWebhooks = new Hono();

providerWebhooks.post("/:provider", async (c) => {
  const name = c.req.param("provider");
  const registration = registry[name];
  if (!registration) return c.json({ error: `unknown provider: ${name}` }, 404);

  // Raw body BEFORE parsing — required for HMAC verification.
  const raw = await c.req.text();
  const headers: Record<string, string | undefined> = c.req.header();

  let event;
  try {
    event = await registration.connector.parseWebhook(raw, headers);
  } catch (err) {
    if (err instanceof InvalidSignatureError) {
      return c.json({ error: "invalid signature" }, 401);
    }
    throw err;
  }

  const dedupeKey = `${name}:${event.eventId}`;
  if (await alreadyProcessed(dedupeKey)) {
    return c.json({ ok: true, deduped: true });
  }

  const result = await processInbound(registration.specs, event.records);
  await markProcessed(dedupeKey, name);

  return c.json({ ok: true, ...result });
});
