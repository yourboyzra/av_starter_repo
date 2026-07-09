import { airtable, type AirtableRecord, type Fields } from "../lib/airtable.js";
import { pushOutbound } from "../sync/engine.js";
import { shipstationConnector } from "../connectors/shipstation.js";
import { shipstationSpecs } from "../mappers/shipstation.js";

/**
 * Bespoke, staff-triggered shipment-grouping jobs. NOT part of the generic
 * Connector/EntitySpec engine — that engine assumes one Airtable record
 * maps to one provider entity, but the real work here is upstream of that:
 * deciding how many Shipments records an order's line items split into.
 *
 * Two distinct actions, deliberately not one omniscient job (staff trigger
 * each at the point that matches physical reality):
 *   - createVendorShipments: groups "Shipping From Vendor" line items by
 *     Production Vendor into "Vendor to Customer" or "Vendor to Lux"
 *     shipments, depending on the order's Ship To policy.
 *   - createLuxToCustomerShipment: consolidates everything ready to leave
 *     Lux for the customer — "Shipping From Me" items (always eligible)
 *     plus any vendor-sourced items whose "Vendor to Lux" shipment has been
 *     manually marked Received at Lux — into ONE shipment per order.
 *
 * "Received at Lux" is a manual-only checkbox by design — never auto-set
 * from ShipStation tracking, since carrier-confirmed delivery doesn't
 * guarantee the right/complete contents arrived.
 *
 * "Notify Customer" defaults to FALSE on every Shipments record created
 * here, regardless of leg — opt-in only. Staff must proactively check it
 * before src/jobs/shopify-fulfillment.ts will tell Shopify to email the
 * customer. This is deliberate: it avoids a default-on path silently
 * duplicating whatever native Airtable automation ends up owning customer
 * shipping notifications.
 */

const ORDERS_TABLE = "Orders";
const LINE_ITEMS_TABLE = "Line Items";
const SHIPMENTS_TABLE = "Shipments";
const WAREHOUSE_VENDORS_TABLE = "Warehouse Vendors";
const LUX_VENDOR_NAME = "Lux Lampshades";

