import { requireEnv } from "../config.js";
import { verifyHmacBase64PlainSecret } from "../lib/verify.js";
import {
  InvalidSignatureError,
  NotSupportedError,
  type Connector,
  type ExternalRecord,
  type WebhookEvent,
} from "./types.js";

/**
 * Shopify adapter — custom-app Admin API access token (no OAuth dance),
 * REST Admin API. Inbound-only: Shopify is the source of truth for orders,
 * so push() always throws — nothing in this project writes orders back.
 *
 * Quirks:
 * - REST Admin API is "legacy" per Shopify's own docs, but still supported
 *   for custom (single-store) apps — only *new public* apps are forced onto
 *   GraphQL. Fine here since this is a custom app for one store.
 * - Line items have no `updated_at` of their own (they inherit the parent
 *   order's) and no back-reference to their order in the payload — order_id
 *   is injected here during flattening.
 * - The Orders<->Line Items link in Airtable is a plain `Shopify Order ID`
 *   text field on Line Items, joined by a native Airtable automation — NOT
 *   resolved in code, because nothing guarantees an order's Airtable record
 *   exists yet when its line items are processed (webhook delivery order
 *   isn't guaranteed, and reconciliation runs the two entities independently).
 */

function baseUrl(): string {
  return `https://${requireEnv("SHOPIFY_STORE_DOMAIN")}/admin/api/${requireEnv("SHOPIFY_API_VERSION")}`;
}

/** Shopify paginates via a `Link: <url>; rel="next"` response header. */
function parseNextLink(linkHeader: string | null): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const m = part.match(/<([^>]+)>;\s*rel="next"/);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

async function shopifyRequest<T>(
  url: string,
  init?: { method?: "GET" | "POST"; body?: unknown }
): Promise<{ body: T; nextUrl?: string }> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      "X-Shopify-Access-Token": requireEnv("SHOPIFY_ACCESS_TOKEN"),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) throw new Error(`Shopify ${res.status} ${url}: ${await res.text()}`);
  const body = (await res.json()) as T;
  return { body, nextUrl: parseNextLink(res.headers.get("link")) };
}

export interface ShopifyAddress {
  name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  phone?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  zip?: string | null;
  country?: string | null;
  country_code?: string | null;
}

export interface ShopifyLineItem {
  id: number;
  title?: string | null;
  name?: string | null;
  variant_title?: string | null;
  sku?: string | null;
  quantity: number;
  price?: string | null;
  properties?: { name: string; value: string }[];
}

/** order_id injected since Shopify line items don't reference their parent. */
export type ShopifyLineItemWithOrder = ShopifyLineItem & { order_id: number };

export interface ShopifyOrder {
  id: number;
  name?: string | null;
  order_number?: number;
  email?: string | null;
  phone?: string | null;
  created_at: string;
  updated_at: string;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  total_price?: string | null;
  currency?: string | null;
  note?: string | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
  } | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  line_items?: ShopifyLineItem[];
}

async function listOrdersSince(since: string): Promise<ShopifyOrder[]> {
  const out: ShopifyOrder[] = [];
  let url: string | undefined =
    `${baseUrl()}/orders.json?status=any&limit=250&updated_at_min=${encodeURIComponent(since)}`;
  while (url) {
    const result: { body: { orders: ShopifyOrder[] }; nextUrl?: string } = await shopifyRequest(url);
    out.push(...result.body.orders);
    url = result.nextUrl;
  }
  return out;
}

function normalizeOrder(order: ShopifyOrder): ExternalRecord {
  return {
    externalId: String(order.id),
    entity: "order",
    updatedAt: order.updated_at,
    raw: order,
  };
}

function normalizeLineItems(order: ShopifyOrder): ExternalRecord[] {
  return (order.line_items ?? []).map((li) => ({
    externalId: String(li.id),
    entity: "line_item",
    updatedAt: order.updated_at, // line items have no timestamp of their own
    raw: { ...li, order_id: order.id } satisfies ShopifyLineItemWithOrder,
  }));
}

const ENTITIES = new Set(["order", "line_item"]);

