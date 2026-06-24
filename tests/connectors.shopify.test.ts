import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidSignatureError } from "../src/connectors/types.js";

// shopifyRequest fetches an access token via getAccessToken before every
// call — mock it so listFulfillmentOrders/createFulfillment tests don't hit
// the real (Airtable-backed) token store.
vi.mock("../src/lib/oauth.js", () => ({
  getAccessToken: vi.fn(async () => "fake-access-token"),
}));

const {
  shopifyConnector,
  listFulfillmentOrders,
  createFulfillment,
  isValidShopDomain,
  verifyOAuthHmac,
  buildAuthorizeUrl,
  exchangeOAuthCode,
} = await import("../src/connectors/shopify.js");

/** Uses SHOPIFY_APP_CLIENT_SECRET from tests/setup.ts. */
const APP_CLIENT_SECRET = "shopify_client_secret_test_dummy";

function signedQuery(params: Record<string, string>) {
  const message = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  const hmac = createHmac("sha256", APP_CLIENT_SECRET).update(message).digest("hex");
  return { ...params, hmac };
}

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

describe("isValidShopDomain", () => {
  it("accepts a well-formed myshopify.com domain", () => {
    expect(isValidShopDomain("lux-lampshade.myshopify.com")).toBe(true);
  });

  it("rejects anything not ending in .myshopify.com (open-redirect guard)", () => {
    expect(isValidShopDomain("evil.com")).toBe(false);
    expect(isValidShopDomain("lux-lampshade.myshopify.com.evil.com")).toBe(false);
    expect(isValidShopDomain(undefined)).toBe(false);
    expect(isValidShopDomain("")).toBe(false);
  });
});

describe("verifyOAuthHmac", () => {
  it("accepts a correctly signed query (install ping shape)", () => {
    const query = signedQuery({ shop: "lux-lampshade.myshopify.com", timestamp: "1700000000" });
    expect(verifyOAuthHmac(query)).toBe(true);
  });

  it("accepts a correctly signed query (callback shape, includes code/state)", () => {
    const query = signedQuery({
      code: "abc123",
      shop: "lux-lampshade.myshopify.com",
      state: "xyz",
      timestamp: "1700000000",
    });
    expect(verifyOAuthHmac(query)).toBe(true);
  });

  it("rejects a tampered shop param", () => {
    const query = signedQuery({ shop: "lux-lampshade.myshopify.com", timestamp: "1700000000" });
    expect(verifyOAuthHmac({ ...query, shop: "evil.myshopify.com" })).toBe(false);
  });

  it("rejects a missing hmac", () => {
    expect(verifyOAuthHmac({ shop: "lux-lampshade.myshopify.com" })).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("builds the per-shop authorize URL with client_id, scope, redirect_uri, and state", () => {
    const url = new URL(
      buildAuthorizeUrl("lux-lampshade.myshopify.com", "https://example.com/oauth/shopify/callback", "state123")
    );
    expect(url.origin + url.pathname).toBe("https://lux-lampshade.myshopify.com/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe("shopify_client_id_test_dummy");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.com/oauth/shopify/callback");
    expect(url.searchParams.get("state")).toBe("state123");
    expect(url.searchParams.get("scope")).toContain("read_orders");
  });
});

describe("exchangeOAuthCode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs form-encoded client_id/client_secret/code and returns the access token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "shpat_real_token" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const token = await exchangeOAuthCode("lux-lampshade.myshopify.com", "auth_code_123");

    expect(token).toBe("shpat_real_token");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://lux-lampshade.myshopify.com/admin/oauth/access_token");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    const body = new URLSearchParams(init!.body as string);
    expect(body.get("client_id")).toBe("shopify_client_id_test_dummy");
    expect(body.get("client_secret")).toBe(APP_CLIENT_SECRET);
    expect(body.get("code")).toBe("auth_code_123");
  });
});