function linkedIds(fields: Fields, field: string): string[] {
  const v = fields[field];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function itemWord(count: number): string {
  return `${count} item${count === 1 ? "" : "s"}`;
}

async function pushNewShipment(shipmentRecordId: string): Promise<void> {
  await pushOutbound(shipstationConnector, shipstationSpecs["shipment"]!, "shipment", shipmentRecordId);
}

export interface CreateVendorShipmentsResult {
  created: { shipmentRecordId: string; vendorId: string; lineItemCount: number }[];
}

/** Action 1: group an order's not-yet-grouped "Shipping From Vendor" line items by Production Vendor. */
export async function createVendorShipments(orderId: string): Promise<CreateVendorShipmentsResult> {
  const order = await airtable.find(ORDERS_TABLE, orderId);
  const lineItemIds = linkedIds(order.fields, "Line Items");
  if (lineItemIds.length === 0) return { created: [] };

  const lineItems = await airtable.findByIds(LINE_ITEMS_TABLE, lineItemIds);
  const existingShipments = await airtable.findByIds(SHIPMENTS_TABLE, linkedIds(order.fields, "Shipments"));

  // Line items already covered by ANY existing vendor-leg shipment (idempotency).
  const alreadyCovered = new Set<string>();
  for (const shipment of existingShipments) {
    const leg = shipment.fields["Leg"];
    if (leg === "Vendor to Customer" || leg === "Vendor to Lux") {
      for (const id of linkedIds(shipment.fields, "Line Items")) alreadyCovered.add(id);
    }
  }

  const eligible = lineItems.filter(
    (li) =>
      li.fields["Shipping Source"] === "Shipping From Vendor" &&
      linkedIds(li.fields, "Production Vendor").length > 0 &&
      !alreadyCovered.has(li.id)
  );
  if (eligible.length === 0) return { created: [] };

  const byVendor = new Map<string, AirtableRecord[]>();
  for (const li of eligible) {
    const vendorId = linkedIds(li.fields, "Production Vendor")[0]!;
    byVendor.set(vendorId, [...(byVendor.get(vendorId) ?? []), li]);
  }

  const leg = order.fields["Ship To"] === "Lux Lampshade" ? "Vendor to Lux" : "Vendor to Customer";
  const created: CreateVendorShipmentsResult["created"] = [];

  for (const [vendorId, group] of byVendor) {
    const [shipmentRecord] = await airtable.create(SHIPMENTS_TABLE, [
      {
        fields: {
          Order: [orderId],
          Vendor: [vendorId],
          "Line Items": group.map((li) => li.id),
          Leg: leg,
          "Notify Customer": false, // opt-in only — staff must proactively check this before Shopify emails the customer
          "Sync Status": "Pending",
        },
      },
    ]);
    await pushNewShipment(shipmentRecord!.id);
    created.push({ shipmentRecordId: shipmentRecord!.id, vendorId, lineItemCount: group.length });
  }

  return { created };
}

export interface CreateLuxToCustomerShipmentResult {
  created: { shipmentRecordId: string; lineItemCount: number } | null;
}

/** Action 2: consolidate everything ready to ship FROM Lux TO the customer into one shipment. */
export async function createLuxToCustomerShipment(orderId: string): Promise<CreateLuxToCustomerShipmentResult> {
  const order = await airtable.find(ORDERS_TABLE, orderId);
  const lineItemIds = linkedIds(order.fields, "Line Items");
  if (lineItemIds.length === 0) return { created: null };

  const lineItems = await airtable.findByIds(LINE_ITEMS_TABLE, lineItemIds);
  const existingShipments = await airtable.findByIds(SHIPMENTS_TABLE, linkedIds(order.fields, "Shipments"));

  const alreadyShipped = new Set<string>();
  const receivedAtLux = new Set<string>();
  for (const shipment of existingShipments) {
    const liIds = linkedIds(shipment.fields, "Line Items");
    if (shipment.fields["Leg"] === "Lux to Customer") {
      for (const id of liIds) alreadyShipped.add(id);
    }
    if (shipment.fields["Leg"] === "Vendor to Lux" && shipment.fields["Received at Lux"] === true) {
      for (const id of liIds) receivedAtLux.add(id);
    }
  }

  const eligible = lineItems.filter((li) => {
    if (alreadyShipped.has(li.id)) return false;
    if (li.fields["Shipping Source"] === "Shipping From Me") return true;
    if (li.fields["Shipping Source"] === "Shipping From Vendor") return receivedAtLux.has(li.id);
    return false;
  });
  if (eligible.length === 0) return { created: null };

  const luxVendor = await airtable.findByField(WAREHOUSE_VENDORS_TABLE, "Name", LUX_VENDOR_NAME);
  if (!luxVendor) {
    throw new Error(
      `Warehouse Vendors record "${LUX_VENDOR_NAME}" not found — required as the ship-from for Lux-to-customer shipments`
    );
  }

  const [shipmentRecord] = await airtable.create(SHIPMENTS_TABLE, [
    {
      fields: {
        "Shipment Name": `${order.fields["Order Number"] ?? orderId} — Lux to Customer (${itemWord(eligible.length)})`,
        Order: [orderId],
        Vendor: [luxVendor.id],
        "Line Items": eligible.map((li) => li.id),
        Leg: "Lux to Customer",
        "Notify Customer": false, // opt-in only — staff must proactively check this before Shopify emails the customer
        "Sync Status": "Pending",
      },
    },
  ]);
  await pushNewShipment(shipmentRecord!.id);

  return { created: { shipmentRecordId: shipmentRecord!.id, lineItemCount: eligible.length } };
}
