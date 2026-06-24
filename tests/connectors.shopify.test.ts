import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shopifyConnector, listFulfillmentOrders, createFulfillment } from "../src/connectors/shopify.js";
import { InvalidSignatureError } from "../src/connectors/types.js";

/** Uses SHOPIFY_WEBHOOK_SECRET from tests/setup.ts ("whsec_shopify_testsecret"). */
const SECRET = "whsec_shopify_testsecret";

function signedOrder(order: Record<string, unknown>) {
  const body = JSON.stringify(order);
  const signature = createHmac("sha256", SECRET).update(body).digest("base64");
  return { body, signature };
}

describe("shopifyConnector.parseWebhook", () => {
  it("accepts a correctly signed order and normalizes order + line items", async () => {
    const { body, signature } = signedOrder({
      id: 123,
      updated_at: "2026-01-01T00:00:00Z",
      line_items: [{ id: 1, quantity: 1 }, { id: 2, quantity: 1 }],
    });

    const event = await shopifyConnector.parseWebhook(body, {
      "x-shopify-hmac-sha256": signature,
      "x-shopify-webhook-id": "whk_test_1",
    });

    expect(event.eventId).toBe("whk_test_1");
    expect(event.records).toHaveLength(3); // 1 order + 2 line items
    expect(event.records[0]!.entity).toBe("order");
    expect(event.records[0]!.externalId).toBe("123");
    expect(event.records[1]!.entity).toBe("line_item");
    expect((event.records[1]!.raw as { order_id: number }).order_id).toBe(123);
  });

  it("rejects a tampered body", async () => {
    const { body, signature } = signedOrder({ id: 123, updated_at: "2026-01-01T00:00:00Z" });
    const tampered = body.replace('"id":123', '"id":999');

    await expect(
      shopifyConnector.parseWebhook(tampered, {
        "x-shopify-hmac-sha256": signature,
        "x-shopify-webhook-id": "whk_test_2",
      })
    ).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("rejects a missing signature header", async () => {
    const { body } = signedOrder({ id: 123, updated_at: "2026-01-01T00:00:00Z" });
    await expect(
      shopifyConnector.parseWebhook(body, { "x-shopify-webhook-id": "whk_test_3" })
    ).rejects.toBeInstanceOf(InvalidSignatureError);
  });

  it("throws if X-Shopify-Webhook-Id is missing even with a valid signature", async () => {
    const { body, signature } = signedOrder({ id: 123, updated_at: "2026-01-01T00:00:00Z" });
    await expect(
      shopifyConnector.parseWebhook(body, { "x-shopify-hmac-sha256": signature })
    ).rejects.toThrow("Missing X-Shopify-Webhook-Id");
  });
});

describe("shopifyConnector.push", () => {
  it("is not supported — Shopify orders are inbound-only", async () => {
    await expect(shopifyConnector.push("order", null, {})).rejects.toThrow(/inbound-only/);
  });
});

describe("listFulfillmentOrders", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches and returns the fulfillment orders for a Shopify order", async () => {
    const fakeResponse = {
      fulfillment_orders: [
        { id: 999, order_id: 123, status: "open", line_items: [{ id: 1, line_item_id: 10, quantity: 2, fulfillable_quantity: 2 }] },
      ],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fakeResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await listFulfillmentOrders(123);

    expect(result).toEqual(fakeResponse.fulfillment_orders);
    const [url] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/orders/123/fulfillment_orders.json");
  });
});

describe("createFulfillment", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the fulfillment_order_id-based payload with tracking info", async () => {
    const fakeResponse = { fulfillment: { id: 555, status: "success" } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(fakeResponse), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createFulfillment({
      lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 999, lineItems: [{ id: 1, quantity: 2 }] }],
      trackingCompany: "USPS",
      trackingNumber: "9400123456",
      notifyCustomer: true,
    });

    expect(result).toEqual({ id: 555, status: "success" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/fulfillments.json");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init!.body as string);
    expect(body.fulfillment.line_items_by_fulfillment_order).toEqual([
      { fulfillment_order_id: 999, fulfillment_order_line_items: [{ id: 1, quantity: 2 }] },
    ]);
    expect(body.fulfillment.tracking_info).toEqual({ company: "USPS", number: "9400123456" });
    expect(body.fulfillment.notify_customer).toBe(true);
  });
});
