import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AirtableRecord } from "../src/lib/airtable.js";

/**
 * Shopify fulfillment push job tests — Airtable client and the Shopify
 * fulfillment-order/fulfillment-creation calls are both mocked.
 */

vi.mock("../src/lib/airtable.js", () => ({
  fEscape: (s: string) => s.replace(/'/g, "\\'"),
  airtable: {
    find: vi.fn(),
    findByIds: vi.fn(),
    update: vi.fn(async () => undefined),
  },
}));

vi.mock("../src/connectors/shopify.js", () => ({
  listFulfillmentOrders: vi.fn(),
  createFulfillment: vi.fn(async () => ({ id: 555, status: "success" })),
}));

const { airtable } = await import("../src/lib/airtable.js");
const { listFulfillmentOrders, createFulfillment } = await import("../src/connectors/shopify.js");
const { pushShopifyFulfillments } = await import("../src/jobs/shopify-fulfillment.js");

const mocked = vi.mocked(airtable);
const mockedListFOs = vi.mocked(listFulfillmentOrders);
const mockedCreateFulfillment = vi.mocked(createFulfillment);

const record = (id: string, fields: Record<string, unknown>): AirtableRecord => ({
  id,
  createdTime: "2026-01-01T00:00:00.000Z",
  fields,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedCreateFulfillment.mockResolvedValue({ id: 555, status: "success" });
});

const orderRecord = (shipmentIds: string[]) =>
  record("recORDER1", { "Shopify Order ID": 123, Shipments: shipmentIds });

describe("pushShopifyFulfillments", () => {
  it("pushes only customer-facing legs, skipping Vendor to Lux", async () => {
    mocked.find.mockResolvedValue(orderRecord(["recSHIP1", "recSHIP2"]));
    mocked.findByIds.mockImplementation(async (table: string) => {
      if (table === "Shipments") {
        return [
          record("recSHIP1", { Leg: "Vendor to Lux", "Line Items": ["recLI1"] }),
          record("recSHIP2", {
            Leg: "Vendor to Customer",
            "Line Items": ["recLI2"],
            Carrier: "USPS",
            "Tracking Number": "9400",
            "Notify Customer": true,
          }),
        ];
      }
      if (table === "Line Items") {
        return [record("recLI2", { "Shopify Line Item ID": "10" })];
      }
      return [];
    });
    mockedListFOs.mockResolvedValue([
      { id: 999, order_id: 123, status: "open", line_items: [{ id: 1, line_item_id: 10, quantity: 1, fulfillable_quantity: 1 }] },
    ]);

    const result = await pushShopifyFulfillments("recORDER1");

    expect(result.pushed).toEqual([{ shipmentRecordId: "recSHIP2", shopifyFulfillmentId: 555 }]);
    expect(result.skipped).toEqual([]);
    expect(mockedCreateFulfillment).toHaveBeenCalledTimes(1);
    expect(mockedCreateFulfillment).toHaveBeenCalledWith(
      expect.objectContaining({
        trackingCompany: "USPS",
        trackingNumber: "9400",
        notifyCustomer: true,
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: 999, lineItems: [{ id: 1, quantity: 1 }] }],
      })
    );
    expect(mocked.update).toHaveBeenCalledWith("Shipments", [
      { id: "recSHIP2", fields: { "Shopify Fulfillment ID": "555" } },
    ]);
  });

  it("respects an unchecked Notify Customer — does not tell Shopify to email the customer", async () => {
    mocked.find.mockResolvedValue(orderRecord(["recSHIP1"]));
    mocked.findByIds.mockImplementation(async (table: string) => {
      if (table === "Shipments") {
        return [record("recSHIP1", { Leg: "Lux to Customer", "Line Items": ["recLI1"], "Notify Customer": false })];
      }
      if (table === "Line Items") return [record("recLI1", { "Shopify Line Item ID": "10" })];
      return [];
    });
    mockedListFOs.mockResolvedValue([
      { id: 999, order_id: 123, status: "open", line_items: [{ id: 1, line_item_id: 10, quantity: 1, fulfillable_quantity: 1 }] },
    ]);

    await pushShopifyFulfillments("recORDER1");

    expect(mockedCreateFulfillment).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer: false }));
  });

  it("skips a shipment that already has a Shopify Fulfillment ID (idempotency)", async () => {
    mocked.find.mockResolvedValue(orderRecord(["recSHIP1"]));
    mocked.findByIds.mockImplementation(async (table: string) =>
      table === "Shipments"
        ? [record("recSHIP1", { Leg: "Lux to Customer", "Shopify Fulfillment ID": "already-done" })]
        : []
    );

    const result = await pushShopifyFulfillments("recORDER1");

    expect(result.pushed).toEqual([]);
    expect(result.skipped).toEqual([{ shipmentRecordId: "recSHIP1", reason: "already pushed" }]);
    expect(mockedCreateFulfillment).not.toHaveBeenCalled();
  });

  it("skips a shipment when a line item can't be matched to a Shopify fulfillment order", async () => {
    mocked.find.mockResolvedValue(orderRecord(["recSHIP1"]));
    mocked.findByIds.mockImplementation(async (table: string) => {
      if (table === "Shipments") return [record("recSHIP1", { Leg: "Lux to Customer", "Line Items": ["recLI1"] })];
      if (table === "Line Items") return [record("recLI1", { "Shopify Line Item ID": "999999" })]; // no match below
      return [];
    });
    mockedListFOs.mockResolvedValue([
      { id: 999, order_id: 123, status: "open", line_items: [{ id: 1, line_item_id: 10, quantity: 1, fulfillable_quantity: 1 }] },
    ]);

    const result = await pushShopifyFulfillments("recORDER1");

    expect(result.pushed).toEqual([]);
    expect(result.skipped).toEqual([
      { shipmentRecordId: "recSHIP1", reason: "could not match all line items to a Shopify fulfillment order" },
    ]);
  });

  it("throws if the order has no Shopify Order ID", async () => {
    mocked.find.mockResolvedValue(record("recORDER1", { Shipments: [] }));
    await expect(pushShopifyFulfillments("recORDER1")).rejects.toThrow(/Shopify Order ID/);
  });

  it("returns empty results when there are no customer-facing shipments yet", async () => {
    mocked.find.mockResolvedValue(orderRecord(["recSHIP1"]));
    mocked.findByIds.mockImplementation(async (table: string) =>
      table === "Shipments" ? [record("recSHIP1", { Leg: "Vendor to Lux" })] : []
    );

    const result = await pushShopifyFulfillments("recORDER1");

    expect(result).toEqual({ pushed: [], skipped: [] });
    expect(mockedListFOs).not.toHaveBeenCalled();
  });
});
