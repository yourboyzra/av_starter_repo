import type { Fields } from "../lib/airtable.js";
import type { ExternalRecord, ProviderSpecs } from "../connectors/types.js";
import type { ShopifyAddress, ShopifyLineItemWithOrder, ShopifyOrder } from "../connectors/shopify.js";

/**
 * Shopify mapping specs — pure functions, payload in -> fields out.
 *
 * PRODUCTION RULE (CLAUDE.md): replace field NAMES below with field IDs
 * before a client deploy. Names are used here only for template readability.
 *
 * Field-direction policy: Shopify is the source of truth for order/line-item
 * data — both specs are inbound-only (no mapOut). Operational fields owned
 * by staff (Internal Status, Vendor, Ship Date, Material*, Style/Fitting/etc.
 * filled in via the customer's Railway form) are never touched here.
 */

const FINANCIAL_STATUS: Record<string, string> = {
  pending: "Pending",
  authorized: "Authorized",
  paid: "Paid",
  partially_paid: "Partially Paid",
  refunded: "Refunded",
  partially_refunded: "Partially Refunded",
  voided: "Voided",
};

const FULFILLMENT_STATUS: Record<string, string> = {
  fulfilled: "Fulfilled",
  partial: "Partial",
  restocked: "Restocked",
};

function fullName(first?: string | null, last?: string | null): string {
  return [first, last].filter(Boolean).join(" ");
}

function formatAddress(addr?: ShopifyAddress | null): string {
  if (!addr) return "";
  const name = addr.name ?? fullName(addr.first_name, addr.last_name);
  const cityLine = [addr.city, addr.province_code ?? addr.province, addr.zip].filter(Boolean).join(", ");
  return [name, addr.address1, addr.address2, cityLine, addr.country]
    .filter((line) => line && line.trim())
    .join("\n");
}

function formatProperties(props?: { name: string; value: string }[]): string {
  if (!props || props.length === 0) return "";
  return props.map((p) => `${p.name}: ${p.value}`).join("\n");
}

export const shopifySpecs: ProviderSpecs = {
  order: {
    table: "Orders",
    idField: "Shopify Order ID", // number field — Airtable's formula matching coerces this fine
    syncedAtField: "Synced At",
    statusField: "Sync Status",
    errorField: "Sync Error",

    mapIn(rec: ExternalRecord): Fields {
      const o = rec.raw as ShopifyOrder;
      const ship = o.shipping_address;
      const customerName =
        fullName(o.customer?.first_name, o.customer?.last_name) ||
        ship?.name ||
        fullName(ship?.first_name, ship?.last_name);

      return {
        "Order Number": o.name ?? String(o.order_number ?? o.id),
        "Order Notes": o.note ?? "",
        "Shopify Order ID": o.id,
        "Order Date": o.created_at,
        "Customer Name": customerName,
        "Customer Email": o.email ?? o.customer?.email ?? "",
        "Customer Phone": o.phone ?? o.customer?.phone ?? ship?.phone ?? "",
        "Order Value": Number.parseFloat(o.total_price ?? "0"),
        Currency: o.currency ?? "",
        "Financial Status": o.financial_status ? FINANCIAL_STATUS[o.financial_status] ?? "" : "",
        "Fulfillment Status": o.fulfillment_status ? FULFILLMENT_STATUS[o.fulfillment_status] ?? "" : "Unfulfilled",
        "Shipping Address": formatAddress(ship),
        "Billing Address": formatAddress(o.billing_address),
        "Ship To Name": ship?.name ?? customerName,
        "Ship To Phone": ship?.phone ?? "",
        "Ship To Address Line 1": ship?.address1 ?? "",
        "Ship To Address Line 2": ship?.address2 ?? "",
        "Ship To City": ship?.city ?? "",
        "Ship To State": ship?.province_code ?? ship?.province ?? "",
        "Ship To Zip": ship?.zip ?? "",
        "Ship To Country": ship?.country_code ?? "",
      };
    },
  },

  line_item: {
    table: "Line Items",
    idField: "Shopify Line Item ID",
    syncedAtField: "Synced At",
    statusField: "Sync Status",
    errorField: "Sync Error",

    // "Shopify Order ID" here is a plain text join key for a native Airtable
    // automation to resolve into the real `Order` linked-record field — see
    // the connector's header comment for why that can't be done here.
    mapIn(rec: ExternalRecord): Fields {
      const li = rec.raw as ShopifyLineItemWithOrder;
      const quantity = li.quantity ?? 0;
      const unitPrice = Number.parseFloat(li.price ?? "0");

      return {
        "Line Item": li.title ?? li.name ?? "",
        "Variant / Description": li.variant_title ?? li.sku ?? "",
        Quantity: quantity,
        "Unit Price": unitPrice,
        "Line Total": Math.round(unitPrice * quantity * 100) / 100,
        "Custom Order Details": formatProperties(li.properties),
        "Shopify Line Item ID": String(li.id),
        "Shopify Order ID": String(li.order_id),
      };
    },
  },
};