export interface ShopifyFulfillmentOrderLineItem {
  id: number;
  line_item_id: number;
  quantity: number;
  fulfillable_quantity: number;
}

export interface ShopifyFulfillmentOrder {
  id: number;
  order_id: number;
  status: string;
  line_items: ShopifyFulfillmentOrderLineItem[];
}

/**
 * List the fulfillment orders for a Shopify order. Required before creating
 * a fulfillment — the current Admin API is fulfillment_order_id-based, not
 * order_id-based, so this is how we map our line items to the IDs Shopify's
 * fulfillment-creation endpoint actually wants.
 */
export async function listFulfillmentOrders(shopifyOrderId: number | string): Promise<ShopifyFulfillmentOrder[]> {
  const { body } = await shopifyRequest<{ fulfillment_orders: ShopifyFulfillmentOrder[] }>(
    `${baseUrl()}/orders/${shopifyOrderId}/fulfillment_orders.json`
  );
  return body.fulfillment_orders;
}

export interface CreateFulfillmentInput {
  lineItemsByFulfillmentOrder: { fulfillmentOrderId: number; lineItems: { id: number; quantity: number }[] }[];
  trackingCompany?: string;
  trackingNumber?: string;
  notifyCustomer: boolean;
  message?: string;
}

export interface ShopifyFulfillment {
  id: number;
  status: string;
}

/** Create a fulfillment — this is what triggers Shopify's "your order has shipped" customer email. */
export async function createFulfillment(input: CreateFulfillmentInput): Promise<ShopifyFulfillment> {
  const { body } = await shopifyRequest<{ fulfillment: ShopifyFulfillment }>(`${baseUrl()}/fulfillments.json`, {
    method: "POST",
    body: {
      fulfillment: {
        line_items_by_fulfillment_order: input.lineItemsByFulfillmentOrder.map((g) => ({
          fulfillment_order_id: g.fulfillmentOrderId,
          fulfillment_order_line_items: g.lineItems.map((li) => ({ id: li.id, quantity: li.quantity })),
        })),
        ...(input.trackingCompany || input.trackingNumber
          ? { tracking_info: { company: input.trackingCompany, number: input.trackingNumber } }
          : {}),
        notify_customer: input.notifyCustomer,
        ...(input.message ? { message: input.message } : {}),
      },
    },
  });
  return body.fulfillment;
}

export const shopifyConnector: Connector = {
  name: "shopify",

  /**
   * Both entities list orders via the same endpoint (line items are nested,
   * not separately queryable) — fetching twice per reconciliation pass is a
   * deliberate, small inefficiency to keep this connector generic rather
   * than special-casing the shared engine for one provider.
   */
  async pullChanges(entity, since) {
    if (!ENTITIES.has(entity)) throw new NotSupportedError(`entity ${entity}`);
    const orders = await listOrdersSince(since);
    return entity === "order" ? orders.map(normalizeOrder) : orders.flatMap(normalizeLineItems);
  },

  /** Shopify orders are inbound-only — Airtable never pushes order changes back. */
  async push(entity): Promise<string> {
    throw new NotSupportedError(`push for entity ${entity} — Shopify orders are inbound-only`);
  },

  /**
   * Verify X-Shopify-Hmac-Sha256 (base64 HMAC-SHA256 over the raw body),
   * dedupe by X-Shopify-Webhook-Id. The body IS the order resource directly
   * (no envelope, unlike Stripe's {id, type, data: {object}} shape).
   */
  async parseWebhook(rawBody, headers): Promise<WebhookEvent> {
    const sig = headers["x-shopify-hmac-sha256"] ?? "";
    if (!verifyHmacBase64PlainSecret(rawBody, sig, requireEnv("SHOPIFY_WEBHOOK_SECRET"))) {
      throw new InvalidSignatureError();
    }
    const eventId = headers["x-shopify-webhook-id"];
    if (!eventId) throw new Error("Missing X-Shopify-Webhook-Id header");

    const order = JSON.parse(rawBody) as ShopifyOrder;
    return { eventId, records: [normalizeOrder(order), ...normalizeLineItems(order)] };
  },
};
