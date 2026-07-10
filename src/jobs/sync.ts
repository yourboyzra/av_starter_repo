import { registry } from "../connectors/registry.js";
import { runReconciliation } from "../sync/engine.js";
import { airtable, type Fields } from "../lib/airtable.js";

/**
 * Pattern B: scheduled reconciliation across all registered providers.
 * Webhooks miss events (provider outages, our downtime, expired
 * subscriptions); a watermark-based sync that self-heals is the difference
 * between a demo and a product. Always keep this running, even for
 * webhook-driven providers.
 */
export async function runSync(): Promise<Record<string, unknown>> {
  const results: Record<string, unknown> = {};
  for (const [provider, registration] of Object.entries(registry)) {
    try {
      results[provider] = await runReconciliation(provider, registration);
    } catch (err) {
      console.error(`[sync] ${provider} failed:`, err);
      results[provider] = { error: String(err) };
    }
  }

  try {
    const linked = await linkLineItemsToOrders();
    if (linked > 0) console.log(`[sync] linked ${linked} line item(s) to orders`);
  } catch (err) {
    console.error("[sync] line item linking failed:", err);
  }

  return results;
}

/**
 * Resolves the Order linked-record field on Line Items using the plain-text
 * Shopify Order ID join key written by the mapper. Runs after every sync so
 * both new and previously-unlinked records are covered.
 *
 * Orders.Shopify Order ID is a number field — the filter uses numeric
 * comparison, not a string quote, which is why this can't live in the mapper.
 */
async function linkLineItemsToOrders(): Promise<number> {
  const unlinked = await airtable.list("Line Items", {
    filterByFormula: "AND({Shopify Order ID} != '', NOT({Order}))",
  });
  if (!unlinked.length) return 0;

  const uniqueShopifyOrderIds = [
    ...new Set(unlinked.map((li) => li.fields["Shopify Order ID"] as string).filter(Boolean)),
  ];

  const orderMap = new Map<string, string>(); // shopify order id (string) -> airtable record id
  for (const shopifyOrderId of uniqueShopifyOrderIds) {
    const rows = await airtable.list("Orders", {
      filterByFormula: `{Shopify Order ID} = ${Number(shopifyOrderId)}`,
      maxRecords: "1",
    });
    if (rows[0]) orderMap.set(shopifyOrderId, rows[0].id);
  }

  const updates = unlinked.flatMap((li) => {
    const shopifyOrderId = li.fields["Shopify Order ID"] as string;
    const orderRecordId = orderMap.get(shopifyOrderId);
    if (!orderRecordId) return [];
    return [{ id: li.id, fields: { Order: [orderRecordId] } as Fields }];
  });

  if (updates.length) await airtable.update("Line Items", updates);
  return updates.length;
}
