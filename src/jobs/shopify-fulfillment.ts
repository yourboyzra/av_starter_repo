import { airtable, type Fields } from "../lib/airtable.js";
import { listFulfillmentOrders, createFulfillment } from "../connectors/shopify.js";

/**
 * Blueprint external automation #7: "Shopify fulfillment status sync when
 * order marked Fulfilled." Triggered by a native Airtable automation when
 * Internal Status -> Fulfilled (the same trigger as Automation 5's customer
 * shipping email — see CLAUDE.md/blueprint) via POST /jobs/shopify-fulfillment
 * { orderId }. The automation should only notify; this does the real work,
 * same Pattern C convention as /jobs/outbound.
 *
 * Only customer-facing legs (Vendor to Customer, Lux to Customer) get
 * pushed to Shopify — Vendor to Lux is an internal handoff the customer (and
 * therefore Shopify) should never see as a "fulfillment."
 *
 * notify_customer is read directly from each Shipments record's "Notify
 * Customer" checkbox — defaults to FALSE (opt-in only, see
 * src/jobs/shipments.ts) so this never silently emails the customer unless
 * staff proactively check it for that shipment. That's deliberate: it keeps
 * this push from automatically colliding with Automation 5 (native,
 * separately specified), which may also email the customer on Fulfilled —
 * staff decide per-shipment whether Shopify's email should go out too.
 */

const ORDERS_TABLE = "Orders";
const LINE_ITEMS_TABLE = "Line Items";
const SHIPMENTS_TABLE = "Shipments";
const CUSTOMER_FACING_LEGS = new Set(["Vendor to Customer", "Lux to Customer"]);

function linkedIds(fields: Fields, field: string): string[] {
  const v = fields[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

export interface PushShopifyFulfillmentsResult {
  pushed: { shipmentRecordId: string; shopifyFulfillmentId: number }[];
  skipped: { shipmentRecordId: string; reason: string }[];
}

export async function pushShopifyFulfillments(orderId: string): Promise<PushShopifyFulfillmentsResult> {
  const order = await airtable.find(ORDERS_TABLE, orderId);
  const shopifyOrderId = order.fields["Shopify Order ID"];
  if (!shopifyOrderId) {
    throw new Error(`Order ${orderId} has no Shopify Order ID — not a Shopify-sourced order`);
  }

  const shipments = await airtable.findByIds(SHIPMENTS_TABLE, linkedIds(order.fields, "Shipments"));
  const customerFacing = shipments.filter((s) => CUSTOMER_FACING_LEGS.has(String(s.fields["Leg"])));

  const pushed: PushShopifyFulfillmentsResult["pushed"] = [];
  const skipped: PushShopifyFulfillmentsResult["skipped"] = [];
  if (customerFacing.length === 0) return { pushed, skipped };

  const fulfillmentOrders = await listFulfillmentOrders(String(shopifyOrderId));
  const byLineItemId = new Map<number, { fulfillmentOrderId: number; fulfillmentOrderLineItemId: number; fulfillableQuantity: number }>();
  for (const fo of fulfillmentOrders) {
    for (const li of fo.line_items) {
      byLineItemId.set(li.line_item_id, {
        fulfillmentOrderId: fo.id,
        fulfillmentOrderLineItemId: li.id,
        fulfillableQuantity: li.fulfillable_quantity,
      });
    }
  }

  for (const shipment of customerFacing) {
    if (shipment.fields["Shopify Fulfillment ID"]) {
      skipped.push({ shipmentRecordId: shipment.id, reason: "already pushed" });
      continue;
    }

    const lineItems = await airtable.findByIds(LINE_ITEMS_TABLE, linkedIds(shipment.fields, "Line Items"));

    // Groups our Line Items by which Shopify FulfillmentOrder they belong to
    // (usually one group; only splits if Shopify itself split the order
    // across locations). Fulfills each line item's FULL fulfillable
    // quantity — this system never splits a single Line Item record's
    // quantity across multiple shipments of the same leg type.
    const groups = new Map<number, { id: number; quantity: number }[]>();
    let anyUnmatched = false;
    for (const li of lineItems) {
      const match = byLineItemId.get(Number(li.fields["Shopify Line Item ID"]));
      if (!match) {
        anyUnmatched = true;
        continue;
      }
      const group = groups.get(match.fulfillmentOrderId) ?? [];
      group.push({ id: match.fulfillmentOrderLineItemId, quantity: match.fulfillableQuantity });
      groups.set(match.fulfillmentOrderId, group);
    }

    if (anyUnmatched || groups.size === 0) {
      skipped.push({
        shipmentRecordId: shipment.id,
        reason: "could not match all line items to a Shopify fulfillment order",
      });
      continue;
    }

    const fulfillment = await createFulfillment({
      lineItemsByFulfillmentOrder: [...groups.entries()].map(([fulfillmentOrderId, items]) => ({
        fulfillmentOrderId,
        lineItems: items,
      })),
      trackingCompany: typeof shipment.fields["Carrier"] === "string" ? shipment.fields["Carrier"] : undefined,
      trackingNumber: typeof shipment.fields["Tracking Number"] === "string" ? shipment.fields["Tracking Number"] : undefined,
      notifyCustomer: shipment.fields["Notify Customer"] === true,
    });

    await airtable.update(SHIPMENTS_TABLE, [
      { id: shipment.id, fields: { "Shopify Fulfillment ID": String(fulfillment.id) } },
    ]);
    pushed.push({ shipmentRecordId: shipment.id, shopifyFulfillmentId: fulfillment.id });
  }

  return { pushed, skipped };
}
